import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';

export function registerItemRoutes(app: FastifyInstance, deps: AppDeps) {
  app.put<{ Params: { id: string }; Body: { name: string } }>(
    '/items/:id',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const name = request.body?.name?.trim();
      if (!name) {
        reply.code(400).send({ error: 'name is required' });
        return;
      }
      deps.db.prepare('UPDATE items SET name = ? WHERE id = ?').run(name, Number(request.params.id));
      return { ok: true };
    }
  );

  app.delete<{ Params: { id: string } }>('/items/:id', { preHandler: requireAdmin(deps) }, async (request) => {
    deps.db.prepare("UPDATE items SET status = 'removed' WHERE id = ?").run(Number(request.params.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/items/:id/claim', async (request, reply) => {
    const itemId = Number(request.params.id);
    const userId = request.telegramUser!.telegramId;

    const item = deps.db.prepare('SELECT event_id, status FROM items WHERE id = ?').get(itemId) as
      | { event_id: number; status: string }
      | undefined;
    if (!item || item.status !== 'pool') {
      reply.code(409).send({ error: 'item is not claimable' });
      return;
    }

    const { max_simultaneous_claims: limit } = deps.db
      .prepare('SELECT max_simultaneous_claims FROM settings WHERE id = 1')
      .get() as { max_simultaneous_claims: number };

    const { count } = deps.db
      .prepare(
        `SELECT COUNT(*) as count FROM claims c
         JOIN items i ON i.id = c.item_id
         WHERE c.telegram_id = ? AND i.event_id = ? AND i.status = 'pool'`
      )
      .get(userId, item.event_id) as { count: number };

    if (count >= limit) {
      reply.code(409).send({ error: `claim limit of ${limit} reached` });
      return;
    }

    deps.db.prepare('INSERT OR IGNORE INTO claims (item_id, telegram_id) VALUES (?, ?)').run(itemId, userId);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/items/:id/claim', async (request) => {
    const itemId = Number(request.params.id);
    const userId = request.telegramUser!.telegramId;
    deps.db.prepare('DELETE FROM claims WHERE item_id = ? AND telegram_id = ?').run(itemId, userId);
    return { ok: true };
  });
}
