import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config';
import { openDb } from './db';
import { buildServer } from './server';
import { createBot } from './bot';

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });
const db = openDb(path.join(config.dataDir, 'app.db'));
const app = buildServer(
  { db, botToken: config.botToken, adminTelegramIds: config.adminTelegramIds, dataDir: config.dataDir, anthropicApiKey: config.anthropicApiKey },
  path.join(process.cwd(), 'dist', 'web')
);
const bot = createBot(config.botToken, config.miniAppUrl);

app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then(() => {
    console.log(`Server listening on port ${config.port}`);
    return bot.launch();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
