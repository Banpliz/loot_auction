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
    expect(res.json()).toEqual({ event: null, items: [] });
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

  it('claimed items show up in the winners list once sold out; unclaimed items stay in the pool', async () => {
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
    // Seeded directly (status/quantity/claims all set by hand) rather than via
    // POST /items/:id/claim — the claim endpoint's own quantity-decrement and
    // status-flip-to-auctioned behavior belongs to Task 3, not this task. This test only
    // verifies that GET /events/current's winners list reads from claims (this task's
    // attachWinners rewrite), independent of whichever later task produces that state.
    const claimedItem = db
      .prepare(
        "INSERT INTO items (event_id, screenshot_id, name, image_path, status, quantity) VALUES (?, ?, 'Меч', 'items/a.png', 'auctioned', 0)"
      )
      .run(eventId, screenshot.lastInsertRowid);
    const unclaimedItem = db
      .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status) VALUES (?, ?, 'Щит', 'items/b.png', 'pool')")
      .run(eventId, screenshot.lastInsertRowid);
    db.prepare('INSERT INTO claims (item_id, telegram_id) VALUES (?, 2)').run(claimedItem.lastInsertRowid);

    await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/start`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { durationMinutes: 25 },
    });

    const poolRes = await app.inject({ method: 'GET', url: '/api/events/current', headers: { 'x-telegram-init-data': memberInitData } });
    const body = poolRes.json();

    const claimed = body.items.find((i: any) => i.id === claimedItem.lastInsertRowid);
    expect(claimed.status).toBe('auctioned');
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

  it('winners list reports how many units a claim reserved', async () => {
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

  it('DELETE /events/:id succeeds even when legacy item_winners rows exist for its items', async () => {
    // item_winners is no longer written to by any live endpoint (see design doc), but the
    // table is deliberately kept in the schema rather than dropped, so a row from before
    // this change could still be sitting there. This simulates that with a direct insert
    // and confirms the delete's existing item_winners cleanup still prevents the FK
    // violation it was originally added to fix.
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
});
