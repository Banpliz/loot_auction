import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyInitData, type TelegramUser } from './telegram-init-data';
import type { AppDeps } from './types';

declare module 'fastify' {
  interface FastifyRequest {
    telegramUser?: TelegramUser;
  }
}

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
    deps.db
      .prepare(
        `INSERT INTO users (telegram_id, username) VALUES (?, ?)
         ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username`
      )
      .run(user.telegramId, user.username ?? null);
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
