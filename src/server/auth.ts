import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyInitData, type TelegramUser } from './telegram-init-data';
import type { AppDeps } from './types';

declare module 'fastify' {
  interface FastifyRequest {
    telegramUser?: TelegramUser;
  }
}

// GET/PUT /me stays reachable regardless of approval status — it's how a pending user
// checks their own status, and PUT /me (setting a nickname) is literally how someone
// submits their access request in the first place (see participants.ts).
const APPROVAL_EXEMPT_PATHS = new Set(['/api/me']);

export function registerAuth(app: FastifyInstance, deps: AppDeps) {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const initData = request.headers['x-telegram-init-data'];
    if (typeof initData !== 'string') {
      reply.code(401).send({ error: 'missing init data' });
      return;
    }
    const user = verifyInitData(initData, deps.botToken);
    if (!user) {
      reply.code(401).send({ error: 'invalid init data' });
      return;
    }
    request.telegramUser = user;
    // Leaves `status` alone on conflict — only the row's very first insert sets it (to
    // the column's 'pending' default); approval/ban state must never be clobbered by the
    // next request the same person happens to make.
    deps.db
      .prepare(
        `INSERT INTO users (telegram_id, username) VALUES (?, ?)
         ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username`
      )
      .run(user.telegramId, user.username ?? null);

    const isAdmin = deps.adminTelegramIds.includes(user.telegramId);
    if (isAdmin) {
      deps.db.prepare("UPDATE users SET status = 'approved' WHERE telegram_id = ? AND status != 'approved'").run(user.telegramId);
      return;
    }

    if (!APPROVAL_EXEMPT_PATHS.has(request.url.split('?')[0])) {
      const row = deps.db.prepare('SELECT status FROM users WHERE telegram_id = ?').get(user.telegramId) as { status: string };
      if (row.status !== 'approved') {
        reply.code(403).send({ error: 'access pending approval', status: row.status });
      }
    }
  });
}

export function requireAdmin(deps: AppDeps) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const id = request.telegramUser?.telegramId;
    if (!id || !deps.adminTelegramIds.includes(id)) {
      reply.code(403).send({ error: 'admin only' });
    }
  };
}
