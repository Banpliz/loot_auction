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
      .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
      .run(eventId, '/tmp/o.png').lastInsertRowid as number;
    itemAId = db
      .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status) VALUES (?, ?, 'A', 'items/a.png', 'pool')")
      .run(eventId, screenshotId).lastInsertRowid as number;
    itemBId = db
      .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status) VALUES (?, ?, 'B', 'items/b.png', 'pool')")
      .run(eventId, screenshotId).lastInsertRowid as number;
  });

  it('PUT /items/:id is admin-only and updates name/color', async () => {
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
      payload: { name: 'Меч', color: 'red' },
    });
    const row = db.prepare('SELECT name, color FROM items WHERE id = ?').get(itemAId) as any;
    expect(row.name).toBe('Меч');
    expect(row.color).toBe('red');
  });

  it('PUT /items/:id accepts a partial update (color only)', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/items/${itemAId}`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { color: 'purple' },
    });
    const row = db.prepare('SELECT name, color FROM items WHERE id = ?').get(itemAId) as any;
    expect(row.name).toBe('A'); // unchanged
    expect(row.color).toBe('purple');
  });

  it('PUT /items/:id rejects an invalid color', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/items/${itemAId}`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { color: 'green' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT /items/:id updates category and rejects an invalid one', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/items/${itemAId}`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { category: 'stone' },
    });
    expect(res.statusCode).toBe(200);
    const row = db.prepare('SELECT category FROM items WHERE id = ?').get(itemAId) as any;
    expect(row.category).toBe('stone');

    const invalid = await app.inject({
      method: 'PUT',
      url: `/api/items/${itemAId}`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { category: 'weapon' },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('DELETE /items/:id soft-removes the item', async () => {
    await app.inject({ method: 'DELETE', url: `/api/items/${itemAId}`, headers: { 'x-telegram-init-data': adminInitData } });
    const row = db.prepare('SELECT status FROM items WHERE id = ?').get(itemAId) as any;
    expect(row.status).toBe('removed');
  });

  it('a user can bid on multiple items with no limit', async () => {
    const first = await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: `/api/items/${itemBId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(second.statusCode).toBe(200);
  });

  it('unclaiming removes the bid so it no longer shows as claimed', async () => {
    await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    await app.inject({ method: 'DELETE', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    const row = db.prepare('SELECT COUNT(*) as count FROM claims WHERE item_id = ? AND telegram_id = 2').get(itemAId) as any;
    expect(row.count).toBe(0);
  });

  it('claiming after the event deadline has passed is rejected', async () => {
    const pastDeadline = new Date(Date.now() - 60_000).toISOString();
    const pastEventId = db
      .prepare("INSERT INTO events (title, status, deadline_at) VALUES ('Просрочен', 'open', ?)")
      .run(pastDeadline).lastInsertRowid as number;
    const screenshotId = db
      .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
      .run(pastEventId, '/tmp/p.png').lastInsertRowid as number;
    const lateItemId = db
      .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status) VALUES (?, ?, 'Late', 'items/late.png', 'pool')")
      .run(pastEventId, screenshotId).lastInsertRowid as number;

    const res = await app.inject({ method: 'POST', url: `/api/items/${lateItemId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(res.statusCode).toBe(409);
    const row = db.prepare('SELECT COUNT(*) as count FROM claims WHERE item_id = ?').get(lateItemId) as any;
    expect(row.count).toBe(0);
  });

  it('unclaiming after the event deadline has passed is rejected (no withdrawing to dodge a win-limit group)', async () => {
    const pastDeadline = new Date(Date.now() - 60_000).toISOString();
    const pastEventId = db
      .prepare("INSERT INTO events (title, status, deadline_at) VALUES ('Просрочен 2', 'open', ?)")
      .run(pastDeadline).lastInsertRowid as number;
    const screenshotId = db
      .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
      .run(pastEventId, '/tmp/p2.png').lastInsertRowid as number;
    const lateItemId = db
      .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status) VALUES (?, ?, 'Late', 'items/late2.png', 'pool')")
      .run(pastEventId, screenshotId).lastInsertRowid as number;
    // Bid placed while the event was still open (bypassing the claim endpoint, which
    // would itself reject it now that the deadline is in the past). Alice's users row
    // is normally created by the auth middleware on her first authenticated request,
    // which this direct insert skips, so it's seeded by hand here.
    db.prepare("INSERT INTO users (telegram_id, username) VALUES (2, 'alice')").run();
    db.prepare('INSERT INTO claims (item_id, telegram_id) VALUES (?, 2)').run(lateItemId);

    const res = await app.inject({ method: 'DELETE', url: `/api/items/${lateItemId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(res.statusCode).toBe(409);
    const row = db.prepare('SELECT COUNT(*) as count FROM claims WHERE item_id = ?').get(lateItemId) as any;
    expect(row.count).toBe(1);
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

  it('POST /items/:id/merge folds the source lot into the target and carries its bidders over', async () => {
    db.prepare('UPDATE items SET quantity = 3 WHERE id = ?').run(itemAId);
    db.prepare('UPDATE items SET quantity = 2 WHERE id = ?').run(itemBId);
    await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    await app.inject({ method: 'POST', url: `/api/items/${itemBId}/claim`, headers: { 'x-telegram-init-data': bobInitData } });

    const res = await app.inject({
      method: 'POST',
      url: `/api/items/${itemAId}/merge`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { intoId: itemBId },
    });
    expect(res.statusCode).toBe(200);

    const source = db.prepare('SELECT status FROM items WHERE id = ?').get(itemAId) as any;
    expect(source.status).toBe('removed');

    const target = db.prepare('SELECT quantity FROM items WHERE id = ?').get(itemBId) as any;
    expect(target.quantity).toBe(5); // 3 + 2

    const claimants = (db.prepare('SELECT telegram_id FROM claims WHERE item_id = ?').all(itemBId) as any[])
      .map((r) => r.telegram_id)
      .sort();
    expect(claimants).toEqual([2, 3]); // alice's bid on A carried over, bob's on B kept
    expect(db.prepare('SELECT COUNT(*) as c FROM claims WHERE item_id = ?').get(itemAId)).toMatchObject({ c: 0 });
  });

  it('POST /items/:id/merge dedupes a bidder who had claimed both lots', async () => {
    await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    await app.inject({ method: 'POST', url: `/api/items/${itemBId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });

    await app.inject({
      method: 'POST',
      url: `/api/items/${itemAId}/merge`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { intoId: itemBId },
    });

    const row = db.prepare('SELECT COUNT(*) as c FROM claims WHERE item_id = ? AND telegram_id = 2').get(itemBId) as any;
    expect(row.c).toBe(1);
  });

  it('POST /items/:id/merge is admin-only', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/items/${itemAId}/merge`,
      headers: { 'x-telegram-init-data': aliceInitData, 'content-type': 'application/json' },
      payload: { intoId: itemBId },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /items/:id/merge rejects merging an already-auctioned lot', async () => {
    db.prepare("UPDATE items SET status = 'auctioned' WHERE id = ?").run(itemBId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/items/${itemAId}/merge`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { intoId: itemBId },
    });
    expect(res.statusCode).toBe(409);
  });
});
