import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';
import { pickRandom } from '../random';

interface EventRow {
  id: number;
  title: string;
  deadline_at: string | null;
  status: string;
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

  app.get('/events/current', async (request) => {
    const event = deps.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get() as EventRow | undefined;
    if (!event) return { event: null, items: [] };

    const userId = request.telegramUser!.telegramId;
    const items = deps.db
      .prepare(
        `SELECT i.id, i.name, i.image_path as imagePath, i.status,
                i.winner_telegram_id as winnerTelegramId,
                w.game_nickname as winnerNickname,
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

  app.post<{ Params: { id: string } }>(
    '/events/:id/resolve',
    { preHandler: requireAdmin(deps) },
    async (request) => {
      const eventId = Number(request.params.id);
      const poolItems = deps.db.prepare("SELECT id FROM items WHERE event_id = ? AND status = 'pool'").all(eventId) as {
        id: number;
      }[];

      const resolveOne = deps.db.transaction((itemId: number) => {
        const claimants = deps.db.prepare('SELECT telegram_id FROM claims WHERE item_id = ?').all(itemId) as {
          telegram_id: number;
        }[];
        const winner = pickRandom(claimants);
        if (!winner) return;
        deps.db
          .prepare(
            "UPDATE items SET status = 'auctioned', winner_telegram_id = ?, auctioned_at = datetime('now') WHERE id = ?"
          )
          .run(winner.telegram_id, itemId);
      });

      for (const item of poolItems) resolveOne(item.id);

      deps.db.prepare("UPDATE events SET status = 'resolved' WHERE id = ?").run(eventId);
      return { ok: true };
    }
  );
}
