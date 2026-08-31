import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';
import { computeIconSignature, isGenericChestIcon } from '../dedup';
import { rememberLot } from '../lot-library';

const VALID_COLORS = new Set(['blue', 'purple', 'red']);
const VALID_CATEGORIES = new Set(['item', 'stone']);

// Once bidding closes, nothing about a claim should be changeable — not just no new
// bids, but no withdrawing one either, so a bidder can't dodge a win-limit group by
// pulling out right before the draw. Shared by both claim and unclaim below.
function isPastDeadline(deps: AppDeps, eventId: number): boolean {
  const event = deps.db.prepare('SELECT deadline_at FROM events WHERE id = ?').get(eventId) as
    | { deadline_at: string | null }
    | undefined;
  return !!event?.deadline_at && new Date(event.deadline_at).getTime() < Date.now();
}

export function registerItemRoutes(app: FastifyInstance, deps: AppDeps) {
  app.put<{ Params: { id: string }; Body: { name?: string; color?: string; category?: string; quantity?: number } }>(
    '/items/:id',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
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

      const itemId = Number(request.params.id);
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

  app.delete<{ Params: { id: string } }>('/items/:id', { preHandler: requireAdmin(deps) }, async (request) => {
    deps.db.prepare("UPDATE items SET status = 'removed' WHERE id = ?").run(Number(request.params.id));
    return { ok: true };
  });

  // Manual escape hatch for icon-dedup misses across separate screenshot uploads
  // (see dedup.ts) — admin folds a duplicate lot into another by hand instead of
  // relying on the pixel-signature threshold, which can't reliably tell "same
  // item, different photo" from "different item" at the margin observed in
  // practice. Source's bidders carry over (deduped, a claimant on both keeps
  // one bid) and it's soft-removed rather than merging its own quantity twice.
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
      if (source.status !== 'pool' || target.status !== 'pool') {
        reply.code(409).send({ error: 'both lots must still be in the pool' });
        return;
      }

      const mergeItems = deps.db.transaction(() => {
        deps.db
          .prepare('INSERT OR IGNORE INTO claims (item_id, telegram_id) SELECT ?, telegram_id FROM claims WHERE item_id = ?')
          .run(targetId, sourceId);
        deps.db.prepare('DELETE FROM claims WHERE item_id = ?').run(sourceId);
        deps.db.prepare('UPDATE items SET quantity = quantity + ? WHERE id = ?').run(source.quantity, targetId);
        deps.db.prepare("UPDATE items SET status = 'removed' WHERE id = ?").run(sourceId);
      });
      mergeItems();

      return { ok: true };
    }
  );

  app.post<{ Params: { id: string } }>('/items/:id/claim', async (request, reply) => {
    const itemId = Number(request.params.id);
    const userId = request.telegramUser!.telegramId;

    const item = deps.db.prepare('SELECT status, event_id FROM items WHERE id = ?').get(itemId) as
      | { status: string; event_id: number }
      | undefined;
    if (!item || item.status !== 'pool') {
      reply.code(409).send({ error: 'item is not claimable' });
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

    deps.db.prepare('INSERT OR IGNORE INTO claims (item_id, telegram_id) VALUES (?, ?)').run(itemId, userId);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/items/:id/claim', async (request, reply) => {
    const itemId = Number(request.params.id);
    const userId = request.telegramUser!.telegramId;

    const item = deps.db.prepare('SELECT event_id FROM items WHERE id = ?').get(itemId) as { event_id: number } | undefined;
    if (item && isPastDeadline(deps, item.event_id)) {
      reply.code(409).send({ error: 'bidding has ended' });
      return;
    }

    deps.db.prepare('DELETE FROM claims WHERE item_id = ? AND telegram_id = ?').run(itemId, userId);
    return { ok: true };
  });
}
