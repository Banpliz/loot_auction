import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../types';

export function registerUserRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get('/me', async (request) => {
    const id = request.telegramUser!.telegramId;
    const row = deps.db
      .prepare('SELECT telegram_id, username, game_nickname, status FROM users WHERE telegram_id = ?')
      .get(id) as { telegram_id: number; username: string | null; game_nickname: string | null; status: string };

    return {
      telegramId: row.telegram_id,
      username: row.username,
      gameNickname: row.game_nickname,
      status: row.status,
      isAdmin: deps.adminTelegramIds.includes(id),
    };
  });

  app.put<{ Body: { gameNickname: string } }>('/me', async (request, reply) => {
    const gameNickname = request.body?.gameNickname?.trim();
    if (!gameNickname) {
      reply.code(400).send({ error: 'gameNickname is required' });
      return;
    }
    const id = request.telegramUser!.telegramId;
    deps.db.prepare('UPDATE users SET game_nickname = ? WHERE telegram_id = ?').run(gameNickname, id);
    return { ok: true };
  });
}
