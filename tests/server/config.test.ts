import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/server/config';

describe('loadConfig', () => {
  const base = { BOT_TOKEN: 'token', MINI_APP_URL: 'https://example.test' };

  it('throws when BOT_TOKEN is missing', () => {
    expect(() => loadConfig({ MINI_APP_URL: 'https://example.test' })).toThrow(/BOT_TOKEN/);
  });

  it('throws when MINI_APP_URL is missing', () => {
    expect(() => loadConfig({ BOT_TOKEN: 'token' })).toThrow(/MINI_APP_URL/);
  });

  it('parses a comma-separated admin id list', () => {
    const config = loadConfig({ ...base, ADMIN_TELEGRAM_IDS: '111, 222,333' });
    expect(config.adminTelegramIds).toEqual([111, 222, 333]);
  });

  it('defaults port to 3000 and dataDir to ./data', () => {
    const config = loadConfig(base);
    expect(config.port).toBe(3000);
    expect(config.dataDir.endsWith('data')).toBe(true);
  });

  it('resolves a relative DATA_DIR to an absolute path', () => {
    const config = loadConfig({ ...base, DATA_DIR: './data' });
    expect(path.isAbsolute(config.dataDir)).toBe(true);
  });
});
