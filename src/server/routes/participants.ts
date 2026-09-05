import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';

export function registerParticipantRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get('/participants', { preHandler: requireAdmin(deps) }, async () => {
    const rows = deps.db
      .prepare(
        `SELECT telegram_id as telegramId, username, game_nickname as gameNickname, status
         FROM users
         ORDER BY created_at DESC`
      )
      .all() as { telegramId: number; username: string | null; gameNickname: string | null; status: string }[];

    return { participants: rows.filter((r) => !deps.adminTelegramIds.includes(r.telegramId)) };
  });

  app.post<{ Params: { telegramId: string } }>(
    '/participants/:telegramId/approve',
    { preHandler: requireAdmin(deps) },
    async (request) => {
      const telegramId = Number(request.params.telegramId);
      deps.db.prepare("UPDATE users SET status = 'approved' WHERE telegram_id = ?").run(telegramId);
      return { ok: true };
    }
  );

  app.post<{ Params: { telegramId: string } }>(
    '/participants/:telegramId/unban',
    { preHandler: requireAdmin(deps) },
    async (request) => {
      const telegramId = Number(request.params.telegramId);
      deps.db.prepare("UPDATE users SET status = 'pending' WHERE telegram_id = ?").run(telegramId);
      return { ok: true };
    }
  );

  // Banning cancels every active claim the person holds in a still-open event — the whole
  // point of exclusion is that they shouldn't keep a lot they haven't received yet — but
  // leaves claims in already-resolved events alone, since those already represent the
  // finished, real outcome of a past auction.
  app.post<{ Params: { telegramId: string } }>('/participants/:telegramId/ban', { preHandler: requireAdmin(deps) }, async (request, reply) => {
    const telegramId = Number(request.params.telegramId);
    if (deps.adminTelegramIds.includes(telegramId)) {
      reply.code(400).send({ error: 'cannot ban an admin' });
      return;
    }

    const banUser = deps.db.transaction(() => {
      deps.db.prepare("UPDATE users SET status = 'banned' WHERE telegram_id = ?").run(telegramId);

      const activeClaims = deps.db
        .prepare(
          `SELECT c.item_id as itemId, c.quantity as quantity
           FROM claims c
           JOIN items i ON i.id = c.item_id
           JOIN events e ON e.id = i.event_id
           WHERE c.telegram_id = ? AND e.status = 'open'`
        )
        .all(telegramId) as { itemId: number; quantity: number }[];

      for (const claim of activeClaims) {
        deps.db.prepare('DELETE FROM claims WHERE item_id = ? AND telegram_id = ?').run(claim.itemId, telegramId);
        deps.db.prepare("UPDATE items SET quantity = quantity + ?, status = 'pool' WHERE id = ?").run(claim.quantity, claim.itemId);
      }
    });
    banUser();

    return { ok: true };
  });
}
