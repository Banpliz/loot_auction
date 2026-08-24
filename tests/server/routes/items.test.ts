import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../../src/server/db';
import { buildServer } from '../../../src/server/server';
import { signUserInitData } from '../../test-helpers';
import type { FastifyInstance } from 'fastify';

describe('items routes', () => {
  const botToken = 'test-token';
  let db: Db;
  let app: FastifyInstance;
  let adminInitData: string;
  let aliceInitData: string;
  let bobInitData: string;
  let eventId: number;
  let itemAId: number;
  let itemBId: number;

  beforeEach(() => {
    db = openDb(':memory:');
    app = buildServer({ db, botToken, adminTelegramIds: [1], dataDir: '/tmp/loot-auction-test' });
    adminInitData = signUserInitData(1, 'admin', botToken);
    aliceInitData = signUserInitData(2, 'alice', botToken);
    bobInitData = signUserInitData(3, 'bob', botToken);

    eventId = db.prepare("INSERT INTO events (title, status) VALUES ('Ивент', 'open')").run().lastInsertRowid as number;
    db.prepare("INSERT INTO users (telegram_id, username) VALUES (1, 'admin')").run();
    const screenshotId = db
      .prepare('INSERT INTO screenshots (event_id, original_path, rows, cols, uploaded_by) VALUES (?, ?, 1, 2, 1)')
      .run(eventId, '/tmp/o.png').lastInsertRowid as number;
    itemAId = db
      .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status) VALUES (?, ?, 'A', 'items/a.png', 'pool')")
      .run(eventId, screenshotId).lastInsertRowid as number;
    itemBId = db
      .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status) VALUES (?, ?, 'B', 'items/b.png', 'pool')")
      .run(eventId, screenshotId).lastInsertRowid as number;
  });

  it('PUT /items/:id is admin-only and updates the name', async () => {
    const forbidden = await app.inject({
      method: 'PUT',
      url: `/api/items/${itemAId}`,
      headers: { 'x-telegram-init-data': aliceInitData, 'content-type': 'application/json' },
      payload: { name: 'Меч' },
    });
    expect(forbidden.statusCode).toBe(403);

    await app.inject({
      method: 'PUT',
      url: `/api/items/${itemAId}`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { name: 'Меч' },
    });
    const row = db.prepare('SELECT name FROM items WHERE id = ?').get(itemAId) as any;
    expect(row.name).toBe('Меч');
  });

  it('DELETE /items/:id soft-removes the item', async () => {
    await app.inject({ method: 'DELETE', url: `/api/items/${itemAId}`, headers: { 'x-telegram-init-data': adminInitData } });
    const row = db.prepare('SELECT status FROM items WHERE id = ?').get(itemAId) as any;
    expect(row.status).toBe('removed');
  });

  it('claiming respects the per-user limit across the event', async () => {
    db.prepare('UPDATE settings SET max_simultaneous_claims = 1 WHERE id = 1').run();

    const first = await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: 'POST', url: `/api/items/${itemBId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(second.statusCode).toBe(409);
  });

  it('unclaiming frees a slot for another claim', async () => {
    db.prepare('UPDATE settings SET max_simultaneous_claims = 1 WHERE id = 1').run();
    await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    await app.inject({ method: 'DELETE', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    const res = await app.inject({ method: 'POST', url: `/api/items/${itemBId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(res.statusCode).toBe(200);
  });

  it('claiming an already-auctioned item is rejected', async () => {
    db.prepare("UPDATE items SET status = 'auctioned' WHERE id = ?").run(itemAId);
    const res = await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': bobInitData } });
    expect(res.statusCode).toBe(409);
  });

  it('claiming the same item twice does not create duplicate claims', async () => {
    await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    const row = db.prepare('SELECT COUNT(*) as count FROM claims WHERE item_id = ? AND telegram_id = 2').get(itemAId) as any;
    expect(row.count).toBe(1);
  });
});
