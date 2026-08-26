import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';

const VALID_COLORS = new Set(['blue', 'purple', 'red']);

export function registerItemRoutes(app: FastifyInstance, deps: AppDeps) {
  app.put<{ Params: { id: string }; Body: { name?: string; price?: string; color?: string } }>(
    '/items/:id',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const { name, price, color } = request.body ?? {};
      if (name === undefined && price === undefined && color === undefined) {
        reply.code(400).send({ error: 'at least one of name, price, color is required' });
        return;
      }
      if (color !== undefined && !VALID_COLORS.has(color)) {
        reply.code(400).send({ error: 'color must be blue, purple, or red' });
        return;
      }

      const updates: string[] = [];
      const values: unknown[] = [];

      if (name !== undefined) {
        updates.push('name = ?');
        values.push(name.trim());
      }
      if (price !== undefined) {
        updates.push('price = ?');
        values.push(price.trim());
      }
      if (color !== undefined) {
        updates.push('color = ?');
        values.push(color);
      }

      values.push(Number(request.params.id));
      deps.db.prepare(`UPDATE items SET ${updates.join(', ')} WHERE id = ?`).run(...values);
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

    const item = deps.db.prepare('SELECT status FROM items WHERE id = ?').get(itemId) as { status: string } | undefined;
    if (!item || item.status !== 'pool') {
      reply.code(409).send({ error: 'item is not claimable' });
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
