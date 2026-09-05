import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openDb, type Db } from '../../../src/server/db';
import { buildServer } from '../../../src/server/server';
import { signUserInitData, approveTestUser } from '../../test-helpers';
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

    eventId = db.prepare("INSERT INTO events (title, status) VALUES ('Ивент', 'draft')").run().lastInsertRowid as number;
    db.prepare("INSERT INTO users (telegram_id, username) VALUES (1, 'admin')").run();
    approveTestUser(db, 2);
    approveTestUser(db, 3);
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

  it('claiming reserves the lot immediately: quantity drops and status flips to auctioned at zero', async () => {
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    db.prepare('UPDATE items SET quantity = 2 WHERE id = ?').run(itemAId);

    const first = await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(first.statusCode).toBe(200);
    let row = db.prepare('SELECT quantity, status FROM items WHERE id = ?').get(itemAId) as any;
    expect(row.quantity).toBe(1);
    expect(row.status).toBe('pool');

    const second = await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': bobInitData } });
    expect(second.statusCode).toBe(200);
    row = db.prepare('SELECT quantity, status FROM items WHERE id = ?').get(itemAId) as any;
    expect(row.quantity).toBe(0);
    expect(row.status).toBe('auctioned');
  });

  it('claiming a sold-out lot is rejected', async () => {
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    db.prepare("UPDATE items SET quantity = 0, status = 'auctioned' WHERE id = ?").run(itemAId);
    const res = await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(res.statusCode).toBe(409);
  });

  it('claiming before starts_at is rejected even though the event is already open', async () => {
    const futureStart = new Date(Date.now() + 10_000).toISOString();
    db.prepare("UPDATE events SET status = 'open', starts_at = ? WHERE id = ?").run(futureStart, eventId);
    const res = await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(res.statusCode).toBe(409);
    const row = db.prepare('SELECT quantity FROM items WHERE id = ?').get(itemAId) as any;
    expect(row.quantity).toBe(1); // unchanged
  });

  it('claiming succeeds once starts_at has passed', async () => {
    const pastStart = new Date(Date.now() - 1000).toISOString();
    db.prepare("UPDATE events SET status = 'open', starts_at = ? WHERE id = ?").run(pastStart, eventId);
    const res = await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(res.statusCode).toBe(200);
  });

  it('claiming an item in a draft (not-yet-started) event is rejected', async () => {
    // eventId is 'draft' by default from beforeEach — no override here.
    const res = await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(res.statusCode).toBe(409);
  });

  it('claiming an item in a resolved event is rejected', async () => {
    db.prepare("UPDATE events SET status = 'resolved' WHERE id = ?").run(eventId);
    const res = await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(res.statusCode).toBe(409);
  });

  it('claiming the same item twice is rejected the second time', async () => {
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    const first = await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(second.statusCode).toBe(409);
    const row = db.prepare('SELECT COUNT(*) as count FROM claims WHERE item_id = ? AND telegram_id = 2').get(itemAId) as any;
    expect(row.count).toBe(1);
  });

  it('a user can claim two different lots that fall in different win-limit groups', async () => {
    // itemA/itemB's screenshot defaults to feast (see beforeEach), where category
    // 'item' vs 'stone' are mutually exclusive (see the dedicated test below), so they
    // can't stand in for "different, independent groups" here. Invasion's color groups
    // (purple+red vs blue) aren't exclusive of each other, so use those instead.
    const invasionEventId = db
      .prepare("INSERT INTO events (title, status) VALUES ('Разные группы', 'open')")
      .run().lastInsertRowid as number;
    const screenshotId = db
      .prepare("INSERT INTO screenshots (event_id, original_path, rows, template, uploaded_by) VALUES (?, ?, 1, 'invasion', 1)")
      .run(invasionEventId, '/tmp/groups.png').lastInsertRowid as number;
    const insertItem = db.prepare(
      "INSERT INTO items (event_id, screenshot_id, name, image_path, status, color) VALUES (?, ?, ?, 'items/x.png', 'pool', ?)"
    );
    const purpleId = insertItem.run(invasionEventId, screenshotId, 'Purple', 'purple').lastInsertRowid as number;
    const blueId = insertItem.run(invasionEventId, screenshotId, 'Blue', 'blue').lastInsertRowid as number;

    const first = await app.inject({ method: 'POST', url: `/api/items/${purpleId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: `/api/items/${blueId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(second.statusCode).toBe(200);
  });

  it('claiming a second lot in the same win-limit group is rejected once the cap is hit', async () => {
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    // itemA and itemB are both feast/category 'item' by default — capped at 1.
    const first = await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: `/api/items/${itemBId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(second.statusCode).toBe(409);
    const row = db.prepare('SELECT quantity FROM items WHERE id = ?').get(itemBId) as any;
    expect(row.quantity).toBe(1); // unclaimed — the rejected attempt never decremented it
  });

  it('feast categories stay mutually exclusive at claim time: winning a stone blocks winning gear too', async () => {
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    db.prepare("UPDATE items SET category = 'stone' WHERE id = ?").run(itemAId);
    db.prepare("UPDATE items SET category = 'item' WHERE id = ?").run(itemBId);

    const first = await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: `/api/items/${itemBId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(second.statusCode).toBe(409);
  });

  it('respects per-color win limits for invasion at claim time (purple+red combined 1, blue 2)', async () => {
    const invasionEventId = db
      .prepare("INSERT INTO events (title, status) VALUES ('Вторжение', 'open')")
      .run().lastInsertRowid as number;
    const screenshotId = db
      .prepare("INSERT INTO screenshots (event_id, original_path, rows, template, uploaded_by) VALUES (?, ?, 1, 'invasion', 1)")
      .run(invasionEventId, '/tmp/inv.png').lastInsertRowid as number;
    const insertItem = db.prepare(
      "INSERT INTO items (event_id, screenshot_id, name, image_path, status, color) VALUES (?, ?, ?, 'items/x.png', 'pool', ?)"
    );
    const purpleId = insertItem.run(invasionEventId, screenshotId, 'Purple', 'purple').lastInsertRowid as number;
    const redId = insertItem.run(invasionEventId, screenshotId, 'Red', 'red').lastInsertRowid as number;
    const blueAId = insertItem.run(invasionEventId, screenshotId, 'Blue A', 'blue').lastInsertRowid as number;
    const blueBId = insertItem.run(invasionEventId, screenshotId, 'Blue B', 'blue').lastInsertRowid as number;
    const blueCId = insertItem.run(invasionEventId, screenshotId, 'Blue C', 'blue').lastInsertRowid as number;

    expect((await app.inject({ method: 'POST', url: `/api/items/${purpleId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/items/${redId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } })).statusCode).toBe(409);

    expect((await app.inject({ method: 'POST', url: `/api/items/${blueAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/items/${blueBId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/items/${blueCId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } })).statusCode).toBe(409);
  });

  it('unclaiming gives the unit back: quantity increments and status returns to pool', async () => {
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    db.prepare('UPDATE items SET quantity = 1 WHERE id = ?').run(itemAId);
    await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    let row = db.prepare('SELECT quantity, status FROM items WHERE id = ?').get(itemAId) as any;
    expect(row.status).toBe('auctioned');

    const res = await app.inject({ method: 'DELETE', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(res.statusCode).toBe(200);
    row = db.prepare('SELECT quantity, status FROM items WHERE id = ?').get(itemAId) as any;
    expect(row.quantity).toBe(1);
    expect(row.status).toBe('pool');
    const claimRow = db.prepare('SELECT COUNT(*) as count FROM claims WHERE item_id = ? AND telegram_id = 2').get(itemAId) as any;
    expect(claimRow.count).toBe(0);
  });

  it("DELETE /items/:id/claims/:telegramId (admin kick) is admin-only", async () => {
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/items/${itemAId}/claims/2`,
      headers: { 'x-telegram-init-data': bobInitData },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin can kick a specific person off a lot, returning their units without touching other claimants', async () => {
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    db.prepare('UPDATE items SET quantity = 2 WHERE id = ?').run(itemAId);
    await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': bobInitData } });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/items/${itemAId}/claims/2`,
      headers: { 'x-telegram-init-data': adminInitData },
    });
    expect(res.statusCode).toBe(200);

    const item = db.prepare('SELECT quantity, status FROM items WHERE id = ?').get(itemAId) as any;
    expect(item.quantity).toBe(1);
    expect(item.status).toBe('pool');

    const aliceClaim = db.prepare('SELECT COUNT(*) as count FROM claims WHERE item_id = ? AND telegram_id = 2').get(itemAId) as any;
    expect(aliceClaim.count).toBe(0);
    const bobClaim = db.prepare('SELECT COUNT(*) as count FROM claims WHERE item_id = ? AND telegram_id = 3').get(itemAId) as any;
    expect(bobClaim.count).toBe(1); // untouched
  });

  it('admin kick returns 404 when that person has no claim on the lot', async () => {
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/items/${itemAId}/claims/2`,
      headers: { 'x-telegram-init-data': adminInitData },
    });
    expect(res.statusCode).toBe(404);
  });

  it('admin kick returns 404 for a nonexistent item', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/items/999999/claims/2`,
      headers: { 'x-telegram-init-data': adminInitData },
    });
    expect(res.statusCode).toBe(404);
  });

  it('admin kick is rejected once the event is resolved, leaving the claim intact', async () => {
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    db.prepare("UPDATE events SET status = 'resolved' WHERE id = ?").run(eventId);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/items/${itemAId}/claims/2`,
      headers: { 'x-telegram-init-data': adminInitData },
    });
    expect(res.statusCode).toBe(409);
    const aliceClaim = db.prepare('SELECT COUNT(*) as count FROM claims WHERE item_id = ? AND telegram_id = 2').get(itemAId) as any;
    expect(aliceClaim.count).toBe(1);
  });

  it('unclaiming an item nobody claimed leaves quantity untouched', async () => {
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    const res = await app.inject({ method: 'DELETE', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(res.statusCode).toBe(200);
    const row = db.prepare('SELECT quantity FROM items WHERE id = ?').get(itemAId) as any;
    expect(row.quantity).toBe(1); // unchanged
  });

  it('claiming with quantity 2 reserves two units in a single claim', async () => {
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    // itemA defaults to feast/category 'item' (win-limit cap 1) — bump it to 'stone'
    // (cap 3) so this test is purely about the multi-unit claim, not the win limit.
    db.prepare("UPDATE items SET quantity = 3, category = 'stone' WHERE id = ?").run(itemAId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/items/${itemAId}/claim`,
      headers: { 'x-telegram-init-data': aliceInitData, 'content-type': 'application/json' },
      payload: { quantity: 2 },
    });
    expect(res.statusCode).toBe(200);
    const item = db.prepare('SELECT quantity, status FROM items WHERE id = ?').get(itemAId) as any;
    expect(item.quantity).toBe(1);
    expect(item.status).toBe('pool');
    const claim = db.prepare('SELECT quantity FROM claims WHERE item_id = ? AND telegram_id = 2').get(itemAId) as any;
    expect(claim.quantity).toBe(2);
  });

  it('claiming more units than remain is rejected', async () => {
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    db.prepare('UPDATE items SET quantity = 1 WHERE id = ?').run(itemAId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/items/${itemAId}/claim`,
      headers: { 'x-telegram-init-data': aliceInitData, 'content-type': 'application/json' },
      payload: { quantity: 2 },
    });
    expect(res.statusCode).toBe(409);
    const item = db.prepare('SELECT quantity FROM items WHERE id = ?').get(itemAId) as any;
    expect(item.quantity).toBe(1); // unchanged
  });

  it('a two-unit claim on a blue lot uses up the full blue win limit (cap 2) in one shot', async () => {
    const invasionEventId = db
      .prepare("INSERT INTO events (title, status) VALUES ('Вторжение', 'open')")
      .run().lastInsertRowid as number;
    const screenshotId = db
      .prepare("INSERT INTO screenshots (event_id, original_path, rows, template, uploaded_by) VALUES (?, ?, 1, 'invasion', 1)")
      .run(invasionEventId, '/tmp/inv2.png').lastInsertRowid as number;
    const insertItem = db.prepare(
      "INSERT INTO items (event_id, screenshot_id, name, image_path, status, color, quantity) VALUES (?, ?, ?, 'items/x.png', 'pool', 'blue', ?)"
    );
    const blueAId = insertItem.run(invasionEventId, screenshotId, 'Blue A', 3).lastInsertRowid as number;
    const blueBId = insertItem.run(invasionEventId, screenshotId, 'Blue B', 1).lastInsertRowid as number;

    const first = await app.inject({
      method: 'POST',
      url: `/api/items/${blueAId}/claim`,
      headers: { 'x-telegram-init-data': aliceInitData, 'content-type': 'application/json' },
      payload: { quantity: 2 },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/api/items/${blueBId}/claim`,
      headers: { 'x-telegram-init-data': aliceInitData },
    });
    expect(second.statusCode).toBe(409);
  });

  it('rejects a single claim that would exceed the win limit by itself (purple/red cap 1)', async () => {
    const invasionEventId = db
      .prepare("INSERT INTO events (title, status) VALUES ('Вторжение', 'open')")
      .run().lastInsertRowid as number;
    const screenshotId = db
      .prepare("INSERT INTO screenshots (event_id, original_path, rows, template, uploaded_by) VALUES (?, ?, 1, 'invasion', 1)")
      .run(invasionEventId, '/tmp/inv3.png').lastInsertRowid as number;
    const purpleId = db
      .prepare(
        "INSERT INTO items (event_id, screenshot_id, name, image_path, status, color, quantity) VALUES (?, ?, 'Purple', 'items/x.png', 'pool', 'purple', 2)"
      )
      .run(invasionEventId, screenshotId).lastInsertRowid as number;

    const res = await app.inject({
      method: 'POST',
      url: `/api/items/${purpleId}/claim`,
      headers: { 'x-telegram-init-data': aliceInitData, 'content-type': 'application/json' },
      payload: { quantity: 2 },
    });
    expect(res.statusCode).toBe(409);
  });

  it('unclaiming gives back the exact quantity that claim reserved', async () => {
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    db.prepare("UPDATE items SET quantity = 3, category = 'stone' WHERE id = ?").run(itemAId);
    const claimRes = await app.inject({
      method: 'POST',
      url: `/api/items/${itemAId}/claim`,
      headers: { 'x-telegram-init-data': aliceInitData, 'content-type': 'application/json' },
      payload: { quantity: 2 },
    });
    expect(claimRes.statusCode).toBe(200);

    const res = await app.inject({ method: 'DELETE', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(res.statusCode).toBe(200);
    const item = db.prepare('SELECT quantity, status FROM items WHERE id = ?').get(itemAId) as any;
    expect(item.quantity).toBe(3);
    expect(item.status).toBe('pool');
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
    db.prepare('INSERT INTO claims (item_id, telegram_id) VALUES (?, 2)').run(lateItemId);

    const res = await app.inject({ method: 'DELETE', url: `/api/items/${lateItemId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(res.statusCode).toBe(409);
    const row = db.prepare('SELECT COUNT(*) as count FROM claims WHERE item_id = ?').get(lateItemId) as any;
    expect(row.count).toBe(1);
  });

  it('POST /items/:id/merge folds the source lot into the target and sums their quantity', async () => {
    db.prepare('UPDATE items SET quantity = 3 WHERE id = ?').run(itemAId);
    db.prepare('UPDATE items SET quantity = 2 WHERE id = ?').run(itemBId);

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

  it('PUT /items/:id is rejected once the event is no longer draft', async () => {
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/items/${itemAId}`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { name: 'Меч' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('DELETE /items/:id is rejected once the event is no longer draft', async () => {
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    const res = await app.inject({ method: 'DELETE', url: `/api/items/${itemAId}`, headers: { 'x-telegram-init-data': adminInitData } });
    expect(res.statusCode).toBe(409);
    const row = db.prepare('SELECT status FROM items WHERE id = ?').get(itemAId) as any;
    expect(row.status).toBe('pool'); // unchanged — the delete never ran
  });

  it('POST /items/:id/merge is rejected once the event is no longer draft', async () => {
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/items/${itemAId}/merge`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { intoId: itemBId },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('POST /events/:id/items/manual', () => {
  const botToken = 'test-token';
  let db: Db;
  let app: FastifyInstance;
  let dataDir: string;
  let adminInitData: string;
  let aliceInitData: string;
  let eventId: number;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'items-manual-test-'));
    db = openDb(':memory:');
    app = buildServer({ db, botToken, adminTelegramIds: [1], dataDir });
    adminInitData = signUserInitData(1, 'admin', botToken);
    aliceInitData = signUserInitData(2, 'alice', botToken);
    db.prepare("INSERT INTO users (telegram_id, username) VALUES (1, 'admin')").run();
    eventId = db.prepare("INSERT INTO events (title, status) VALUES ('Ивент', 'draft')").run().lastInsertRowid as number;
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('creates a pool item with a placeholder icon, without any screenshot upload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/items/manual`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { name: 'Компенсация', quantity: 3, color: 'purple' },
    });
    expect(res.statusCode).toBe(200);

    const row = db.prepare('SELECT name, quantity, color, category, status, image_path as imagePath FROM items WHERE event_id = ?').get(eventId) as any;
    expect(row.name).toBe('Компенсация');
    expect(row.quantity).toBe(3);
    expect(row.color).toBe('purple');
    expect(row.category).toBe('item');
    expect(row.status).toBe('pool');

    const iconStat = await fs.stat(path.join(dataDir, 'uploads', row.imagePath));
    expect(iconStat.isFile()).toBe(true);
  });

  it('defaults name to an empty string when omitted', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/items/manual`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { quantity: 1, color: 'blue' },
    });
    const row = db.prepare('SELECT name FROM items WHERE event_id = ?').get(eventId) as any;
    expect(row.name).toBe('');
  });

  it('reuses one synthetic screenshot row across multiple manual items in the same event', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/items/manual`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { quantity: 1, color: 'blue' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/items/manual`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { quantity: 1, color: 'red' },
    });
    const screenshotCount = db.prepare('SELECT COUNT(*) as n FROM screenshots WHERE event_id = ?').get(eventId) as any;
    expect(screenshotCount.n).toBe(1);
  });

  it('is admin-only', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/items/manual`,
      headers: { 'x-telegram-init-data': aliceInitData, 'content-type': 'application/json' },
      payload: { quantity: 1, color: 'blue' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('is rejected once the event is no longer draft', async () => {
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/items/manual`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { quantity: 1, color: 'blue' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects an invalid color', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/items/manual`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { quantity: 1, color: 'green' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-positive quantity', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/items/manual`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { quantity: 0, color: 'blue' },
    });
    expect(res.statusCode).toBe(400);
  });

  it("carries over an existing screenshot's template so win-limits apply consistently", async () => {
    db.prepare(
      "INSERT INTO screenshots (event_id, original_path, rows, template, uploaded_by) VALUES (?, '/tmp/o.png', 1, 'invasion', 1)"
    ).run(eventId);
    await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/items/manual`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      // Passing 'feast' here must be ignored — the event already has a real invasion
      // screenshot, and mixing win-limit rules within one event would be a worse bug
      // than not letting the admin override it.
      payload: { quantity: 1, color: 'blue', template: 'feast' },
    });
    const manualScreenshot = db
      .prepare("SELECT template FROM screenshots WHERE event_id = ? AND original_path = 'manual'")
      .get(eventId) as any;
    expect(manualScreenshot.template).toBe('invasion');
  });

  it('uses the admin-chosen template for a pure-manual event with no real screenshot yet', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/items/manual`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { quantity: 1, color: 'blue', template: 'invasion' },
    });
    const manualScreenshot = db
      .prepare("SELECT template FROM screenshots WHERE event_id = ? AND original_path = 'manual'")
      .get(eventId) as any;
    expect(manualScreenshot.template).toBe('invasion');
  });

  it('defaults to feast when no template is given and no real screenshot exists', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/items/manual`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { quantity: 1, color: 'blue' },
    });
    const manualScreenshot = db
      .prepare("SELECT template FROM screenshots WHERE event_id = ? AND original_path = 'manual'")
      .get(eventId) as any;
    expect(manualScreenshot.template).toBe('feast');
  });

  it('rejects an invalid template', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/items/manual`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { quantity: 1, color: 'blue', template: 'nonsense' },
    });
    expect(res.statusCode).toBe(400);
  });
});
