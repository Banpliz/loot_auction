import path from 'node:path';

export interface Config {
  botToken: string;
  adminTelegramIds: number[];
  port: number;
  dataDir: string;
  miniAppUrl: string;
  anthropicApiKey?: string;
  // Overridable so a wire-compatible Anthropic proxy (e.g. a reseller mirroring the same
  // x-api-key/`/v1/messages` shape on its own domain) can be used instead of Anthropic's
  // own endpoint — useful where paying Anthropic directly isn't convenient. No trailing
  // slash expected; vision.ts appends `/v1/messages` itself.
  anthropicBaseUrl: string;
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
    dataDir: path.resolve(env.DATA_DIR ?? 'data'),
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    anthropicBaseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
  };
}
