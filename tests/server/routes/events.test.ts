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
    expect(claimed.winners).toEqual([{ telegramId: 2, nickname: 'Bob' }]);

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

    const rows = db.prepare('SELECT id, color, status FROM items WHERE event_id = ?').all(eventId) as {
      id: number;
      color: string;
      status: string;
    }[];
    const wonItemIds = new Set(
      (db.prepare('SELECT item_id FROM item_winners WHERE telegram_id = 2').all() as { item_id: number }[]).map(
        (r) => r.item_id
      )
    );

    const purpleRedWins = rows.filter((r) => r.color !== 'blue' && wonItemIds.has(r.id)).length;
    const blueWins = rows.filter((r) => r.color === 'blue' && wonItemIds.has(r.id)).length;
    expect(purpleRedWins).toBe(1);
    expect(blueWins).toBe(2);

    const unresolvedCount = rows.filter((r) => r.status === 'pool').length;
    expect(unresolvedCount).toBe(3);
    expect(rows.filter((r) => r.status === 'auctioned')).toHaveLength(3);
  });

  it('draws up to quantity distinct winners for a single lot from everyone who bid on it', async () => {
    db.prepare("INSERT INTO users (telegram_id, username, game_nickname) VALUES (3, 'alice', 'Alice')").run();
    db.prepare("INSERT INTO users (telegram_id, username, game_nickname) VALUES (4, 'carl', 'Carl')").run();

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { title: 'Ивент qty', durationMinutes: 25 },
    });
    const eventId = createRes.json().id;

    const screenshot = db
      .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (?, ?, 1, 1)')
      .run(eventId, '/tmp/original-qty.png');
    const item = db
      .prepare(
        "INSERT INTO items (event_id, screenshot_id, name, image_path, status, color, quantity) VALUES (?, ?, 'Орк-шаман', 'items/x.png', 'pool', 'blue', 2)"
      )
      .run(eventId, screenshot.lastInsertRowid);
    const itemId = item.lastInsertRowid as number;

    // 3 bidders (one bid each, per-item claim) for a lot that only has 2 to give away.
    for (const telegramId of [2, 3, 4]) {
      db.prepare('INSERT INTO claims (item_id, telegram_id) VALUES (?, ?)').run(itemId, telegramId);
    }

    const resolveRes = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/resolve`,
      headers: { 'x-telegram-init-data': adminInitData },
    });
    expect(resolveRes.statusCode).toBe(200);

    const winners = db.prepare('SELECT telegram_id FROM item_winners WHERE item_id = ?').all(itemId) as {
      telegram_id: number;
    }[];
    // Exactly 2 distinct winners, both from among the 3 bidders — never more than
    // quantity, and never the same person twice (each bidder has only one claim row).
    expect(winners).toHaveLength(2);
    expect(new Set(winners.map((w) => w.telegram_id)).size).toBe(2);
    for (const w of winners) expect([2, 3, 4]).toContain(w.telegram_id);

    const row = db.prepare('SELECT status FROM items WHERE id = ?').get(itemId) as { status: string };
    expect(row.status).toBe('auctioned');
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

    const rows = db.prepare('SELECT id, status FROM items WHERE event_id = ?').all(eventId) as {
      id: number;
      status: string;
    }[];
    expect(rows.every((r) => r.status === 'auctioned')).toBe(true);

    const winners = (db.prepare('SELECT telegram_id FROM item_winners WHERE item_id IN (?, ?)').all(rows[0].id, rows[1].id) as {
      telegram_id: number;
    }[])
      .map((r) => r.telegram_id)
      .sort();
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

    const afterFirst = db.prepare('SELECT status FROM items WHERE id = ?').get(item.lastInsertRowid) as {
      status: string;
    };
    const winnersAfterFirst = db.prepare('SELECT telegram_id FROM item_winners WHERE item_id = ?').all(item.lastInsertRowid);
    expect(afterFirst.status).toBe('auctioned');
    expect(winnersAfterFirst).toEqual([{ telegram_id: 2 }]);

    const secondResolve = await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/resolve`,
      headers: { 'x-telegram-init-data': adminInitData },
    });
    expect(secondResolve.statusCode).toBe(409);

    const afterSecond = db.prepare('SELECT status FROM items WHERE id = ?').get(item.lastInsertRowid) as {
      status: string;
    };
    const winnersAfterSecond = db.prepare('SELECT telegram_id FROM item_winners WHERE item_id = ?').all(item.lastInsertRowid);
    expect(afterSecond).toEqual(afterFirst);
    expect(winnersAfterSecond).toEqual(winnersAfterFirst);
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
