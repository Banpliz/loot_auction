import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';
import { pickRandom, shuffle } from '../random';

interface EventRow {
  id: number;
  title: string;
  deadline_at: string | null;
  status: string;
}

type ColorGroup = 'purpleRed' | 'blue';

// Fixed by design: purple+red combined cap at 1 win/person/event, blue at 2 — not admin-configurable.
const WIN_LIMITS: Record<ColorGroup, number> = { purpleRed: 1, blue: 2 };

function colorGroup(color: string): ColorGroup {
  return color === 'blue' ? 'blue' : 'purpleRed';
}

const ITEM_COLUMNS = `i.id, i.name, i.color, i.quantity, i.image_path as imagePath, i.status`;

interface Winner {
  telegramId: number;
  nickname: string | null;
}

// Attaches a `winners` array to each item (one entry per person a multi-quantity lot
// drew) — a separate query instead of a JOIN because a lot can have several winners,
// which a single-row-per-item JOIN can't represent without duplicating the other columns.
function attachWinners<T extends { id: number }>(deps: AppDeps, items: T[]): (T & { winners: Winner[] })[] {
  if (items.length === 0) return [];
  const placeholders = items.map(() => '?').join(',');
  const rows = deps.db
    .prepare(
      `SELECT iw.item_id as itemId, u.telegram_id as telegramId, u.game_nickname as nickname
       FROM item_winners iw
       LEFT JOIN users u ON u.telegram_id = iw.telegram_id
       WHERE iw.item_id IN (${placeholders})`
    )
    .all(...items.map((i) => i.id)) as { itemId: number; telegramId: number; nickname: string | null }[];

  const winnersByItem = new Map<number, Winner[]>();
  for (const row of rows) {
    const list = winnersByItem.get(row.itemId) ?? [];
    list.push({ telegramId: row.telegramId, nickname: row.nickname });
    winnersByItem.set(row.itemId, list);
  }
  return items.map((item) => ({ ...item, winners: winnersByItem.get(item.id) ?? [] }));
}

export function registerEventRoutes(app: FastifyInstance, deps: AppDeps) {
  app.post<{ Body: { title: string; durationMinutes: number } }>(
    '/events',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const title = request.body?.title?.trim();
      if (!title) {
        reply.code(400).send({ error: 'title is required' });
        return;
      }
      const durationMinutes = request.body?.durationMinutes;
      const deadlineAt =
        Number.isFinite(durationMinutes) && durationMinutes > 0
          ? new Date(Date.now() + durationMinutes * 60_000).toISOString()
          : null;

      const result = deps.db
        .prepare('INSERT INTO events (title, deadline_at, status) VALUES (?, ?, ?)')
        .run(title, deadlineAt, 'open');

      return { id: result.lastInsertRowid, title, deadlineAt, status: 'open' };
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
      deps.db.prepare('DELETE FROM items WHERE event_id = ?').run(eventId);
      deps.db.prepare('DELETE FROM screenshots WHERE event_id = ?').run(eventId);
      deps.db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
    });
    deleteEvent();
    // ponytail: uploaded image files are left on disk; add a cleanup pass if disk usage becomes a problem.
    return { ok: true };
  });

  app.get('/events/current', async (request) => {
    const event = deps.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get() as EventRow | undefined;
    if (!event) return { event: null, items: [] };

    const userId = request.telegramUser!.telegramId;
    const items = deps.db
      .prepare(
        `SELECT ${ITEM_COLUMNS},
                EXISTS(SELECT 1 FROM claims c WHERE c.item_id = i.id AND c.telegram_id = ?) as claimedByMe
         FROM items i
         WHERE i.event_id = ? AND i.status != 'removed'
         ORDER BY i.id`
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
         WHERE i.event_id = ? AND i.status != 'removed'
         ORDER BY i.id`
      )
      .all(eventId) as { id: number }[];

    return {
      event: { id: event.id, title: event.title, deadlineAt: event.deadline_at, status: event.status },
      items: attachWinners(deps, items),
    };
  });

  app.post<{ Params: { id: string } }>(
    '/events/:id/resolve',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const eventId = Number(request.params.id);
      const event = deps.db.prepare('SELECT id, status FROM events WHERE id = ?').get(eventId) as
        | { id: number; status: string }
        | undefined;
      if (!event) {
        reply.code(404).send({ error: 'event not found' });
        return;
      }
      if (event.status === 'resolved') {
        reply.code(409).send({ error: 'event already resolved' });
        return;
      }

      const insertWinner = deps.db.prepare('INSERT INTO item_winners (item_id, telegram_id) VALUES (?, ?)');
      const markAuctioned = deps.db.prepare("UPDATE items SET status = 'auctioned', auctioned_at = datetime('now') WHERE id = ?");

      const resolveAll = deps.db.transaction(() => {
        const poolItems = deps.db
          .prepare("SELECT id, color, quantity FROM items WHERE event_id = ? AND status = 'pool'")
          .all(eventId) as { id: number; color: string; quantity: number }[];

        const winCounts = new Map<number, Record<ColorGroup, number>>();

        for (const item of shuffle(poolItems)) {
          // One bid per person per item (claims' own UNIQUE), so drawing without
          // replacement here can never pick the same person twice for this item.
          let remaining = deps.db.prepare('SELECT telegram_id FROM claims WHERE item_id = ?').all(item.id) as {
            telegram_id: number;
          }[];
          const group = colorGroup(item.color);

          let wins = 0;
          for (let i = 0; i < item.quantity; i++) {
            const eligible = remaining.filter((c) => (winCounts.get(c.telegram_id)?.[group] ?? 0) < WIN_LIMITS[group]);
            const winner = pickRandom(eligible);
            if (!winner) break; // no claimant left who hasn't already hit their color cap

            insertWinner.run(item.id, winner.telegram_id);
            remaining = remaining.filter((c) => c.telegram_id !== winner.telegram_id);
            wins++;

            const counts = winCounts.get(winner.telegram_id) ?? { purpleRed: 0, blue: 0 };
            counts[group] += 1;
            winCounts.set(winner.telegram_id, counts);
          }
          if (wins > 0) markAuctioned.run(item.id);
        }

        deps.db.prepare("UPDATE events SET status = 'resolved' WHERE id = ?").run(eventId);
      });

      resolveAll();
      return { ok: true };
    }
  );
}
