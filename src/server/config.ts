import path from 'node:path';

export interface Config {
  botToken: string;
  adminTelegramIds: number[];
  port: number;
  dataDir: string;
  miniAppUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const botToken = env.BOT_TOKEN;
  if (!botToken) throw new Error('BOT_TOKEN is required');

  const miniAppUrl = env.MINI_APP_URL;
  if (!miniAppUrl) throw new Error('MINI_APP_URL is required');

  return {
    botToken,
    miniAppUrl,
    adminTelegramIds: (env.ADMIN_TELEGRAM_IDS ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
    port: Number(env.PORT ?? 3000),
    dataDir: env.DATA_DIR ?? path.join(process.cwd(), 'data'),
  };
}
