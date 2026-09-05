import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../../src/server/db';
import { buildServer } from '../../../src/server/server';
import { signUserInitData } from '../../test-helpers';
import type { FastifyInstance } from 'fastify';

describe('participants routes', () => {
  const botToken = 'test-token';
  let db: Db;
  let app: FastifyInstance;
  let adminInitData: string;
  let aliceInitData: string;

  beforeEach(() => {
    db = openDb(':memory:');
    app = buildServer({ db, botToken, adminTelegramIds: [1], dataDir: '/tmp/loot-auction-test' });
    adminInitData = signUserInitData(1, 'admin', botToken);
    aliceInitData = signUserInitData(2, 'alice', botToken);
    db.prepare("INSERT INTO users (telegram_id, username, status) VALUES (1, 'admin', 'approved')").run();
    db.prepare("INSERT INTO users (telegram_id, username, game_nickname, status) VALUES (2, 'alice', 'Alice', 'pending')").run();
  });

  it('GET /participants is admin-only', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/participants', headers: { 'x-telegram-init-data': aliceInitData } });
    expect(res.statusCode).toBe(403);
  });

  it('GET /participants lists non-admin users and excludes admins', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/participants', headers: { 'x-telegram-init-data': adminInitData } });
    expect(res.statusCode).toBe(200);
    const { participants } = res.json();
    expect(participants).toEqual([{ telegramId: 2, username: 'alice', gameNickname: 'Alice', status: 'pending', rank: 'member' }]);
  });

  it('POST /participants/:id/rank is admin-only and sets the rank', async () => {
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/participants/2/rank',
      headers: { 'x-telegram-init-data': aliceInitData, 'content-type': 'application/json' },
      payload: { rank: 'officer' },
    });
    expect(forbidden.statusCode).toBe(403);

    const res = await app.inject({
      method: 'POST',
      url: '/api/participants/2/rank',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { rank: 'officer' },
    });
    expect(res.statusCode).toBe(200);
    const row = db.prepare('SELECT rank FROM users WHERE telegram_id = 2').get() as any;
    expect(row.rank).toBe('officer');
  });

  it('POST /participants/:id/rank rejects an invalid rank', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/participants/2/rank',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { rank: 'general' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /participants/:id/approve is admin-only and approves the user', async () => {
    const forbidden = await app.inject({ method: 'POST', url: '/api/participants/2/approve', headers: { 'x-telegram-init-data': aliceInitData } });
    expect(forbidden.statusCode).toBe(403);

    const res = await app.inject({ method: 'POST', url: '/api/participants/2/approve', headers: { 'x-telegram-init-data': adminInitData } });
    expect(res.statusCode).toBe(200);
    const row = db.prepare('SELECT status FROM users WHERE telegram_id = 2').get() as any;
    expect(row.status).toBe('approved');
  });

  it('POST /participants/:id/unban returns a banned user to pending', async () => {
    db.prepare("UPDATE users SET status = 'banned' WHERE telegram_id = 2").run();
    const res = await app.inject({ method: 'POST', url: '/api/participants/2/unban', headers: { 'x-telegram-init-data': adminInitData } });
    expect(res.statusCode).toBe(200);
    const row = db.prepare('SELECT status FROM users WHERE telegram_id = 2').get() as any;
    expect(row.status).toBe('pending');
  });

  it('POST /participants/:id/ban bans the user and cancels their active claims in open events', async () => {
    db.prepare("UPDATE users SET status = 'approved' WHERE telegram_id = 2").run();
    const eventId = db.prepare("INSERT INTO events (title, status) VALUES ('Ивент', 'open')").run().lastInsertRowid as number;
    const screenshotId = db
      .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
      .run(eventId, '/tmp/o.png').lastInsertRowid as number;
    const itemId = db
      .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status, quantity) VALUES (?, ?, 'X', 'items/x.png', 'auctioned', 0)")
      .run(eventId, screenshotId).lastInsertRowid as number;
    db.prepare('INSERT INTO claims (item_id, telegram_id, quantity) VALUES (?, 2, 2)').run(itemId);

    const res = await app.inject({ method: 'POST', url: '/api/participants/2/ban', headers: { 'x-telegram-init-data': adminInitData } });
    expect(res.statusCode).toBe(200);

    const user = db.prepare('SELECT status FROM users WHERE telegram_id = 2').get() as any;
    expect(user.status).toBe('banned');

    const item = db.prepare('SELECT quantity, status FROM items WHERE id = ?').get(itemId) as any;
    expect(item.quantity).toBe(2);
    expect(item.status).toBe('pool');

    const claim = db.prepare('SELECT COUNT(*) as count FROM claims WHERE item_id = ? AND telegram_id = 2').get(itemId) as any;
    expect(claim.count).toBe(0);
  });

  it('POST /participants/:id/ban leaves claims in already-resolved events untouched', async () => {
    db.prepare("UPDATE users SET status = 'approved' WHERE telegram_id = 2").run();
    const eventId = db.prepare("INSERT INTO events (title, status) VALUES ('Резолвед', 'resolved')").run().lastInsertRowid as number;
    const screenshotId = db
      .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
      .run(eventId, '/tmp/o2.png').lastInsertRowid as number;
    const itemId = db
      .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status, quantity) VALUES (?, ?, 'Y', 'items/y.png', 'auctioned', 0)")
      .run(eventId, screenshotId).lastInsertRowid as number;
    db.prepare('INSERT INTO claims (item_id, telegram_id, quantity) VALUES (?, 2, 1)').run(itemId);

    await app.inject({ method: 'POST', url: '/api/participants/2/ban', headers: { 'x-telegram-init-data': adminInitData } });

    const item = db.prepare('SELECT quantity, status FROM items WHERE id = ?').get(itemId) as any;
    expect(item.quantity).toBe(0);
    expect(item.status).toBe('auctioned');
    const claim = db.prepare('SELECT COUNT(*) as count FROM claims WHERE item_id = ? AND telegram_id = 2').get(itemId) as any;
    expect(claim.count).toBe(1);
  });

  it('POST /participants/:id/ban refuses to ban a configured admin', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/participants/1/ban', headers: { 'x-telegram-init-data': adminInitData } });
    expect(res.statusCode).toBe(400);
    const row = db.prepare('SELECT status FROM users WHERE telegram_id = 1').get() as any;
    expect(row.status).toBe('approved');
  });
});
