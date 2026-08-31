import type { Db } from './db';

export interface AppDeps {
  db: Db;
  botToken: string;
  adminTelegramIds: number[];
  dataDir: string;
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
}
