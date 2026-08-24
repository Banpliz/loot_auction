import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../../src/server/db';
import { buildServer } from '../../../src/server/server';
import { signUserInitData } from '../../test-helpers';
import type { FastifyInstance } from 'fastify';

describe('settings routes', () => {
  const botToken = 'test-token';
  let db: Db;
  let app: FastifyInstance;
  let adminInitData: string;
  let memberInitData: string;

  beforeEach(() => {
    db = openDb(':memory:');
    app = buildServer({ db, botToken, adminTelegramIds: [1], dataDir: '/tmp/loot-auction-test' });
    adminInitData = signUserInitData(1, 'admin', botToken);
    memberInitData = signUserInitData(2, 'bob', botToken);
  });

  it('GET /settings returns the default limit', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: { 'x-telegram-init-data': memberInitData } });
    expect(res.json()).toEqual({ maxSimultaneousClaims: 5 });
  });

  it('PUT /settings is rejected for a non-admin', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'x-telegram-init-data': memberInitData, 'content-type': 'application/json' },
      payload: { maxSimultaneousClaims: 3 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('PUT /settings updates the limit for an admin', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { maxSimultaneousClaims: 3 },
    });
    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: { 'x-telegram-init-data': memberInitData } });
    expect(res.json()).toEqual({ maxSimultaneousClaims: 3 });
  });

  it('PUT /settings rejects a non-positive limit', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { maxSimultaneousClaims: 0 },
    });
    expect(res.statusCode).toBe(400);
  });
});
