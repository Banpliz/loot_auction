import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../../src/server/db';
import { buildServer } from '../../../src/server/server';
import { signUserInitData, approveTestUser } from '../../test-helpers';
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
    db.prepare("INSERT INTO users (telegram_id, username, game_nickname, status) VALUES (2, 'bob', 'Bob', 'approved')").run();
  });

  it('POST /events is admin-only and creates a draft event with no deadline', async () => {
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': memberInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент' },
    });
    expect(forbidden.statusCode).toBe(403);

    const res = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент 31.08' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: 'Ивент 31.08', status: 'draft' });

    const row = db.prepare('SELECT status, deadline_at FROM events WHERE id = ?').get(res.json().id) as any;
    expect(row.status).toBe('draft');
    expect(row.deadline_at).toBeNull();
  });

  it('POST /events rejects a blank title', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /events/current returns null when there is no event yet', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events/current', headers: { 'x-telegram-init-data': memberInitData } });
    expect(res.json()).toMatchObject({ event: null, items: [] });
  });

  it('GET /events/current reports its own clock so the client can correct for device clock drift', async () => {
    const before = Date.now();
    const res = await app.inject({ method: 'GET', url: '/api/events/current', headers: { 'x-telegram-init-data': memberInitData } });
    const serverNowMs = new Date(res.json().serverNow).getTime();
    expect(serverNowMs).toBeGreaterThanOrEqual(before);
    expect(serverNowMs).toBeLessThanOrEqual(Date.now());
  });

  it('GET /events/current excludes draft events, even when they are the most recently created', async () => {
    const openRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Открытый' },
    });
    const openId = openRes.json().id;
    await app.inject({
      method: 'POST',
      url: `/api/events/${openId}/start`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { durationMinutes: 25 },
    });

    // Created after the open event, but never started — must not hide it from users.
    await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Черновик' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/events/current', headers: { 'x-telegram-init-data': memberInitData } });
    expect(res.json().event.title).toBe('Открытый');
  });

  it('POST /events/:id/start sets a deadline and switches status to open, admin-only', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент' },
    });
    const eventId = createRes.json().id;

    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/start`,
      headers: { 'x-telegram-init-data': memberInitData, 'content-type': 'application/json' },
      payload: { durationMinutes: 25 },
    });
    expect(forbidden.statusCode).toBe(403);

    const res = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/start`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { durationMinutes: 25 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deadlineAt).not.toBeNull();

    const row = db.prepare('SELECT status, deadline_at FROM events WHERE id = ?').get(eventId) as any;
    expect(row.status).toBe('open');
    expect(new Date(row.deadline_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('POST /events/:id/start sets a short starts_at countdown and counts the bidding duration from it, not from now', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент' },
    });
    const eventId = createRes.json().id;

    const before = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/start`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { durationMinutes: 25 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().startsAt).not.toBeNull();

    const row = db.prepare('SELECT starts_at, deadline_at FROM events WHERE id = ?').get(eventId) as any;
    const startsAtMs = new Date(row.starts_at).getTime();
    const deadlineAtMs = new Date(row.deadline_at).getTime();
    // Starts a few seconds out (not immediately), and the full 25 minutes remains
    // available for bidding starting from that moment — not shortened by the countdown.
    expect(startsAtMs).toBeGreaterThan(before);
    expect(deadlineAtMs - startsAtMs).toBeCloseTo(25 * 60_000, -2);
  });

  it("GET /events/current and GET /events/:id report the event's startsAt", async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент' },
    });
    const eventId = createRes.json().id;
    await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/start`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { durationMinutes: 25 },
    });

    const poolRes = await app.inject({ method: 'GET', url: '/api/events/current', headers: { 'x-telegram-init-data': memberInitData } });
    expect(poolRes.json().event.startsAt).not.toBeNull();

    const adminRes = await app.inject({ method: 'GET', url: `/api/events/${eventId}`, headers: { 'x-telegram-init-data': adminInitData } });
    expect(adminRes.json().event.startsAt).not.toBeNull();
  });

  it('POST /events/:id/start rejects a missing/zero durationMinutes and starting twice', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент' },
    });
    const eventId = createRes.json().id;

    const badDuration = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/start`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { durationMinutes: 0 },
    });
    expect(badDuration.statusCode).toBe(400);

    await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/start`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { durationMinutes: 25 },
    });
    const twice = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/start`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { durationMinutes: 25 },
    });
    expect(twice.statusCode).toBe(409);
  });

  it('POST /events/:id/finish closes bidding and marks the event resolved, admin-only', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент' },
    });
    const eventId = createRes.json().id;
    await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/start`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { durationMinutes: 25 },
    });

    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/finish`,
      headers: { 'x-telegram-init-data': memberInitData },
    });
    expect(forbidden.statusCode).toBe(403);

    const res = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/finish`,
      headers: { 'x-telegram-init-data': adminInitData },
    });
    expect(res.statusCode).toBe(200);

    const row = db.prepare('SELECT status, deadline_at FROM events WHERE id = ?').get(eventId) as any;
    expect(row.status).toBe('resolved');
    expect(new Date(row.deadline_at).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('POST /events/:id/finish preserves an already-past deadline instead of resetting it, and rejects finishing twice', async () => {
    const pastDeadline = new Date(Date.now() - 60_000).toISOString();
    const eventId = db
      .prepare("INSERT INTO events (title, status, deadline_at) VALUES ('Просрочен', 'open', ?)")
      .run(pastDeadline).lastInsertRowid as number;

    const res = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/finish`,
      headers: { 'x-telegram-init-data': adminInitData },
    });
    expect(res.statusCode).toBe(200);
    const row = db.prepare('SELECT deadline_at FROM events WHERE id = ?').get(eventId) as any;
    expect(row.deadline_at).toBe(pastDeadline);

    const twice = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/finish`,
      headers: { 'x-telegram-init-data': adminInitData },
    });
    expect(twice.statusCode).toBe(409);
  });

  it('POST /events/:id/finish rejects a draft event (must be open first)', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/events/${createRes.json().id}/finish`,
      headers: { 'x-telegram-init-data': adminInitData },
    });
    expect(res.statusCode).toBe(409);
  });

  it('a feast item drawn a winner (item_winners) reports it; one nobody claimed reports none', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент' },
    });
    const eventId = createRes.json().id;

    const screenshot = db
      .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
      .run(eventId, '/tmp/original.png');
    // Seeded directly rather than via a real finish()-driven draw — this test only checks
    // that GET /events/current's winners list reads a feast item's winners from
    // item_winners (attachWinners), independent of the draw logic that populates it.
    const claimedItem = db
      .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status) VALUES (?, ?, 'Меч', 'items/a.png', 'pool')")
      .run(eventId, screenshot.lastInsertRowid);
    const unclaimedItem = db
      .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status) VALUES (?, ?, 'Щит', 'items/b.png', 'pool')")
      .run(eventId, screenshot.lastInsertRowid);
    db.prepare('INSERT INTO item_winners (item_id, telegram_id) VALUES (?, 2)').run(claimedItem.lastInsertRowid);

    await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/start`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { durationMinutes: 25 },
    });

    const poolRes = await app.inject({ method: 'GET', url: '/api/events/current', headers: { 'x-telegram-init-data': memberInitData } });
    const body = poolRes.json();

    const claimed = body.items.find((i: any) => i.id === claimedItem.lastInsertRowid);
    expect(claimed.winners).toEqual([{ telegramId: 2, nickname: 'Bob', quantity: 1 }]);

    const unclaimed = body.items.find((i: any) => i.id === unclaimedItem.lastInsertRowid);
    expect(unclaimed.status).toBe('pool');
    expect(unclaimed.winners).toEqual([]);
  });

  it("GET /events/current and GET /events/:id report each item's screenshot template", async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Вторжение' },
    });
    const eventId = createRes.json().id;
    const screenshot = db
      .prepare("INSERT INTO screenshots (event_id, original_path, rows, template, uploaded_by) VALUES (?, ?, 1, 'invasion', 1)")
      .run(eventId, '/tmp/inv.png');
    const item = db
      .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status, color) VALUES (?, ?, 'Огр', 'items/a.png', 'pool', 'blue')")
      .run(eventId, screenshot.lastInsertRowid);
    await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/start`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { durationMinutes: 25 },
    });

    const poolRes = await app.inject({ method: 'GET', url: '/api/events/current', headers: { 'x-telegram-init-data': memberInitData } });
    expect(poolRes.json().items.find((i: any) => i.id === item.lastInsertRowid).template).toBe('invasion');

    const adminRes = await app.inject({ method: 'GET', url: `/api/events/${eventId}`, headers: { 'x-telegram-init-data': adminInitData } });
    expect(adminRes.json().items.find((i: any) => i.id === item.lastInsertRowid).template).toBe('invasion');
  });

  it("an invasion lot's winners list reports how many units a claim reserved (its instant-reservation claims are still its winners)", async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Вторжение' },
    });
    const eventId = createRes.json().id;
    const screenshot = db
      .prepare("INSERT INTO screenshots (event_id, original_path, rows, template, uploaded_by) VALUES (?, ?, 1, 'invasion', 1)")
      .run(eventId, '/tmp/original.png');
    const item = db
      .prepare(
        "INSERT INTO items (event_id, screenshot_id, name, image_path, status, quantity) VALUES (?, ?, 'Сундук', 'items/a.png', 'auctioned', 0)"
      )
      .run(eventId, screenshot.lastInsertRowid);
    db.prepare('INSERT INTO claims (item_id, telegram_id, quantity) VALUES (?, 2, 2)').run(item.lastInsertRowid);
    await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/start`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { durationMinutes: 25 },
    });

    const poolRes = await app.inject({ method: 'GET', url: '/api/events/current', headers: { 'x-telegram-init-data': memberInitData } });
    const found = poolRes.json().items.find((i: any) => i.id === item.lastInsertRowid);
    expect(found.winners).toEqual([{ telegramId: 2, nickname: 'Bob', quantity: 2 }]);
  });

  it('GET /events lists all events regardless of status, with item counts, admin-only', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент А' },
    });

    const forbidden = await app.inject({ method: 'GET', url: '/api/events', headers: { 'x-telegram-init-data': memberInitData } });
    expect(forbidden.statusCode).toBe(403);

    const res = await app.inject({ method: 'GET', url: '/api/events', headers: { 'x-telegram-init-data': adminInitData } });
    expect(res.json().events).toHaveLength(1);
    expect(res.json().events[0]).toMatchObject({ title: 'Ивент А', status: 'draft', itemCount: 0 });
  });

  it('GET /events/:id and /events/current list items red first, then purple, then blue', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент по цветам' },
    });
    const eventId = createRes.json().id;

    const screenshot = db
      .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
      .run(eventId, '/tmp/colors.png');

    const insertItem = db.prepare(
      "INSERT INTO items (event_id, screenshot_id, name, image_path, status, color) VALUES (?, ?, ?, 'items/x.png', 'pool', ?)"
    );
    for (const [name, color] of [
      ['Blue A', 'blue'],
      ['Red A', 'red'],
      ['Purple A', 'purple'],
      ['Blue B', 'blue'],
      ['Red B', 'red'],
    ] as const) {
      insertItem.run(eventId, screenshot.lastInsertRowid, name, color);
    }

    const adminRes = await app.inject({ method: 'GET', url: `/api/events/${eventId}`, headers: { 'x-telegram-init-data': adminInitData } });
    expect(adminRes.json().items.map((i: any) => i.color)).toEqual(['red', 'red', 'purple', 'blue', 'blue']);

    await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/start`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { durationMinutes: 25 },
    });

    const userRes = await app.inject({ method: 'GET', url: '/api/events/current', headers: { 'x-telegram-init-data': memberInitData } });
    expect(userRes.json().items.map((i: any) => i.color)).toEqual(['red', 'red', 'purple', 'blue', 'blue']);
  });

  it('GET /events/:id returns the event with its items, admin-only, at any status', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент' },
    });
    const eventId = createRes.json().id;

    const forbidden = await app.inject({ method: 'GET', url: `/api/events/${eventId}`, headers: { 'x-telegram-init-data': memberInitData } });
    expect(forbidden.statusCode).toBe(403);

    const res = await app.inject({ method: 'GET', url: `/api/events/${eventId}`, headers: { 'x-telegram-init-data': adminInitData } });
    expect(res.json().event.title).toBe('Ивент');
    expect(res.json().event.status).toBe('draft');
    expect(res.json().items).toEqual([]);
  });

  it('DELETE /events/:id removes the event, its screenshots, items and claims', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент' },
    });
    const eventId = createRes.json().id;
    const screenshot = db
      .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
      .run(eventId, '/tmp/original.png').lastInsertRowid as number;
    const itemId = db
      .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status) VALUES (?, ?, 'X', 'items/x.png', 'pool')")
      .run(eventId, screenshot).lastInsertRowid as number;
    db.prepare('INSERT INTO claims (item_id, telegram_id) VALUES (?, ?)').run(itemId, 2);

    const del = await app.inject({ method: 'DELETE', url: `/api/events/${eventId}`, headers: { 'x-telegram-init-data': adminInitData } });
    expect(del.statusCode).toBe(200);

    expect(db.prepare('SELECT * FROM events WHERE id = ?').get(eventId)).toBeUndefined();
    expect(db.prepare('SELECT * FROM items WHERE event_id = ?').get(eventId)).toBeUndefined();
    expect(db.prepare('SELECT * FROM screenshots WHERE event_id = ?').get(eventId)).toBeUndefined();
    expect(db.prepare('SELECT * FROM claims WHERE item_id = ?').get(itemId)).toBeUndefined();
  });

  it('DELETE /events/:id succeeds even when item_winners rows exist for its items', async () => {
    // item_winners is written by the random draw in POST /events/:id/finish (see
    // drawWinners), so a resolved event can have rows here. This confirms the delete's
    // item_winners cleanup still prevents the FK violation it was originally added to fix.
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Легаси' },
    });
    const eventId = createRes.json().id;
    const screenshot = db
      .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
      .run(eventId, '/tmp/legacy.png').lastInsertRowid as number;
    const itemId = db
      .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status) VALUES (?, ?, 'X', 'items/x.png', 'auctioned')")
      .run(eventId, screenshot).lastInsertRowid as number;
    db.prepare('INSERT INTO item_winners (item_id, telegram_id) VALUES (?, ?)').run(itemId, 2);

    const del = await app.inject({ method: 'DELETE', url: `/api/events/${eventId}`, headers: { 'x-telegram-init-data': adminInitData } });
    expect(del.statusCode).toBe(200);
    expect(db.prepare('SELECT * FROM item_winners WHERE item_id = ?').get(itemId)).toBeUndefined();
  });

  describe('POST /events/:id/finish draws feast winners', () => {
    let eventId: number;
    let carolInitData: string;

    beforeEach(async () => {
      carolInitData = signUserInitData(3, 'carol', botToken);
      approveTestUser(db, 3);
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/events',
        headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
        payload: { title: 'Пир' },
      });
      eventId = createRes.json().id;
      // Set straight to open rather than going through POST /start — /start's own
      // synchronized 10s pre-start countdown (starts_at) would otherwise reject claims
      // made immediately after it, which these tests don't care about.
      db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    });

    it('draws exactly one winner among several claimants for a quantity-1 lot', async () => {
      const screenshotId = db
        .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
        .run(eventId, '/tmp/o.png').lastInsertRowid as number;
      const itemId = db
        .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status) VALUES (?, ?, 'Меч', 'items/a.png', 'pool')")
        .run(eventId, screenshotId).lastInsertRowid as number;

      await app.inject({ method: 'POST', url: `/api/items/${itemId}/claim`, headers: { 'x-telegram-init-data': memberInitData } });
      await app.inject({ method: 'POST', url: `/api/items/${itemId}/claim`, headers: { 'x-telegram-init-data': carolInitData } });

      await app.inject({ method: 'POST', url: `/api/events/${eventId}/finish`, headers: { 'x-telegram-init-data': adminInitData } });

      const winners = db.prepare('SELECT telegram_id FROM item_winners WHERE item_id = ?').all(itemId) as { telegram_id: number }[];
      expect(winners).toHaveLength(1);
      expect([2, 3]).toContain(winners[0].telegram_id);
    });

    it('draws up to `quantity` distinct winners, never more than there are claimants', async () => {
      const screenshotId = db
        .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
        .run(eventId, '/tmp/o.png').lastInsertRowid as number;
      const itemId = db
        .prepare(
          "INSERT INTO items (event_id, screenshot_id, name, image_path, status, category, quantity) VALUES (?, ?, 'Камень', 'items/s.png', 'pool', 'stone', 5)"
        )
        .run(eventId, screenshotId).lastInsertRowid as number;

      await app.inject({ method: 'POST', url: `/api/items/${itemId}/claim`, headers: { 'x-telegram-init-data': memberInitData } });
      await app.inject({ method: 'POST', url: `/api/items/${itemId}/claim`, headers: { 'x-telegram-init-data': carolInitData } });

      await app.inject({ method: 'POST', url: `/api/events/${eventId}/finish`, headers: { 'x-telegram-init-data': adminInitData } });

      const winners = db.prepare('SELECT telegram_id FROM item_winners WHERE item_id = ?').all(itemId) as { telegram_id: number }[];
      expect(winners.map((w) => w.telegram_id).sort()).toEqual([2, 3]); // only 2 claimants, even though quantity is 5
    });

    it('keeps the item/stone mutual exclusion at draw time: gear and a temper stone never both go to the same person', async () => {
      const screenshotId = db
        .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
        .run(eventId, '/tmp/o.png').lastInsertRowid as number;
      const insertItem = db.prepare(
        "INSERT INTO items (event_id, screenshot_id, name, image_path, status, category) VALUES (?, ?, ?, 'items/x.png', 'pool', ?)"
      );
      const stoneA = insertItem.run(eventId, screenshotId, 'Камень А', 'stone_temper').lastInsertRowid as number;
      const gearA = insertItem.run(eventId, screenshotId, 'Меч А', 'item').lastInsertRowid as number;
      const gearB = insertItem.run(eventId, screenshotId, 'Меч Б', 'item').lastInsertRowid as number;

      // Bob is the sole claimant on all three. Gear's own category cap (2) alone would
      // still let him win both gear lots on top of the stone — only mutual exclusion
      // between the two categories keeps him from also winning the stone (or vice versa),
      // whichever kind the shuffle happens to resolve first.
      for (const itemId of [stoneA, gearA, gearB]) {
        await app.inject({ method: 'POST', url: `/api/items/${itemId}/claim`, headers: { 'x-telegram-init-data': memberInitData } });
      }
      await app.inject({ method: 'POST', url: `/api/events/${eventId}/finish`, headers: { 'x-telegram-init-data': adminInitData } });

      const bobWins = db
        .prepare(
          `SELECT i.category FROM item_winners w JOIN items i ON i.id = w.item_id WHERE w.telegram_id = 2`
        )
        .all() as { category: string }[];
      const categories = new Set(bobWins.map((w) => w.category));
      expect(categories.size).toBeLessThanOrEqual(1); // never both 'item' and 'stone_temper' at once
    });

    it('the two stone kinds are independent: winning a temper stone does not block winning a remelt stone too', async () => {
      const screenshotId = db
        .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
        .run(eventId, '/tmp/o.png').lastInsertRowid as number;
      const insertItem = db.prepare(
        "INSERT INTO items (event_id, screenshot_id, name, image_path, status, category) VALUES (?, ?, ?, 'items/x.png', 'pool', ?)"
      );
      const temperId = insertItem.run(eventId, screenshotId, 'Закалка', 'stone_temper').lastInsertRowid as number;
      const remeltId = insertItem.run(eventId, screenshotId, 'Переплавка', 'stone_remelt').lastInsertRowid as number;

      for (const itemId of [temperId, remeltId]) {
        await app.inject({ method: 'POST', url: `/api/items/${itemId}/claim`, headers: { 'x-telegram-init-data': memberInitData } });
      }
      await app.inject({ method: 'POST', url: `/api/events/${eventId}/finish`, headers: { 'x-telegram-init-data': adminInitData } });

      const bobWins = db.prepare('SELECT item_id FROM item_winners WHERE telegram_id = 2').all() as { item_id: number }[];
      expect(bobWins.map((w) => w.item_id).sort()).toEqual([temperId, remeltId].sort());
    });

    it("doesn't touch invasion lots — they already resolved instantly on claim", async () => {
      const screenshotId = db
        .prepare("INSERT INTO screenshots (event_id, original_path, rows, template, uploaded_by) VALUES (?, ?, 1, 'invasion', 1)")
        .run(eventId, '/tmp/inv.png').lastInsertRowid as number;
      const itemId = db
        .prepare(
          "INSERT INTO items (event_id, screenshot_id, name, image_path, status, color, quantity) VALUES (?, ?, 'Blue', 'items/x.png', 'pool', 'blue', 2)"
        )
        .run(eventId, screenshotId).lastInsertRowid as number;
      await app.inject({ method: 'POST', url: `/api/items/${itemId}/claim`, headers: { 'x-telegram-init-data': memberInitData } });

      await app.inject({ method: 'POST', url: `/api/events/${eventId}/finish`, headers: { 'x-telegram-init-data': adminInitData } });

      expect(db.prepare('SELECT COUNT(*) as n FROM item_winners WHERE item_id = ?').get(itemId)).toMatchObject({ n: 0 });
    });

    it('a lot nobody claimed stays unwon', async () => {
      const screenshotId = db
        .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
        .run(eventId, '/tmp/o.png').lastInsertRowid as number;
      const itemId = db
        .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status) VALUES (?, ?, 'Никто', 'items/a.png', 'pool')")
        .run(eventId, screenshotId).lastInsertRowid as number;

      await app.inject({ method: 'POST', url: `/api/events/${eventId}/finish`, headers: { 'x-telegram-init-data': adminInitData } });

      expect(db.prepare('SELECT COUNT(*) as n FROM item_winners WHERE item_id = ?').get(itemId)).toMatchObject({ n: 0 });
    });

    describe('remelt-stone bundle: winning a remelt lot also wins temper stones the same person claimed', () => {
      it('grants up to 2 temper stones from lots the remelt winner also claimed', async () => {
        const screenshotId = db
          .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
          .run(eventId, '/tmp/o.png').lastInsertRowid as number;
        const insertItem = db.prepare(
          "INSERT INTO items (event_id, screenshot_id, name, image_path, status, category) VALUES (?, ?, ?, 'items/x.png', 'pool', ?)"
        );
        const remeltId = insertItem.run(eventId, screenshotId, 'Улучшение', 'stone_remelt').lastInsertRowid as number;
        const temperAId = insertItem.run(eventId, screenshotId, 'Закалка А', 'stone_temper').lastInsertRowid as number;
        const temperBId = insertItem.run(eventId, screenshotId, 'Закалка Б', 'stone_temper').lastInsertRowid as number;

        // Bob is the sole claimant everywhere, so the draw itself can't be what hands him
        // all three — only the bundle rule explains winning both temper lots too.
        for (const itemId of [remeltId, temperAId, temperBId]) {
          await app.inject({ method: 'POST', url: `/api/items/${itemId}/claim`, headers: { 'x-telegram-init-data': memberInitData } });
        }
        await app.inject({ method: 'POST', url: `/api/events/${eventId}/finish`, headers: { 'x-telegram-init-data': adminInitData } });

        const bobWins = db.prepare('SELECT item_id FROM item_winners WHERE telegram_id = 2').all() as { item_id: number }[];
        expect(bobWins.map((w) => w.item_id).sort()).toEqual([remeltId, temperAId, temperBId].sort());
      });

      it("doesn't grant the bundle to someone who didn't claim any temper lot, and leaves that temper lot for its own claimant", async () => {
        const screenshotId = db
          .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
          .run(eventId, '/tmp/o.png').lastInsertRowid as number;
        const insertItem = db.prepare(
          "INSERT INTO items (event_id, screenshot_id, name, image_path, status, category) VALUES (?, ?, ?, 'items/x.png', 'pool', ?)"
        );
        const remeltId = insertItem.run(eventId, screenshotId, 'Улучшение', 'stone_remelt').lastInsertRowid as number;
        const temperId = insertItem.run(eventId, screenshotId, 'Закалка', 'stone_temper').lastInsertRowid as number;

        // Bob only wants the remelt stone; Carol only wants the temper one.
        await app.inject({ method: 'POST', url: `/api/items/${remeltId}/claim`, headers: { 'x-telegram-init-data': memberInitData } });
        await app.inject({ method: 'POST', url: `/api/items/${temperId}/claim`, headers: { 'x-telegram-init-data': carolInitData } });
        await app.inject({ method: 'POST', url: `/api/events/${eventId}/finish`, headers: { 'x-telegram-init-data': adminInitData } });

        const bobWins = db.prepare('SELECT item_id FROM item_winners WHERE telegram_id = 2').all() as { item_id: number }[];
        expect(bobWins.map((w) => w.item_id)).toEqual([remeltId]); // no bonus — he never claimed temper

        const carolWins = db.prepare('SELECT item_id FROM item_winners WHERE telegram_id = 3').all() as { item_id: number }[];
        expect(carolWins.map((w) => w.item_id)).toEqual([temperId]); // untouched by Bob's bundle
      });

      it('the bonus can push a person past the normal temper cap (3), but only by picking up their own leftover, never anyone else\'s', async () => {
        const screenshotId = db
          .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
          .run(eventId, '/tmp/o.png').lastInsertRowid as number;
        const insertItem = db.prepare(
          "INSERT INTO items (event_id, screenshot_id, name, image_path, status, category) VALUES (?, ?, ?, 'items/x.png', 'pool', ?)"
        );
        const remeltId = insertItem.run(eventId, screenshotId, 'Улучшение', 'stone_remelt').lastInsertRowid as number;
        const temperIds = ['А', 'Б', 'В', 'Г'].map((label) => insertItem.run(eventId, screenshotId, `Закалка ${label}`, 'stone_temper').lastInsertRowid as number);

        // Bob is the sole claimant on the remelt lot and all four (quantity-1) temper
        // lots. The fair draw alone caps him at 3 of the 4 temper lots — the 4th has
        // nobody else to give it to, so it's genuine leftover, not taken from anyone.
        // The bundle then picks that 4th one up too: 4 temper total, one more than the
        // normal cap, entirely from his own otherwise-unclaimed leftover.
        for (const itemId of [remeltId, ...temperIds]) {
          await app.inject({ method: 'POST', url: `/api/items/${itemId}/claim`, headers: { 'x-telegram-init-data': memberInitData } });
        }
        await app.inject({ method: 'POST', url: `/api/events/${eventId}/finish`, headers: { 'x-telegram-init-data': adminInitData } });

        const bobWins = db.prepare('SELECT item_id FROM item_winners WHERE telegram_id = 2').all() as { item_id: number }[];
        expect(bobWins.map((w) => w.item_id).sort()).toEqual([remeltId, ...temperIds].sort());
      });
    });
  });

  describe('GET /events/:id/results', () => {
    it('returns 404 for a nonexistent event', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/events/999999/results', headers: { 'x-telegram-init-data': memberInitData } });
      expect(res.statusCode).toBe(404);
    });

    it('lists everyone who entered, alphabetically, with an empty won list for a feast lot nobody drew', async () => {
      db.prepare("INSERT INTO users (telegram_id, username) VALUES (1, 'admin')").run();
      const carolInitData = signUserInitData(3, 'carol', botToken);
      approveTestUser(db, 3);
      db.prepare("UPDATE users SET game_nickname = 'Carol' WHERE telegram_id = 3").run();
      const eventId = db.prepare("INSERT INTO events (title, status) VALUES ('Пир', 'open')").run().lastInsertRowid as number;
      const screenshotId = db
        .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
        .run(eventId, '/tmp/o.png').lastInsertRowid as number;
      const itemId = db
        .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status) VALUES (?, ?, 'Меч', 'items/a.png', 'pool')")
        .run(eventId, screenshotId).lastInsertRowid as number;

      await app.inject({ method: 'POST', url: `/api/items/${itemId}/claim`, headers: { 'x-telegram-init-data': memberInitData } });
      await app.inject({ method: 'POST', url: `/api/items/${itemId}/claim`, headers: { 'x-telegram-init-data': carolInitData } });
      await app.inject({ method: 'POST', url: `/api/events/${eventId}/finish`, headers: { 'x-telegram-init-data': adminInitData } });

      const res = await app.inject({ method: 'GET', url: `/api/events/${eventId}/results`, headers: { 'x-telegram-init-data': memberInitData } });
      expect(res.statusCode).toBe(200);
      const results = res.json().results as { nickname: string | null; won: { name: string }[] }[];
      expect(results.map((r) => r.nickname).sort()).toEqual(['Bob', 'Carol']);

      const winner = results.find((r) => r.won.length > 0)!;
      const loser = results.find((r) => r.won.length === 0)!;
      expect(winner.won).toEqual([{ name: 'Меч', color: 'blue', imagePath: 'items/a.png', quantity: 1 }]);
      expect(loser.won).toEqual([]);
    });

    it("shows an invasion claim as already won — claiming there is winning, there's no separate draw", async () => {
      db.prepare("INSERT INTO users (telegram_id, username) VALUES (1, 'admin')").run();
      const eventId = db.prepare("INSERT INTO events (title, status) VALUES ('Вторжение', 'open')").run().lastInsertRowid as number;
      const screenshotId = db
        .prepare("INSERT INTO screenshots (event_id, original_path, rows, template, uploaded_by) VALUES (?, ?, 1, 'invasion', 1)")
        .run(eventId, '/tmp/inv.png').lastInsertRowid as number;
      const itemId = db
        .prepare(
          "INSERT INTO items (event_id, screenshot_id, name, image_path, status, color, quantity) VALUES (?, ?, 'Blue', 'items/x.png', 'pool', 'blue', 2)"
        )
        .run(eventId, screenshotId).lastInsertRowid as number;

      await app.inject({
        method: 'POST',
        url: `/api/items/${itemId}/claim`,
        headers: { 'x-telegram-init-data': memberInitData, 'content-type': 'application/json' },
        payload: { quantity: 2 },
      });

      const res = await app.inject({ method: 'GET', url: `/api/events/${eventId}/results`, headers: { 'x-telegram-init-data': memberInitData } });
      const results = res.json().results as { nickname: string | null; won: { name: string; quantity: number }[] }[];
      expect(results).toEqual([{ telegramId: 2, nickname: 'Bob', won: [{ name: 'Blue', color: 'blue', imagePath: 'items/x.png', quantity: 2 }] }]);
    });

    it('one person winning both a temper and a remelt stone shows up as a single row with both, not two rows', async () => {
      db.prepare("INSERT INTO users (telegram_id, username) VALUES (1, 'admin')").run();
      const eventId = db.prepare("INSERT INTO events (title, status) VALUES ('Пир', 'open')").run().lastInsertRowid as number;
      const screenshotId = db
        .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
        .run(eventId, '/tmp/o.png').lastInsertRowid as number;
      const insertItem = db.prepare(
        "INSERT INTO items (event_id, screenshot_id, name, image_path, status, category) VALUES (?, ?, ?, 'items/x.png', 'pool', ?)"
      );
      const temperId = insertItem.run(eventId, screenshotId, 'Закалка', 'stone_temper').lastInsertRowid as number;
      const remeltId = insertItem.run(eventId, screenshotId, 'Переплавка', 'stone_remelt').lastInsertRowid as number;

      for (const itemId of [temperId, remeltId]) {
        await app.inject({ method: 'POST', url: `/api/items/${itemId}/claim`, headers: { 'x-telegram-init-data': memberInitData } });
      }
      await app.inject({ method: 'POST', url: `/api/events/${eventId}/finish`, headers: { 'x-telegram-init-data': adminInitData } });

      const res = await app.inject({ method: 'GET', url: `/api/events/${eventId}/results`, headers: { 'x-telegram-init-data': memberInitData } });
      const results = res.json().results as { nickname: string | null; won: { name: string }[] }[];
      expect(results).toHaveLength(1); // one row for Bob, not two
      expect(results[0].won.map((w) => w.name).sort()).toEqual(['Закалка', 'Переплавка']);
    });
  });
});
