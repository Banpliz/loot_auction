import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';
import { computeIconSignature, isGenericChestIcon } from '../dedup';
import { rememberLot } from '../lot-library';
import { winLimitGroup } from './events';
import { isTemplate } from '../layout-templates';
import { publishChange } from '../pubsub';
import { INVASION_CATALOG } from '../invasion-catalog';

const VALID_COLORS = new Set(['blue', 'purple', 'red']);
const VALID_CATEGORIES = new Set(['item', 'stone_temper', 'stone_remelt']);
// Same value set as users.class — see the claim handler below and web/format.ts's CLASSES.
const VALID_CLASSES = new Set(['tank', 'rogue', 'mage', 'healer', 'hunter']);

// A manual lot has no real screenshot to crop an icon from, so every manual lot across
// every event shares this one generated placeholder — the admin-entered comment/color is
// what actually distinguishes them, not the icon.
const MANUAL_PLACEHOLDER_IMAGE_PATH = 'items/manual-placeholder.png';
const MANUAL_PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
  <rect width="96" height="96" rx="14" fill="#3a3530"/>
  <text x="48" y="64" font-family="sans-serif" font-size="46" font-weight="700" fill="#a89f92" text-anchor="middle">?</text>
</svg>`;

async function ensureManualPlaceholderImage(deps: AppDeps): Promise<void> {
  const itemsDir = path.join(deps.dataDir, 'uploads', 'items');
  const filePath = path.join(itemsDir, 'manual-placeholder.png');
  await fs.mkdir(itemsDir, { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    const png = await sharp(Buffer.from(MANUAL_PLACEHOLDER_SVG)).png().toBuffer();
    await fs.writeFile(filePath, png);
  }
}

// Real, hand-curated icons for the invasion template (see invasion-catalog.ts) — bundled
// in the repo under assets/, copied into this event's uploads dir the same lazy,
// copy-once way the manual-lot placeholder is, so they're servable through the existing
// /uploads/ static route without a route of their own.
function invasionCatalogImagePath(slug: string): string {
  return `items/invasion-catalog-${slug}.png`;
}

async function ensureInvasionCatalogImage(deps: AppDeps, slug: string): Promise<void> {
  const itemsDir = path.join(deps.dataDir, 'uploads', 'items');
  const destPath = path.join(itemsDir, `invasion-catalog-${slug}.png`);
  await fs.mkdir(itemsDir, { recursive: true });
  try {
    await fs.access(destPath);
  } catch {
    const srcPath = path.join(process.cwd(), 'assets', 'invasion-catalog', `${slug}.png`);
    await fs.copyFile(srcPath, destPath);
  }
}

// One synthetic screenshot row per event backs every manual lot in it (screenshot_id is
// NOT NULL on items — see db.ts). Its template decides which win-limit rule winLimitGroup
// (events.ts) applies to every manual lot in the event — feast groups by category, invasion
// caps blue at 2 — so getting it wrong silently breaks the cap a participant expects (e.g.
// a blue manual lot that can't actually be claimed 2-at-a-time). Priority: an event that
// already has a real screenshot keeps that one's template, so manual lots never disagree
// with the rest of the event; otherwise the admin's own choice on this call; otherwise
// whatever a previous manual lot in this event already picked; 'feast' only as a last resort.
function getOrCreateManualScreenshot(deps: AppDeps, eventId: number, userId: number, requestedTemplate: string): number {
  const existingManual = deps.db
    .prepare("SELECT id FROM screenshots WHERE event_id = ? AND original_path = 'manual'")
    .get(eventId) as { id: number } | undefined;
  if (existingManual) return existingManual.id;

  const real = deps.db
    .prepare("SELECT template FROM screenshots WHERE event_id = ? AND original_path != 'manual' LIMIT 1")
    .get(eventId) as { template: string } | undefined;

  return deps.db
    .prepare("INSERT INTO screenshots (event_id, original_path, rows, template, uploaded_by) VALUES (?, 'manual', 0, ?, ?)")
    .run(eventId, real?.template ?? requestedTemplate, userId).lastInsertRowid as number;
}

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

// The short synchronized countdown events.ts's /start sets (starts_at) — an event can be
// 'open' yet still be in that countdown, so the UI showing "starts in N..." isn't just
// cosmetic; a claim sent straight to the API during it must be rejected server-side too.
function isBeforeStart(deps: AppDeps, eventId: number): boolean {
  const event = deps.db.prepare('SELECT starts_at FROM events WHERE id = ?').get(eventId) as
    | { starts_at: string | null }
    | undefined;
  return !!event?.starts_at && new Date(event.starts_at).getTime() > Date.now();
}

// Tallies this user's current claims for the event by win-limit-group key (see
// winLimitGroup in events.ts) — the live, per-attempt equivalent of the counter the old
// end-of-event draw used to build once over the whole claimant pool.
// Shared by self-unclaim, the admin per-lot kick below, and participants.ts's ban
// cascade — all three are "give this claim's units back and reopen the lot," differing
// only in who's allowed to trigger it and under what guard. Returns whether a claim
// actually existed to cancel.
export function cancelClaim(deps: AppDeps, itemId: number, telegramId: number): boolean {
  const cancelled = deps.db.transaction(() => {
    const claim = deps.db.prepare('SELECT quantity FROM claims WHERE item_id = ? AND telegram_id = ?').get(itemId, telegramId) as
      | { quantity: number }
      | undefined;
    if (!claim) return false;
    deps.db.prepare('DELETE FROM claims WHERE item_id = ? AND telegram_id = ?').run(itemId, telegramId);

    // Invasion still reserves stock instantly on claim (see the claim handler below), so
    // withdrawing has to give those units back. Every other template (feast) now treats a
    // claim as a plain, non-reserving raffle entry — nothing was decremented, so there's
    // nothing to return.
    const template = deps.db
      .prepare(`SELECT s.template FROM items i JOIN screenshots s ON s.id = i.screenshot_id WHERE i.id = ?`)
      .get(itemId) as { template: string } | undefined;
    if (template?.template === 'invasion') {
      deps.db.prepare("UPDATE items SET quantity = quantity + ?, status = 'pool' WHERE id = ?").run(claim.quantity, itemId);
    }
    return true;
  })();
  if (cancelled) publishChange();
  return cancelled;
}

const MEMBER_DAILY_PURPLE_LIMIT = 1;
const OFFICER_DAILY_PURPLE_LIMIT = 2;

function isOfficerRank(deps: AppDeps, userId: number): boolean {
  if (deps.adminTelegramIds.includes(userId)) return true;
  const row = deps.db.prepare('SELECT rank FROM users WHERE telegram_id = ?').get(userId) as { rank: string } | undefined;
  return row?.rank === 'officer';
}

// Moscow runs a fixed UTC+3 offset year-round (no DST since 2014) — the alliance's "day"
// for the purple claim limit resets at Moscow midnight, not the server's own timezone or
// each viewer's. Returns today's Moscow-day boundaries as UTC datetime strings in the
// same 'YYYY-MM-DD HH:MM:SS' shape claims.created_at is stored in (SQLite's
// datetime('now')), so they compare correctly as plain strings.
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
function moscowDayBoundsUtc(): { start: string; end: string } {
  const toSqliteUtc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const moscowNow = new Date(Date.now() + MOSCOW_OFFSET_MS);
  const moscowMidnightUtcMs =
    Date.UTC(moscowNow.getUTCFullYear(), moscowNow.getUTCMonth(), moscowNow.getUTCDate()) - MOSCOW_OFFSET_MS;
  return { start: toSqliteUtc(moscowMidnightUtcMs), end: toSqliteUtc(moscowMidnightUtcMs + 24 * 60 * 60 * 1000) };
}

// Sums units of invasion-purple lots this person currently holds an active claim on,
// claimed today (Moscow day) — across every event, not just one. Unclaiming (or being
// kicked/banned, see cancelClaim) deletes the claims row, so it naturally frees this back
// up rather than needing its own separate ledger.
function getPurpleClaimedToday(deps: AppDeps, userId: number): number {
  const { start, end } = moscowDayBoundsUtc();
  const row = deps.db
    .prepare(
      `SELECT COALESCE(SUM(c.quantity), 0) as total
       FROM claims c
       JOIN items i ON i.id = c.item_id
       JOIN screenshots s ON s.id = i.screenshot_id
       WHERE c.telegram_id = ? AND i.color = 'purple' AND s.template = 'invasion'
         AND c.created_at >= ? AND c.created_at < ?`
    )
    .get(userId, start, end) as { total: number };
  return row.total;
}

const PURPLE_PER_EVENT_LIMIT = 1;

// The daily allowance (1 or 2, by rank) is a ceiling across the whole day, not a budget
// to spend however you like — everyone, officers included, can still only walk away with
// one purple lot from any single event. Otherwise an officer could burn both of a day's
// purple claims in one event, which is exactly the "unfair to regular members" outcome
// the alliance's rule is meant to prevent.
function getUserPurpleClaimedInEvent(deps: AppDeps, eventId: number, userId: number): number {
  const row = deps.db
    .prepare(
      `SELECT COALESCE(SUM(c.quantity), 0) as total
       FROM claims c
       JOIN items i ON i.id = c.item_id
       JOIN screenshots s ON s.id = i.screenshot_id
       WHERE c.telegram_id = ? AND i.event_id = ? AND i.color = 'purple' AND s.template = 'invasion'`
    )
    .get(userId, eventId) as { total: number };
  return row.total;
}

function getUserGroupCounts(deps: AppDeps, eventId: number, userId: number): Map<string, number> {
  const rows = deps.db
    .prepare(
      `SELECT i.color, i.category, s.template, c.quantity
       FROM claims c
       JOIN items i ON i.id = c.item_id
       JOIN screenshots s ON s.id = i.screenshot_id
       WHERE i.event_id = ? AND c.telegram_id = ?`
    )
    .all(eventId, userId) as { color: string; category: string; template: string; quantity: number }[];

  const counts = new Map<string, number>();
  for (const row of rows) {
    const { key } = winLimitGroup(row.template, row.color, row.category);
    counts.set(key, (counts.get(key) ?? 0) + row.quantity);
  }
  return counts;
}

export function registerItemRoutes(app: FastifyInstance, deps: AppDeps) {
  app.put<{ Params: { id: string }; Body: { name?: string; color?: string; category?: string; quantity?: number; class?: string } }>(
    '/items/:id',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const itemId = Number(request.params.id);
      const eventId = itemEventId(deps, itemId);
      if (eventId === undefined || !isEventDraft(deps, eventId)) {
        reply.code(409).send({ error: 'event is not in draft' });
        return;
      }

      const { name, color, category, quantity, class: itemClass } = request.body ?? {};
      if (name === undefined && color === undefined && category === undefined && quantity === undefined && itemClass === undefined) {
        reply.code(400).send({ error: 'at least one of name, color, category, quantity, class is required' });
        return;
      }
      if (color !== undefined && !VALID_COLORS.has(color)) {
        reply.code(400).send({ error: 'color must be blue, purple, or red' });
        return;
      }
      if (category !== undefined && !VALID_CATEGORIES.has(category)) {
        reply.code(400).send({ error: 'category must be item, stone_temper, or stone_remelt' });
        return;
      }
      if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1)) {
        reply.code(400).send({ error: 'quantity must be a positive integer' });
        return;
      }
      // '' clears the restriction — see items.class's default in db.ts.
      if (itemClass !== undefined && itemClass !== '' && !VALID_CLASSES.has(itemClass)) {
        reply.code(400).send({ error: 'class must be tank, rogue, mage, healer, hunter, or empty' });
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
      if (itemClass !== undefined) {
        updates.push('class = ?');
        values.push(itemClass);
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

  app.post<{ Params: { id: string }; Body: { name?: string; quantity?: number; color?: string; template?: string; class?: string } }>(
    '/events/:id/items/manual',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const eventId = Number(request.params.id);
      if (!isEventDraft(deps, eventId)) {
        reply.code(409).send({ error: 'event is not in draft' });
        return;
      }

      const { name, quantity, color, template = 'feast', class: itemClass = '' } = request.body ?? {};
      if (!color || !VALID_COLORS.has(color)) {
        reply.code(400).send({ error: 'color must be blue, purple, or red' });
        return;
      }
      if (!Number.isInteger(quantity) || quantity! < 1) {
        reply.code(400).send({ error: 'quantity must be a positive integer' });
        return;
      }
      if (!isTemplate(template)) {
        reply.code(400).send({ error: 'template must be feast or invasion' });
        return;
      }
      if (itemClass !== '' && !VALID_CLASSES.has(itemClass)) {
        reply.code(400).send({ error: 'class must be tank, rogue, mage, healer, hunter, or empty' });
        return;
      }

      const userId = request.telegramUser!.telegramId;
      await ensureManualPlaceholderImage(deps);
      const screenshotId = getOrCreateManualScreenshot(deps, eventId, userId, template);

      deps.db
        .prepare(
          "INSERT INTO items (event_id, screenshot_id, image_path, color, category, name, quantity, class, status) VALUES (?, ?, ?, ?, 'item', ?, ?, ?, 'pool')"
        )
        .run(eventId, screenshotId, MANUAL_PLACEHOLDER_IMAGE_PATH, color, (name ?? '').trim(), quantity, itemClass);

      publishChange();
      return { ok: true };
    }
  );

  // One click seeds the whole known invasion reward catalog (see invasion-catalog.ts) into
  // a draft event at quantity 1 each, real icons included — the admin then edits quantities
  // (or removes what didn't drop) to match the real result instead of adding 14 manual lots
  // by hand or screenshotting for CV recognition. Reuses the exact same manual-lot machinery
  // (synthetic screenshot, template inference) — these end up as ordinary items.
  app.post<{ Params: { id: string } }>(
    '/events/:id/items/invasion-template',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const eventId = Number(request.params.id);
      if (!isEventDraft(deps, eventId)) {
        reply.code(409).send({ error: 'event is not in draft' });
        return;
      }

      const userId = request.telegramUser!.telegramId;
      const screenshotId = getOrCreateManualScreenshot(deps, eventId, userId, 'invasion');
      const insertItem = deps.db.prepare(
        "INSERT INTO items (event_id, screenshot_id, image_path, color, category, name, quantity, status) VALUES (?, ?, ?, ?, 'item', '', 1, 'pool')"
      );

      for (const entry of INVASION_CATALOG) {
        await ensureInvasionCatalogImage(deps, entry.slug);
        insertItem.run(eventId, screenshotId, invasionCatalogImagePath(entry.slug), entry.color);
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

      const mergeItems = deps.db.transaction(() => {
        deps.db.prepare('UPDATE items SET quantity = quantity + ? WHERE id = ?').run(source.quantity, targetId);
        deps.db.prepare("UPDATE items SET status = 'removed' WHERE id = ?").run(sourceId);
      });
      mergeItems();

      return { ok: true };
    }
  );

  app.post<{ Params: { id: string }; Body: { quantity?: number } }>('/items/:id/claim', async (request, reply) => {
    const itemId = Number(request.params.id);
    const userId = request.telegramUser!.telegramId;

    const item = deps.db
      .prepare(
        `SELECT i.status, i.event_id, i.quantity, i.color, i.category, i.class, s.template
         FROM items i JOIN screenshots s ON s.id = i.screenshot_id
         WHERE i.id = ?`
      )
      .get(itemId) as
      | { status: string; event_id: number; quantity: number; color: string; category: string; class: string; template: string }
      | undefined;
    if (!item || item.status !== 'pool') {
      reply.code(409).send({ error: 'item is not claimable' });
      return;
    }

    // A class-restricted lot is a hard eligibility rule, not a fairness quota like the
    // win limits below — the wrong class shouldn't even be able to enter, regardless of
    // template. A participant with no class set yet can't be verified as eligible, so
    // they're blocked the same as a genuine mismatch.
    if (item.class) {
      const claimant = deps.db.prepare('SELECT class FROM users WHERE telegram_id = ?').get(userId) as { class: string } | undefined;
      if (claimant?.class !== item.class) {
        reply.code(409).send({ error: 'wrong class' });
        return;
      }
    }

    // Invasion still reserves stock instantly, up to the win-limit rules below (including
    // its own blue-2-at-once quantity) — none of that changed. Every other template (feast)
    // went back to a raffle: a claim is just an entry, always worth exactly one unit
    // regardless of what's requested, since a raffle draw only ever hands one unit of a lot
    // to one person (see item_winners' UNIQUE(item_id, telegram_id) in db.ts).
    const isInvasion = item.template === 'invasion';
    const quantity = isInvasion ? request.body?.quantity ?? 1 : 1;
    if (isInvasion) {
      if (!Number.isInteger(quantity) || quantity < 1) {
        reply.code(400).send({ error: 'quantity must be a positive integer' });
        return;
      }
      if (quantity > item.quantity) {
        reply.code(409).send({ error: 'not enough remaining quantity' });
        return;
      }
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
    if (isBeforeStart(deps, item.event_id)) {
      reply.code(409).send({ error: 'bidding has not started yet' });
      return;
    }

    const already = deps.db.prepare('SELECT 1 FROM claims WHERE item_id = ? AND telegram_id = ?').get(itemId, userId);
    if (already) {
      reply.code(409).send({ error: 'already claimed' });
      return;
    }

    if (isInvasion) {
      // Invasion purple has its own rule — a daily cap by rank, across every event, plus a
      // flat 1-per-event ceiling that applies to everyone regardless of rank (see
      // getUserPurpleClaimedInEvent) — so it skips winLimitGroup/getUserGroupCounts entirely.
      if (item.color === 'purple') {
        const claimedInEvent = getUserPurpleClaimedInEvent(deps, item.event_id, userId);
        if (claimedInEvent + quantity > PURPLE_PER_EVENT_LIMIT) {
          reply.code(409).send({ error: 'win limit reached' });
          return;
        }
        const dailyLimit = isOfficerRank(deps, userId) ? OFFICER_DAILY_PURPLE_LIMIT : MEMBER_DAILY_PURPLE_LIMIT;
        const claimedToday = getPurpleClaimedToday(deps, userId);
        if (claimedToday + quantity > dailyLimit) {
          reply.code(409).send({ error: 'daily purple limit reached' });
          return;
        }
      } else {
        const { key, limit, exclusiveWith } = winLimitGroup(item.template, item.color, item.category);
        const counts = getUserGroupCounts(deps, item.event_id, userId);
        if ((counts.get(key) ?? 0) + quantity > limit) {
          reply.code(409).send({ error: 'win limit reached' });
          return;
        }
        if (exclusiveWith?.some((other) => (counts.get(other) ?? 0) > 0)) {
          reply.code(409).send({ error: 'already won in the other category' });
          return;
        }
      }

      // Claiming an invasion lot immediately reserves the requested units of it — first
      // come, first served. Wrapped in a transaction so a crash between the two writes
      // can't leave a claim row without the matching stock decrement (or vice versa).
      const claimUnits = deps.db.transaction(() => {
        deps.db.prepare('INSERT INTO claims (item_id, telegram_id, quantity) VALUES (?, ?, ?)').run(itemId, userId, quantity);
        const remaining = item.quantity - quantity;
        deps.db
          .prepare('UPDATE items SET quantity = ?, status = ? WHERE id = ?')
          .run(remaining, remaining <= 0 ? 'auctioned' : 'pool', itemId);
      });
      claimUnits();
    } else {
      // Feast: just register interest. Stock isn't touched and the lot's fate — who
      // actually wins a unit of it, respecting the item/stone category cap and their
      // mutual exclusion — is decided by the random draw in POST /events/:id/finish.
      deps.db.prepare('INSERT INTO claims (item_id, telegram_id, quantity) VALUES (?, ?, 1)').run(itemId, userId);
    }
    publishChange();

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

    cancelClaim(deps, itemId, userId);
    return { ok: true };
  });

  // Admin override of the same unclaim, targetable at anyone's claim (not just your own),
  // for fixing a mistaken bid without banning the person from the app entirely. Only while
  // the event is still open — once it's resolved, claims represent the finished, real
  // outcome and shouldn't be rewritten (same rule participants.ts's ban cascade follows).
  app.delete<{ Params: { id: string; telegramId: string } }>(
    '/items/:id/claims/:telegramId',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const itemId = Number(request.params.id);
      const telegramId = Number(request.params.telegramId);

      const item = deps.db.prepare('SELECT event_id FROM items WHERE id = ?').get(itemId) as { event_id: number } | undefined;
      if (!item) {
        reply.code(404).send({ error: 'item not found' });
        return;
      }
      const event = deps.db.prepare('SELECT status FROM events WHERE id = ?').get(item.event_id) as { status: string } | undefined;
      if (event?.status !== 'open') {
        reply.code(409).send({ error: 'event is not open' });
        return;
      }

      if (!cancelClaim(deps, itemId, telegramId)) {
        reply.code(404).send({ error: 'claim not found' });
        return;
      }
      return { ok: true };
    }
  );
}
