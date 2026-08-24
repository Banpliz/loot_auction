import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../../src/server/db';
import { buildServer } from '../../../src/server/server';
import { signUserInitData } from '../../test-helpers';
import type { FastifyInstance } from 'fastify';

describe('events routes', () => {
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
    // seed user 2 with nickname so winnerNickname can be asserted later
    db.prepare("INSERT INTO users (telegram_id, username, game_nickname) VALUES (2, 'bob', 'Bob')").run();
  });

  it('POST /events is admin-only and stores a deadline from durationMinutes', async () => {
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': memberInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент', durationMinutes: 25 },
    });
    expect(forbidden.statusCode).toBe(403);

    const res = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент 24.08', durationMinutes: 25 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe('Ивент 24.08');
    expect(res.json().deadlineAt).not.toBeNull();
  });

  it('GET /events/current returns null when there is no event yet', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events/current', headers: { 'x-telegram-init-data': memberInitData } });
    expect(res.json()).toEqual({ event: null, items: [] });
  });

  it('resolve picks a random winner per claimed item and leaves unclaimed items in the pool', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент', durationMinutes: 25 },
    });
    const eventId = createRes.json().id;

    const screenshot = db
      .prepare('INSERT INTO screenshots (event_id, original_path, rows, cols, uploaded_by) VALUES (?, ?, 1, 1, 1)')
      .run(eventId, '/tmp/original.png');
    const claimedItem = db
      .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status) VALUES (?, ?, 'Меч', 'items/a.png', 'pool')")
      .run(eventId, screenshot.lastInsertRowid);
    const unclaimedItem = db
      .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status) VALUES (?, ?, 'Щит', 'items/b.png', 'pool')")
      .run(eventId, screenshot.lastInsertRowid);
    db.prepare('INSERT INTO claims (item_id, telegram_id) VALUES (?, ?)').run(claimedItem.lastInsertRowid, 2);

    const resolveRes = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/resolve`,
      headers: { 'x-telegram-init-data': adminInitData },
    });
    expect(resolveRes.statusCode).toBe(200);

    const poolRes = await app.inject({ method: 'GET', url: '/api/events/current', headers: { 'x-telegram-init-data': memberInitData } });
    const body = poolRes.json();
    expect(body.event.status).toBe('resolved');

    const claimed = body.items.find((i: any) => i.id === claimedItem.lastInsertRowid);
    expect(claimed.status).toBe('auctioned');
    expect(claimed.winnerTelegramId).toBe(2);
    expect(claimed.winnerNickname).toBe('Bob');

    const unclaimed = body.items.find((i: any) => i.id === unclaimedItem.lastInsertRowid);
    expect(unclaimed.status).toBe('pool');
  });
});
