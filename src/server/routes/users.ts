import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../types';

// Same value set as items.class — see items.ts's claim handler and web/format.ts's CLASSES.
const VALID_CLASSES = new Set(['tank', 'rogue', 'mage', 'healer', 'hunter']);

export function registerUserRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get('/me', async (request) => {
    const id = request.telegramUser!.telegramId;
    const row = deps.db
      .prepare('SELECT telegram_id, username, game_nickname, status, class FROM users WHERE telegram_id = ?')
      .get(id) as { telegram_id: number; username: string | null; game_nickname: string | null; status: string; class: string };

    return {
      telegramId: row.telegram_id,
      username: row.username,
      gameNickname: row.game_nickname,
      status: row.status,
      class: row.class,
      isAdmin: deps.adminTelegramIds.includes(id),
    };
  });

  // A participant sets their own class here, once, alongside their nickname (see
  // views/profile.ts) — an admin can still correct it afterward in "Заявки"
  // (POST /participants/:id/class), for whoever picks wrong or changes class in-game.
  app.put<{ Body: { gameNickname: string; class?: string } }>('/me', async (request, reply) => {
    const gameNickname = request.body?.gameNickname?.trim();
    if (!gameNickname) {
      reply.code(400).send({ error: 'gameNickname is required' });
      return;
    }
    const participantClass = request.body?.class;
    if (!participantClass || !VALID_CLASSES.has(participantClass)) {
      reply.code(400).send({ error: 'class must be tank, rogue, mage, healer, or hunter' });
      return;
    }
    const id = request.telegramUser!.telegramId;
    deps.db.prepare('UPDATE users SET game_nickname = ?, class = ? WHERE telegram_id = ?').run(gameNickname, participantClass, id);
    return { ok: true };
  });
}
