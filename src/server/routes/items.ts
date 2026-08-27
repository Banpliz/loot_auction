import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';

const VALID_COLORS = new Set(['blue', 'purple', 'red']);

export function registerItemRoutes(app: FastifyInstance, deps: AppDeps) {
  app.put<{ Params: { id: string }; Body: { name?: string; color?: string; quantity?: number } }>(
    '/items/:id',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const { name, color, quantity } = request.body ?? {};
      if (name === undefined && color === undefined && quantity === undefined) {
        reply.code(400).send({ error: 'at least one of name, color, quantity is required' });
        return;
      }
      if (color !== undefined && !VALID_COLORS.has(color)) {
        reply.code(400).send({ error: 'color must be blue, purple, or red' });
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
      if (quantity !== undefined) {
        updates.push('quantity = ?');
        values.push(quantity);
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
