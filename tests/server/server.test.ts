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

  it('a brand-new non-admin user starts pending, but GET /me still works', async () => {
    const initData = signUserInitData(2, 'bob', botToken);
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-telegram-init-data': initData } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('pending');
  });

  it('blocks a pending user from every other endpoint', async () => {
    const initData = signUserInitData(2, 'bob', botToken);
    await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-telegram-init-data': initData } });
    const res = await app.inject({ method: 'GET', url: '/api/events/current', headers: { 'x-telegram-init-data': initData } });
    expect(res.statusCode).toBe(403);
  });

  it('PUT /me (submitting a nickname) works while still pending', async () => {
    const initData = signUserInitData(2, 'bob', botToken);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/me',
      headers: { 'x-telegram-init-data': initData, 'content-type': 'application/json' },
      payload: { gameNickname: 'Bob' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('blocks a banned user from every other endpoint', async () => {
    const initData = signUserInitData(2, 'bob', botToken);
    await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-telegram-init-data': initData } });
    db.prepare("UPDATE users SET status = 'banned' WHERE telegram_id = 2").run();
    const res = await app.inject({ method: 'GET', url: '/api/events/current', headers: { 'x-telegram-init-data': initData } });
    expect(res.statusCode).toBe(403);
  });

  it('lets an approved user through to other endpoints', async () => {
    const initData = signUserInitData(2, 'bob', botToken);
    await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-telegram-init-data': initData } });
    db.prepare("UPDATE users SET status = 'approved' WHERE telegram_id = 2").run();
    const res = await app.inject({ method: 'GET', url: '/api/events/current', headers: { 'x-telegram-init-data': initData } });
    expect(res.statusCode).toBe(200);
  });

  it('force-approves an admin even though their row starts out pending (post-migration reset)', async () => {
    const initData = signUserInitData(1, 'admin', botToken);
    await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-telegram-init-data': initData } });
    const row = db.prepare('SELECT status FROM users WHERE telegram_id = 1').get() as any;
    expect(row.status).toBe('approved');

    const res = await app.inject({ method: 'GET', url: '/api/events/current', headers: { 'x-telegram-init-data': initData } });
    expect(res.statusCode).toBe(200);
  });
});
