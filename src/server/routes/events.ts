import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';
import { publishChange } from '../pubsub';

interface EventRow {
  id: number;
  title: string;
  deadline_at: string | null;
  status: string;
}

type ColorGroup = 'purpleRed' | 'blue';
type CategoryGroup = 'item' | 'stone';

// Fixed by design, not admin-configurable. Invasion caps by rarity color (purple+red
// combined 1 win/person/event, blue 2). Feast's alliance rule cuts across colors instead
// — gear (armor/weapons/etc.) capped at 1, tempering stones at 3 — so it's grouped by
// admin-set item.category rather than color. The two feast groups are also mutually
// exclusive (2026-08-28): winning a stone rules a person out of ever winning gear in the
// same event, and vice versa. Originally enforced once at the end-of-event draw; now
// enforced by items.ts's claim endpoint on every single claim attempt (2026-08-31), since
// there's no more draw step — see docs/superpowers/specs/2026-08-31-fcfs-reservation-design.md.
const COLOR_WIN_LIMITS: Record<ColorGroup, number> = { purpleRed: 1, blue: 2 };
const CATEGORY_WIN_LIMITS: Record<CategoryGroup, number> = { item: 1, stone: 3 };

function colorGroup(color: string): ColorGroup {
  return color === 'blue' ? 'blue' : 'purpleRed';
}

// Returns a per-person counter key (namespaced so a color group and a category group
// can never collide), the cap that applies to it, and — for feast only — the other
// category's key: any existing win there makes a person ineligible for this one too.
// Exported for items.ts's claim endpoint, which is now the sole caller of this rule.
export function winLimitGroup(template: string, color: string, category: string): { key: string; limit: number; exclusiveWith?: string } {
  if (template === 'feast') {
    const group: CategoryGroup = category === 'stone' ? 'stone' : 'item';
    const other: CategoryGroup = group === 'stone' ? 'item' : 'stone';
    return { key: `cat:${group}`, limit: CATEGORY_WIN_LIMITS[group], exclusiveWith: `cat:${other}` };
  }
  const group = colorGroup(color);
  return { key: `color:${group}`, limit: COLOR_WIN_LIMITS[group] };
}

const ITEM_COLUMNS = `i.id, i.name, i.color, i.category, i.quantity, i.image_path as imagePath, i.status, s.template as template`;

// Rarest-looking first: red, then purple, then blue — matches the in-game rarity
// order, not insertion order.
const COLOR_ORDER_SQL = `CASE i.color WHEN 'red' THEN 0 WHEN 'purple' THEN 1 WHEN 'blue' THEN 2 ELSE 3 END`;

interface Winner {
  telegramId: number;
  nickname: string | null;
  quantity: number;
}

// Attaches a `winners` array to each item — one entry per person currently holding a
// unit of it. Reads `claims` directly (not the old `item_winners` draw ledger): under
// first-come-first-served reservation, "claimed a unit" and "has a unit" are the same
// thing by construction, so there's nothing left for a separate winners table to record.
function attachWinners<T extends { id: number }>(deps: AppDeps, items: T[]): (T & { winners: Winner[] })[] {
  if (items.length === 0) return [];
  const placeholders = items.map(() => '?').join(',');
  const rows = deps.db
    .prepare(
      `SELECT c.item_id as itemId, u.telegram_id as telegramId, u.game_nickname as nickname, c.quantity as quantity
       FROM claims c
       LEFT JOIN users u ON u.telegram_id = c.telegram_id
       WHERE c.item_id IN (${placeholders})`
    )
    .all(...items.map((i) => i.id)) as { itemId: number; telegramId: number; nickname: string | null; quantity: number }[];

  const winnersByItem = new Map<number, Winner[]>();
  for (const row of rows) {
    const list = winnersByItem.get(row.itemId) ?? [];
    list.push({ telegramId: row.telegramId, nickname: row.nickname, quantity: row.quantity });
    winnersByItem.set(row.itemId, list);
  }
  return items.map((item) => ({ ...item, winners: winnersByItem.get(item.id) ?? [] }));
}

