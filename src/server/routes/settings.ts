import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';

export function registerSettingsRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get('/settings', async () => {
    const row = deps.db.prepare('SELECT max_simultaneous_claims FROM settings WHERE id = 1').get() as {
      max_simultaneous_claims: number;
    };
    return { maxSimultaneousClaims: row.max_simultaneous_claims };
  });

  app.put<{ Body: { maxSimultaneousClaims: number } }>(
    '/settings',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const value = request.body?.maxSimultaneousClaims;
      if (!Number.isInteger(value) || value < 1) {
        reply.code(400).send({ error: 'maxSimultaneousClaims must be a positive integer' });
        return;
      }
      deps.db.prepare('UPDATE settings SET max_simultaneous_claims = ? WHERE id = 1').run(value);
      return { ok: true };
    }
  );
}
