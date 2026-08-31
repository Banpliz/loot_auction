import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';
import { computeIconSignature, isGenericChestIcon } from '../dedup';
import { rememberLot } from '../lot-library';
import { winLimitGroup } from './events';

const VALID_COLORS = new Set(['blue', 'purple', 'red']);
const VALID_CATEGORIES = new Set(['item', 'stone']);

// Editing (name/color/category/quantity, remove, merge) is only allowed while the event
// is still in draft. Once it's open, users may already be looking at (or claiming) these
// exact lots, so admin edits are locked to avoid changing what someone already claimed
// out from under them — see docs/superpowers/specs/2026-08-31-fcfs-reservation-design.md.
export function isEventDraft(deps: AppDeps, eventId: number): boolean {
  const event = deps.db.prepare('SELECT status FROM events WHERE id = ?').get(eventId) as { status: string } | undefined;
  return event?.status === 'draft';
}

function itemEventId(deps: AppDeps, itemId: number): number | undefined {
  const row = deps.db.prepare('SELECT event_id FROM items WHERE id = ?').get(itemId) as { event_id: number } | undefined;
  return row?.event_id;
}

// Once bidding closes, nothing about a claim should be changeable — not just no new
// bids, but no withdrawing one either, so a bidder can't dodge a win-limit group by
// pulling out right before the draw. Shared by both claim and unclaim below.
function isPastDeadline(deps: AppDeps, eventId: number): boolean {
  const event = deps.db.prepare('SELECT deadline_at FROM events WHERE id = ?').get(eventId) as
    | { deadline_at: string | null }
    | undefined;
  return !!event?.deadline_at && new Date(event.deadline_at).getTime() < Date.now();
}