export function registerEventRoutes(app: FastifyInstance, deps: AppDeps) {
  app.post<{ Body: { title: string } }>(
    '/events',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const title = request.body?.title?.trim();
      if (!title) {
        reply.code(400).send({ error: 'title is required' });
        return;
      }

      const result = deps.db.prepare("INSERT INTO events (title, status) VALUES (?, 'draft')").run(title);
      return { id: result.lastInsertRowid, title, status: 'draft' };
    }
  );

  app.get('/events', { preHandler: requireAdmin(deps) }, async () => {
    const events = deps.db
      .prepare(
        `SELECT e.id, e.title, e.deadline_at as deadlineAt, e.status,
                (SELECT COUNT(*) FROM items i WHERE i.event_id = e.id AND i.status != 'removed') as itemCount
         FROM events e
         ORDER BY e.id DESC`
      )
      .all();
    return { events };
  });

  app.delete<{ Params: { id: string } }>('/events/:id', { preHandler: requireAdmin(deps) }, async (request) => {
    const eventId = Number(request.params.id);
    const deleteEvent = deps.db.transaction(() => {
      deps.db
        .prepare('DELETE FROM claims WHERE item_id IN (SELECT id FROM items WHERE event_id = ?)')
        .run(eventId);
      deps.db
        .prepare('DELETE FROM item_winners WHERE item_id IN (SELECT id FROM items WHERE event_id = ?)')
        .run(eventId);
      deps.db.prepare('DELETE FROM items WHERE event_id = ?').run(eventId);
      deps.db.prepare('DELETE FROM screenshots WHERE event_id = ?').run(eventId);
      deps.db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
    });
    deleteEvent();
    // ponytail: uploaded image files are left on disk; add a cleanup pass if disk usage becomes a problem.
    return { ok: true };
  });

  app.get('/events/current', async (request) => {
    // Draft events are excluded — an admin mid-upload/edit must not leak lots to users,
    // and (just as important) must not hide whatever event users were previously looking
    // at while the admin works on the next one.
    const event = deps.db.prepare("SELECT * FROM events WHERE status != 'draft' ORDER BY id DESC LIMIT 1").get() as
      | EventRow
      | undefined;
    if (!event) return { event: null, items: [] };

    const userId = request.telegramUser!.telegramId;
    const items = deps.db
      .prepare(
        `SELECT ${ITEM_COLUMNS},
                EXISTS(SELECT 1 FROM claims c WHERE c.item_id = i.id AND c.telegram_id = ?) as claimedByMe
         FROM items i
         JOIN screenshots s ON s.id = i.screenshot_id
         WHERE i.event_id = ? AND i.status != 'removed'
         ORDER BY ${COLOR_ORDER_SQL}, i.id`
      )
      .all(userId, event.id) as { id: number }[];

    return {
      event: { id: event.id, title: event.title, deadlineAt: event.deadline_at, status: event.status },
      items: attachWinners(deps, items),
    };
  });

  app.get<{ Params: { id: string } }>('/events/:id', { preHandler: requireAdmin(deps) }, async (request, reply) => {
    const eventId = Number(request.params.id);
    const event = deps.db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as EventRow | undefined;
    if (!event) {
      reply.code(404).send({ error: 'event not found' });
      return;
    }
    const items = deps.db
      .prepare(
        `SELECT ${ITEM_COLUMNS}
         FROM items i
         JOIN screenshots s ON s.id = i.screenshot_id
         WHERE i.event_id = ? AND i.status != 'removed'
         ORDER BY ${COLOR_ORDER_SQL}, i.id`
      )
      .all(eventId) as { id: number }[];

    return {
      event: { id: event.id, title: event.title, deadlineAt: event.deadline_at, status: event.status },
      items: attachWinners(deps, items),
    };
  });

  app.post<{ Params: { id: string }; Body: { durationMinutes?: number } }>(
    '/events/:id/start',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const eventId = Number(request.params.id);
      const event = deps.db.prepare('SELECT status FROM events WHERE id = ?').get(eventId) as { status: string } | undefined;
      if (!event) {
        reply.code(404).send({ error: 'event not found' });
        return;
      }

      const durationMinutes = request.body?.durationMinutes;
      if (!Number.isFinite(durationMinutes) || (durationMinutes as number) <= 0) {
        reply.code(400).send({ error: 'durationMinutes must be a positive number' });
        return;
      }
      if (event.status !== 'draft') {
        reply.code(409).send({ error: 'event has already started' });
        return;
      }

      const deadlineAt = new Date(Date.now() + (durationMinutes as number) * 60_000).toISOString();
      deps.db.prepare("UPDATE events SET status = 'open', deadline_at = ? WHERE id = ?").run(deadlineAt, eventId);
      publishChange();
      return { ok: true, deadlineAt };
    }
  );

  app.post<{ Params: { id: string } }>(
    '/events/:id/finish',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const eventId = Number(request.params.id);
      const event = deps.db.prepare('SELECT status, deadline_at FROM events WHERE id = ?').get(eventId) as
        | { status: string; deadline_at: string | null }
        | undefined;
      if (!event) {
        reply.code(404).send({ error: 'event not found' });
        return;
      }
      if (event.status !== 'open') {
        reply.code(409).send({ error: 'event is not open' });
        return;
      }

      // Only force the deadline into the past if it isn't already there — an admin
      // finishing after the countdown already ran out shouldn't have the recorded
      // deadline jump forward to "now".
      const alreadyPast = !!event.deadline_at && new Date(event.deadline_at).getTime() < Date.now();
      const deadlineAt = alreadyPast ? (event.deadline_at as string) : new Date().toISOString();
      deps.db.prepare("UPDATE events SET status = 'resolved', deadline_at = ? WHERE id = ?").run(deadlineAt, eventId);
      publishChange();
      return { ok: true };
    }
  );
}
