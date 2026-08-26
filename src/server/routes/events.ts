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

const ITEM_COLUMNS = `i.id, i.name, i.color, i.image_path as imagePath, i.status,
                i.winner_telegram_id as winnerTelegramId,
                w.game_nickname as winnerNickname`;

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
         LEFT JOIN users w ON w.telegram_id = i.winner_telegram_id
         WHERE i.event_id = ? AND i.status != 'removed'
         ORDER BY i.id`
      )
      .all(userId, event.id);

    return {
      event: { id: event.id, title: event.title, deadlineAt: event.deadline_at, status: event.status },
      items,
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
         LEFT JOIN users w ON w.telegram_id = i.winner_telegram_id
         WHERE i.event_id = ? AND i.status != 'removed'
         ORDER BY i.id`
      )
      .all(eventId);

    return {
      event: { id: event.id, title: event.title, deadlineAt: event.deadline_at, status: event.status },
      items,
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

      const resolveAll = deps.db.transaction(() => {
        const poolItems = deps.db
          .prepare("SELECT id, color FROM items WHERE event_id = ? AND status = 'pool'")
          .all(eventId) as { id: number; color: string }[];

        const winCounts = new Map<number, Record<ColorGroup, number>>();

        for (const item of shuffle(poolItems)) {
          const claimants = deps.db.prepare('SELECT telegram_id FROM claims WHERE item_id = ?').all(item.id) as {
            telegram_id: number;
          }[];
          const group = colorGroup(item.color);
          const eligible = claimants.filter((c) => (winCounts.get(c.telegram_id)?.[group] ?? 0) < WIN_LIMITS[group]);
          const winner = pickRandom(eligible);
          if (!winner) continue;

          deps.db
            .prepare(
              "UPDATE items SET status = 'auctioned', winner_telegram_id = ?, auctioned_at = datetime('now') WHERE id = ?"
            )
            .run(winner.telegram_id, item.id);

          const counts = winCounts.get(winner.telegram_id) ?? { purpleRed: 0, blue: 0 };
          counts[group] += 1;
          winCounts.set(winner.telegram_id, counts);
        }

        deps.db.prepare("UPDATE events SET status = 'resolved' WHERE id = ?").run(eventId);
      });

      resolveAll();
      return { ok: true };
    }
  );
}
