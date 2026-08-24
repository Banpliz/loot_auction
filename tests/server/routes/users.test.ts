import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../../src/server/db';
import { buildServer } from '../../../src/server/server';
import { signUserInitData } from '../../test-helpers';
import type { FastifyInstance } from 'fastify';

describe('users routes', () => {
  const botToken = 'test-token';
  let db: Db;
  let app: FastifyInstance;
  let initData: string;

  beforeEach(() => {
    db = openDb(':memory:');
    app = buildServer({ db, botToken, adminTelegramIds: [1], dataDir: '/tmp/loot-auction-test' });
    initData = signUserInitData(1, 'admin', botToken);
  });

  it('GET /me reports isAdmin true for a configured admin id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-telegram-init-data': initData } });
    expect(res.json()).toMatchObject({ telegramId: 1, username: 'admin', gameNickname: null, isAdmin: true });
  });

  it('GET /me reports isAdmin false for a non-admin id', async () => {
    const memberInitData = signUserInitData(2, 'bob', botToken);
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-telegram-init-data': memberInitData } });
    expect(res.json().isAdmin).toBe(false);
  });

  it('PUT /me rejects an empty nickname', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/me',
      headers: { 'x-telegram-init-data': initData, 'content-type': 'application/json' },
      payload: { gameNickname: '  ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT /me saves the nickname and GET /me reflects it', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/me',
      headers: { 'x-telegram-init-data': initData, 'content-type': 'application/json' },
      payload: { gameNickname: 'Дракоша' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-telegram-init-data': initData } });
    expect(res.json().gameNickname).toBe('Дракоша');
  });
});
