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
      .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
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

  it('respects per-color win limits when resolving multiple items for the same bidder', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент 2', durationMinutes: 25 },
    });
    const eventId = createRes.json().id;

    const screenshot = db
      .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
      .run(eventId, '/tmp/original2.png');

    const insertItem = db.prepare(
      "INSERT INTO items (event_id, screenshot_id, name, image_path, status, color) VALUES (?, ?, ?, 'items/x.png', 'pool', ?)"
    );
    const ids: number[] = [];
    for (const [name, color] of [
      ['Purple A', 'purple'],
      ['Purple B', 'purple'],
      ['Red A', 'red'],
      ['Blue A', 'blue'],
      ['Blue B', 'blue'],
      ['Blue C', 'blue'],
    ] as const) {
      const result = insertItem.run(eventId, screenshot.lastInsertRowid, name, color);
      ids.push(result.lastInsertRowid as number);
    }

    // Bob (telegram_id 2) is the sole bidder on every item.
    for (const itemId of ids) {
      db.prepare('INSERT INTO claims (item_id, telegram_id) VALUES (?, 2)').run(itemId);
    }

    const resolveRes = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/resolve`,
      headers: { 'x-telegram-init-data': adminInitData },
    });
    expect(resolveRes.statusCode).toBe(200);

    const rows = db
      .prepare('SELECT color, winner_telegram_id as winner, status FROM items WHERE event_id = ?')
      .all(eventId) as { color: string; winner: number | null; status: string }[];

    const purpleRedWins = rows.filter((r) => r.color !== 'blue' && r.winner === 2).length;
    const blueWins = rows.filter((r) => r.color === 'blue' && r.winner === 2).length;
    expect(purpleRedWins).toBe(1);
    expect(blueWins).toBe(2);

    const unresolvedCount = rows.filter((r) => r.status === 'pool').length;
    expect(unresolvedCount).toBe(3);
    expect(rows.filter((r) => r.status === 'auctioned')).toHaveLength(3);
  });

  it('falls back to an eligible second bidder once the first bidder is capped out on a color group', async () => {
    db.prepare("INSERT INTO users (telegram_id, username, game_nickname) VALUES (3, 'alice', 'Alice')").run();

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент 3', durationMinutes: 25 },
    });
    const eventId = createRes.json().id;

    const screenshot = db
      .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
      .run(eventId, '/tmp/original3.png');

    const insertItem = db.prepare(
      "INSERT INTO items (event_id, screenshot_id, name, image_path, status, color) VALUES (?, ?, ?, 'items/x.png', 'pool', 'purple')"
    );
    const ids: number[] = [];
    for (const name of ['Purple A', 'Purple B']) {
      const result = insertItem.run(eventId, screenshot.lastInsertRowid, name);
      ids.push(result.lastInsertRowid as number);
    }

    for (const itemId of ids) {
      db.prepare('INSERT INTO claims (item_id, telegram_id) VALUES (?, 2)').run(itemId);
      db.prepare('INSERT INTO claims (item_id, telegram_id) VALUES (?, 3)').run(itemId);
    }

    const resolveRes = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/resolve`,
      headers: { 'x-telegram-init-data': adminInitData },
    });
    expect(resolveRes.statusCode).toBe(200);

    const rows = db
      .prepare('SELECT winner_telegram_id as winner, status FROM items WHERE event_id = ?')
      .all(eventId) as { winner: number | null; status: string }[];

    expect(rows.every((r) => r.status === 'auctioned')).toBe(true);
    const winners = rows.map((r) => r.winner).sort();
    expect(winners).toEqual([2, 3]);
  });

  it('rejects resolving an already-resolved event and does not re-roll winners', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент 4', durationMinutes: 25 },
    });
    const eventId = createRes.json().id;

    const screenshot = db
      .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
      .run(eventId, '/tmp/original4.png');
    const item = db
      .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status) VALUES (?, ?, 'Меч', 'items/a.png', 'pool')")
      .run(eventId, screenshot.lastInsertRowid);
    db.prepare('INSERT INTO claims (item_id, telegram_id) VALUES (?, 2)').run(item.lastInsertRowid);

    const firstResolve = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/resolve`,
      headers: { 'x-telegram-init-data': adminInitData },
    });
    expect(firstResolve.statusCode).toBe(200);

    const afterFirst = db
      .prepare('SELECT winner_telegram_id as winner, status FROM items WHERE id = ?')
      .get(item.lastInsertRowid) as { winner: number | null; status: string };
    expect(afterFirst.status).toBe('auctioned');
    expect(afterFirst.winner).toBe(2);

    const secondResolve = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/resolve`,
      headers: { 'x-telegram-init-data': adminInitData },
    });
    expect(secondResolve.statusCode).toBe(409);

    const afterSecond = db
      .prepare('SELECT winner_telegram_id as winner, status FROM items WHERE id = ?')
      .get(item.lastInsertRowid) as { winner: number | null; status: string };
    expect(afterSecond).toEqual(afterFirst);
  });

  it('GET /events lists all events with item counts, admin-only', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент А', durationMinutes: 25 },
    });

    const forbidden = await app.inject({ method: 'GET', url: '/api/events', headers: { 'x-telegram-init-data': memberInitData } });
    expect(forbidden.statusCode).toBe(403);

    const res = await app.inject({ method: 'GET', url: '/api/events', headers: { 'x-telegram-init-data': adminInitData } });
    expect(res.json().events).toHaveLength(1);
    expect(res.json().events[0]).toMatchObject({ title: 'Ивент А', itemCount: 0 });
  });

  it('GET /events/:id returns the event with its items, admin-only', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент', durationMinutes: 25 },
    });
    const eventId = createRes.json().id;

    const forbidden = await app.inject({ method: 'GET', url: `/api/events/${eventId}`, headers: { 'x-telegram-init-data': memberInitData } });
    expect(forbidden.statusCode).toBe(403);

    const res = await app.inject({ method: 'GET', url: `/api/events/${eventId}`, headers: { 'x-telegram-init-data': adminInitData } });
    expect(res.json().event.title).toBe('Ивент');
    expect(res.json().items).toEqual([]);
  });

  it('DELETE /events/:id removes the event, its screenshots, items and claims', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент', durationMinutes: 25 },
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
});