// Tallies this user's current claims for the event by win-limit-group key (see
// winLimitGroup in events.ts) — the live, per-attempt equivalent of the counter the old
// end-of-event draw used to build once over the whole claimant pool.
function getUserGroupCounts(deps: AppDeps, eventId: number, userId: number): Map<string, number> {
  const rows = deps.db
    .prepare(
      `SELECT i.color, i.category, s.template
       FROM claims c
       JOIN items i ON i.id = c.item_id
       JOIN screenshots s ON s.id = i.screenshot_id
       WHERE i.event_id = ? AND c.telegram_id = ?`
    )
    .all(eventId, userId) as { color: string; category: string; template: string }[];

  const counts = new Map<string, number>();
  for (const row of rows) {
    const { key } = winLimitGroup(row.template, row.color, row.category);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function registerItemRoutes(app: FastifyInstance, deps: AppDeps) {
  app.put<{ Params: { id: string }; Body: { name?: string; color?: string; category?: string; quantity?: number } }>(
    '/items/:id',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const itemId = Number(request.params.id);
      const eventId = itemEventId(deps, itemId);
      if (eventId === undefined || !isEventDraft(deps, eventId)) {
        reply.code(409).send({ error: 'event is not in draft' });
        return;
      }

      const { name, color, category, quantity } = request.body ?? {};
      if (name === undefined && color === undefined && category === undefined && quantity === undefined) {
        reply.code(400).send({ error: 'at least one of name, color, category, quantity is required' });
        return;
      }
      if (color !== undefined && !VALID_COLORS.has(color)) {
        reply.code(400).send({ error: 'color must be blue, purple, or red' });
        return;
      }
      if (category !== undefined && !VALID_CATEGORIES.has(category)) {
        reply.code(400).send({ error: 'category must be item or stone' });
        return;
      }
      if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1)) {
        reply.code(400).send({ error: 'quantity must be a positive integer' });
        return;
      }

      const updates: string[] = [];
      const values: unknown[] = [];

      if (name !== undefined) {
        updates.push('name = ?');
        values.push(name.trim());
      }
      if (color !== undefined) {
        updates.push('color = ?');
        values.push(color);
      }
      if (category !== undefined) {
        updates.push('category = ?');
        values.push(category);
      }
      if (quantity !== undefined) {
        updates.push('quantity = ?');
        values.push(quantity);
      }

      values.push(itemId);
      deps.db.prepare(`UPDATE items SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      // Remember this icon's name/category for next time (the whole point of the
      // library — see lot-library.ts) whenever the admin actually set one of them.
      // A generic chest icon is excluded, same reasoning as screenshots.ts: it looks
      // identical across genuinely different chests, so "remembering" it would just
      // stamp the wrong name/category onto some future unrelated chest lot.
      if (name !== undefined || category !== undefined) {
        const row = deps.db.prepare('SELECT name, category, image_path as imagePath FROM items WHERE id = ?').get(itemId) as
          | { name: string; category: string; imagePath: string }
          | undefined;
        if (row) {
          try {
            const signature = await computeIconSignature(path.join(deps.dataDir, 'uploads', row.imagePath));
            if (!isGenericChestIcon(signature)) {
              rememberLot(deps.db, signature, row.name, row.category);
            }
          } catch (err) {
            request.log.warn({ err }, 'lot-library: failed to read icon, skipping remember');
          }
        }
      }

      return { ok: true };
    }
  );

  app.delete<{ Params: { id: string } }>('/items/:id', { preHandler: requireAdmin(deps) }, async (request, reply) => {
    const itemId = Number(request.params.id);
    const eventId = itemEventId(deps, itemId);
    if (eventId === undefined || !isEventDraft(deps, eventId)) {
      reply.code(409).send({ error: 'event is not in draft' });
      return;
    }
    deps.db.prepare("UPDATE items SET status = 'removed' WHERE id = ?").run(itemId);
    return { ok: true };
  });

  // Manual escape hatch for icon-dedup misses across separate screenshot uploads
  // (see dedup.ts) — admin folds a duplicate lot into another by hand instead of
  // relying on the pixel-signature threshold, which can't reliably tell "same
  // item, different photo" from "different item" at the margin observed in
  // practice. Draft-only (see isEventDraft) — and since claiming requires an open
  // event, a draft-time lot can never already have claimants, so merging never
  // needs to carry bids over the way it used to.
  app.post<{ Params: { id: string }; Body: { intoId?: number } }>(
    '/items/:id/merge',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const sourceId = Number(request.params.id);
      const targetId = Number(request.body?.intoId);
      if (!Number.isInteger(targetId)) {
        reply.code(400).send({ error: 'intoId is required' });
        return;
      }
      if (sourceId === targetId) {
        reply.code(400).send({ error: 'cannot merge an item into itself' });
        return;
      }

      const source = deps.db.prepare('SELECT event_id, status, quantity FROM items WHERE id = ?').get(sourceId) as
        | { event_id: number; status: string; quantity: number }
        | undefined;
      const target = deps.db.prepare('SELECT event_id, status FROM items WHERE id = ?').get(targetId) as
        | { event_id: number; status: string }
        | undefined;
      if (!source || !target) {
        reply.code(404).send({ error: 'item not found' });
        return;
      }
      if (source.event_id !== target.event_id) {
        reply.code(400).send({ error: 'items belong to different events' });
        return;
      }
      if (!isEventDraft(deps, source.event_id)) {
        reply.code(409).send({ error: 'event is not in draft' });
        return;
      }
      if (source.status !== 'pool' || target.status !== 'pool') {
        reply.code(409).send({ error: 'both lots must still be in the pool' });
        return;
      }

      deps.db.prepare('UPDATE items SET quantity = quantity + ? WHERE id = ?').run(source.quantity, targetId);
      deps.db.prepare("UPDATE items SET status = 'removed' WHERE id = ?").run(sourceId);

      return { ok: true };
    }
  );

  app.post<{ Params: { id: string } }>('/items/:id/claim', async (request, reply) => {
    const itemId = Number(request.params.id);
    const userId = request.telegramUser!.telegramId;

    const item = deps.db
      .prepare(
        `SELECT i.status, i.event_id, i.quantity, i.color, i.category, s.template
         FROM items i JOIN screenshots s ON s.id = i.screenshot_id
         WHERE i.id = ?`
      )
      .get(itemId) as
      | { status: string; event_id: number; quantity: number; color: string; category: string; template: string }
      | undefined;
    if (!item || item.status !== 'pool') {
      reply.code(409).send({ error: 'item is not claimable' });
      return;
    }

    const event = deps.db.prepare('SELECT status FROM events WHERE id = ?').get(item.event_id) as
      | { status: string }
      | undefined;
    if (!event || event.status !== 'open') {
      reply.code(409).send({ error: 'auction is not open' });
      return;
    }
    // The UI hides the bid button once the countdown runs out, but only enforcing it
    // there means a request sent straight to the API (or a stale page left open past
    // the deadline) can still place a bid — the deadline has to be checked server-side
    // to actually mean anything.
    if (isPastDeadline(deps, item.event_id)) {
      reply.code(409).send({ error: 'bidding has ended' });
      return;
    }

    const already = deps.db.prepare('SELECT 1 FROM claims WHERE item_id = ? AND telegram_id = ?').get(itemId, userId);
    if (already) {
      reply.code(409).send({ error: 'already claimed' });
      return;
    }

    const { key, limit, exclusiveWith } = winLimitGroup(item.template, item.color, item.category);
    const counts = getUserGroupCounts(deps, item.event_id, userId);
    if ((counts.get(key) ?? 0) >= limit) {
      reply.code(409).send({ error: 'win limit reached' });
      return;
    }
    if (exclusiveWith && (counts.get(exclusiveWith) ?? 0) > 0) {
      reply.code(409).send({ error: 'already won in the other category' });
      return;
    }

    // Claiming a lot immediately reserves one unit of it — first come, first served —
    // instead of just registering interest for a later random draw.
    deps.db.prepare('INSERT INTO claims (item_id, telegram_id) VALUES (?, ?)').run(itemId, userId);
    const remaining = item.quantity - 1;
    deps.db
      .prepare('UPDATE items SET quantity = ?, status = ? WHERE id = ?')
      .run(remaining, remaining <= 0 ? 'auctioned' : 'pool', itemId);

    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/items/:id/claim', async (request, reply) => {
    const itemId = Number(request.params.id);
    const userId = request.telegramUser!.telegramId;

    const item = deps.db.prepare('SELECT event_id FROM items WHERE id = ?').get(itemId) as { event_id: number } | undefined;
    if (item) {
      const event = deps.db.prepare('SELECT status FROM events WHERE id = ?').get(item.event_id) as
        | { status: string }
        | undefined;
      if (event?.status !== 'open' || isPastDeadline(deps, item.event_id)) {
        reply.code(409).send({ error: 'bidding has ended' });
        return;
      }
    }

    const result = deps.db.prepare('DELETE FROM claims WHERE item_id = ? AND telegram_id = ?').run(itemId, userId);
    if (result.changes > 0 && item) {
      // Giving the unit back always returns the lot to 'pool', even if claiming it was
      // what had taken it to 'auctioned' (sold out) — the quantity math is symmetric.
      deps.db.prepare("UPDATE items SET quantity = quantity + 1, status = 'pool' WHERE id = ?").run(itemId);
    }
    return { ok: true };
  });
}
