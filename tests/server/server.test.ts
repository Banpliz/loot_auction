import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../src/server/db';
import { buildServer } from '../../src/server/server';
import { signUserInitData } from '../test-helpers';
import type { FastifyInstance } from 'fastify';

describe('buildServer auth', () => {
  const botToken = 'test-token';
  let db: Db;
  let app: FastifyInstance;

  beforeEach(() => {
    db = openDb(':memory:');
    app = buildServer({ db, botToken, adminTelegramIds: [1], dataDir: '/tmp/loot-auction-test' });
  });

  it('rejects requests with no initData header', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests with a tampered initData header', async () => {
    const initData = signUserInitData(1, 'admin', botToken).replace('admin', 'mallory');
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-telegram-init-data': initData } });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a validly signed request and upserts the user', async () => {
    const initData = signUserInitData(1, 'admin', botToken);
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-telegram-init-data': initData } });
    expect(res.statusCode).toBe(200);
    const row = db.prepare('SELECT username FROM users WHERE telegram_id = 1').get() as any;
    expect(row.username).toBe('admin');
  });
});
