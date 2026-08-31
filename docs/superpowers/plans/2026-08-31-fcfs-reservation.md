# FCFS Reservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the claim-then-random-draw mechanic with first-come-first-served reservation — clicking "Ставка" immediately reserves one unit and decrements stock, a sold-out lot goes gray and locks, and lots stay hidden from users until the admin explicitly starts the auction.

**Architecture:** Add a `draft` state to `events.status` (new: `draft → open → resolved`, `draft` is invisible to users and the only state admin edits are allowed in). Rewrite `POST /items/:id/claim` and `DELETE /items/:id/claim` to mutate `items.quantity`/`status` directly and enforce the existing per-person win-limit rule (`winLimitGroup`) synchronously per claim instead of once at draw time. Delete the random-draw endpoint; `src/server/random.ts` itself is untouched, just unused. `item_winners` stays in the schema (legacy data safety) but stops being read or written — winner/claimant display switches to reading `claims` directly, since under FCFS "claimed it" and "has it" are the same thing.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, vanilla-TS/Vite frontend (no frontend test infra — verify UI tasks with `tsc --noEmit` + manual smoke test).

**Spec:** [docs/superpowers/specs/2026-08-31-fcfs-reservation-design.md](../specs/2026-08-31-fcfs-reservation-design.md)

## Global Constraints

- No UI/visual redesign — every frontend change reuses an existing CSS class or component (`.status-pill`, `.badge`, `.winners`/`<details>`, `.qty-tag`, `.admin-item`, `.lot-row`, `.btn-block`). No new class is added to `web/style.css` (spec: Non-goals, UI changes).
- `item_winners` is never migrated or dropped — it just stops being written/read. `DELETE /events/:id` keeps cleaning it up, since `better-sqlite3` runs with `PRAGMA foreign_keys = 1` and old rows would otherwise break that delete (spec: Non-goals, Winners display).
- `src/server/random.ts` is not modified or deleted — it just loses its only caller (spec: Purpose).
- No auto-transition of `events.status` on deadline expiry — `POST /events/:id/finish` is the only thing that moves `open → resolved`; passing the deadline only blocks claim/unclaim via the existing `isPastDeadline` check (spec: Non-goals).
- No minimum-lots-before-start guard and no "unstart"/back-to-draft action (spec: Non-goals).
- Editing (screenshot upload, item edit/remove/merge) is rejected with 409 once the owning event's `status != 'draft'` (spec: Event lifecycle).
- The win-limit rule itself is unchanged: invasion caps purple+red combined at 1 win/person/event and blue at 2; feast caps gear (`category='item'`) at 1 and tempering stones (`category='stone'`) at 3, and the two feast groups are mutually exclusive (spec: Reservation mechanic, `winLimitGroup`).

---

## File Structure

No new files. Modified:

```
src/server/routes/events.ts       — event lifecycle (draft/start/finish), attachWinners via claims
src/server/routes/items.ts        — draft-lock on edit endpoints, FCFS claim/unclaim rewrite
src/server/routes/screenshots.ts  — draft-lock on upload endpoint
web/views/admin.ts                — create form drops duration, draft status label
web/views/eventDetail.ts          — draft/open/resolved branching, start/finish buttons
web/views/pool.ts                 — sold-out gray styling, "Забрали" label
docs/HANDOFF.md                   — status notes updated for the new mechanic
tests/server/routes/events.test.ts
tests/server/routes/items.test.ts
tests/server/routes/screenshots.test.ts
```

Untouched (confirmed during design): `src/server/db.ts` (no schema change — `draft` is just a new string value in the existing `status TEXT` column, `deadline_at` already nullable), `src/server/random.ts`, `web/style.css`.

---

### Task 1: Event lifecycle — draft, start, finish

**Files:**
- Modify: `src/server/routes/events.ts`
- Modify: `tests/server/routes/events.test.ts`

**Interfaces:**
- Consumes: `AppDeps` (`src/server/types.ts`), `requireAdmin` (`src/server/auth.ts`) — both unchanged.
- Produces: `export function winLimitGroup(template: string, color: string, category: string): { key: string; limit: number; exclusiveWith?: string }` — Task 3's claim endpoint imports this. `POST /events` now returns `{ id, title, status: 'draft' }` (no `deadlineAt`). `POST /events/:id/start` and `POST /events/:id/finish` are new endpoints later tasks' UI work (Task 5) calls.

- [ ] **Step 1: Rewrite the event-lifecycle tests in `tests/server/routes/events.test.ts`**

Replace the whole file with:

```typescript
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
    db.prepare("INSERT INTO users (telegram_id, username, game_nickname) VALUES (2, 'bob', 'Bob')").run();
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
    const claimedItem = db
      .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status) VALUES (?, ?, 'Меч', 'items/a.png', 'pool')")
      .run(eventId, screenshot.lastInsertRowid);
    const unclaimedItem = db
      .prepare("INSERT INTO items (event_id, screenshot_id, name, image_path, status) VALUES (?, ?, 'Щит', 'items/b.png', 'pool')")
      .run(eventId, screenshot.lastInsertRowid);

    await app.inject({
      method: 'POST',
      url: `/api/events/${eventId}/start`,
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { durationMinutes: 25 },
    });
    await app.inject({
      method: 'POST',
      url: `/api/items/${claimedItem.lastInsertRowid}/claim`,
      headers: { 'x-telegram-init-data': memberInitData },
    });

    const poolRes = await app.inject({ method: 'GET', url: '/api/events/current', headers: { 'x-telegram-init-data': memberInitData } });
    const body = poolRes.json();

    const claimed = body.items.find((i: any) => i.id === claimedItem.lastInsertRowid);
    expect(claimed.status).toBe('auctioned');
    expect(claimed.winners).toEqual([{ telegramId: 2, nickname: 'Bob' }]);

    const unclaimed = body.items.find((i: any) => i.id === unclaimedItem.lastInsertRowid);
    expect(unclaimed.status).toBe('pool');
    expect(unclaimed.winners).toEqual([]);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/server/routes/events.test.ts`
Expected: FAIL — `POST /events` still requires/reads `durationMinutes` and sets `status='open'` directly, `/events/:id/start` and `/events/:id/finish` don't exist yet (404s), `GET /events/current` doesn't filter out drafts, `attachWinners` still reads `item_winners` instead of `claims`.

- [ ] **Step 3: Rewrite `src/server/routes/events.ts`**

Replace the whole file with:

```typescript
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';

interface EventRow {
  id: number;
  title: string;
  deadline_at: string | null;
  status: string;
}

type ColorGroup = 'purpleRed' | 'blue';
type CategoryGroup = 'item' | 'stone';

// Fixed by design, not admin-configurable. Invasion caps by rarity color (purple+red
// combined 1 win/person/event, blue 2). Feast's alliance rule cuts across colors instead
// — gear (armor/weapons/etc.) capped at 1, tempering stones at 3 — so it's grouped by
// admin-set item.category rather than color. The two feast groups are also mutually
// exclusive (2026-08-28): winning a stone rules a person out of ever winning gear in the
// same event, and vice versa. Originally enforced once at the end-of-event draw; now
// enforced by items.ts's claim endpoint on every single claim attempt (2026-08-31), since
// there's no more draw step — see docs/superpowers/specs/2026-08-31-fcfs-reservation-design.md.
const COLOR_WIN_LIMITS: Record<ColorGroup, number> = { purpleRed: 1, blue: 2 };
const CATEGORY_WIN_LIMITS: Record<CategoryGroup, number> = { item: 1, stone: 3 };

function colorGroup(color: string): ColorGroup {
  return color === 'blue' ? 'blue' : 'purpleRed';
}

// Returns a per-person counter key (namespaced so a color group and a category group
// can never collide), the cap that applies to it, and — for feast only — the other
// category's key: any existing win there makes a person ineligible for this one too.
// Exported for items.ts's claim endpoint, which is now the sole caller of this rule.
export function winLimitGroup(template: string, color: string, category: string): { key: string; limit: number; exclusiveWith?: string } {
  if (template === 'feast') {
    const group: CategoryGroup = category === 'stone' ? 'stone' : 'item';
    const other: CategoryGroup = group === 'stone' ? 'item' : 'stone';
    return { key: `cat:${group}`, limit: CATEGORY_WIN_LIMITS[group], exclusiveWith: `cat:${other}` };
  }
  const group = colorGroup(color);
  return { key: `color:${group}`, limit: COLOR_WIN_LIMITS[group] };
}

const ITEM_COLUMNS = `i.id, i.name, i.color, i.category, i.quantity, i.image_path as imagePath, i.status`;

// Rarest-looking first: red, then purple, then blue — matches the in-game rarity
// order, not insertion order.
const COLOR_ORDER_SQL = `CASE i.color WHEN 'red' THEN 0 WHEN 'purple' THEN 1 WHEN 'blue' THEN 2 ELSE 3 END`;

interface Winner {
  telegramId: number;
  nickname: string | null;
}

// Attaches a `winners` array to each item — one entry per person currently holding a
// unit of it. Reads `claims` directly (not the old `item_winners` draw ledger): under
// first-come-first-served reservation, "claimed a unit" and "has a unit" are the same
// thing by construction, so there's nothing left for a separate winners table to record.
function attachWinners<T extends { id: number }>(deps: AppDeps, items: T[]): (T & { winners: Winner[] })[] {
  if (items.length === 0) return [];
  const placeholders = items.map(() => '?').join(',');
  const rows = deps.db
    .prepare(
      `SELECT c.item_id as itemId, u.telegram_id as telegramId, u.game_nickname as nickname
       FROM claims c
       LEFT JOIN users u ON u.telegram_id = c.telegram_id
       WHERE c.item_id IN (${placeholders})`
    )
    .all(...items.map((i) => i.id)) as { itemId: number; telegramId: number; nickname: string | null }[];

  const winnersByItem = new Map<number, Winner[]>();
  for (const row of rows) {
    const list = winnersByItem.get(row.itemId) ?? [];
    list.push({ telegramId: row.telegramId, nickname: row.nickname });
    winnersByItem.set(row.itemId, list);
  }
  return items.map((item) => ({ ...item, winners: winnersByItem.get(item.id) ?? [] }));
}

export function registerEventRoutes(app: FastifyInstance, deps: AppDeps) {
  app.post<{ Body: { title: string } }>(
    '/events',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const title = request.body?.title?.trim();
      if (!title) {
        reply.code(400).send({ error: 'title is required' });
        return;
      }

      const result = deps.db.prepare("INSERT INTO events (title, status) VALUES (?, 'draft')").run(title);
      return { id: result.lastInsertRowid, title, status: 'draft' };
    }
  );

  app.get('/events', { preHandler: requireAdmin(deps) }, async () => {
    const events = deps.db
      .prepare(
        `SELECT e.id, e.title, e.deadline_at as deadlineAt, e.status,
                (SELECT COUNT(*) FROM items i WHERE i.event_id = e.id AND i.status != 'removed') as itemCount
         FROM events e
         ORDER BY e.id DESC`
      )
      .all();
    return { events };
  });

  app.delete<{ Params: { id: string } }>('/events/:id', { preHandler: requireAdmin(deps) }, async (request) => {
    const eventId = Number(request.params.id);
    const deleteEvent = deps.db.transaction(() => {
      deps.db
        .prepare('DELETE FROM claims WHERE item_id IN (SELECT id FROM items WHERE event_id = ?)')
        .run(eventId);
      deps.db
        .prepare('DELETE FROM item_winners WHERE item_id IN (SELECT id FROM items WHERE event_id = ?)')
        .run(eventId);
      deps.db.prepare('DELETE FROM items WHERE event_id = ?').run(eventId);
      deps.db.prepare('DELETE FROM screenshots WHERE event_id = ?').run(eventId);
      deps.db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
    });
    deleteEvent();
    // ponytail: uploaded image files are left on disk; add a cleanup pass if disk usage becomes a problem.
    return { ok: true };
  });

  app.get('/events/current', async (request) => {
    // Draft events are excluded — an admin mid-upload/edit must not leak lots to users,
    // and (just as important) must not hide whatever event users were previously looking
    // at while the admin works on the next one.
    const event = deps.db.prepare("SELECT * FROM events WHERE status != 'draft' ORDER BY id DESC LIMIT 1").get() as
      | EventRow
      | undefined;
    if (!event) return { event: null, items: [] };

    const userId = request.telegramUser!.telegramId;
    const items = deps.db
      .prepare(
        `SELECT ${ITEM_COLUMNS},
                EXISTS(SELECT 1 FROM claims c WHERE c.item_id = i.id AND c.telegram_id = ?) as claimedByMe
         FROM items i
         WHERE i.event_id = ? AND i.status != 'removed'
         ORDER BY ${COLOR_ORDER_SQL}, i.id`
      )
      .all(userId, event.id) as { id: number }[];

    return {
      event: { id: event.id, title: event.title, deadlineAt: event.deadline_at, status: event.status },
      items: attachWinners(deps, items),
    };
  });

  app.get<{ Params: { id: string } }>('/events/:id', { preHandler: requireAdmin(deps) }, async (request, reply) => {
    const eventId = Number(request.params.id);
    const event = deps.db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as EventRow | undefined;
    if (!event) {
      reply.code(404).send({ error: 'event not found' });
      return;
    }
    const items = deps.db
      .prepare(
        `SELECT ${ITEM_COLUMNS}
         FROM items i
         WHERE i.event_id = ? AND i.status != 'removed'
         ORDER BY ${COLOR_ORDER_SQL}, i.id`
      )
      .all(eventId) as { id: number }[];

    return {
      event: { id: event.id, title: event.title, deadlineAt: event.deadline_at, status: event.status },
      items: attachWinners(deps, items),
    };
  });

  app.post<{ Params: { id: string }; Body: { durationMinutes?: number } }>(
    '/events/:id/start',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const eventId = Number(request.params.id);
      const durationMinutes = request.body?.durationMinutes;
      if (!Number.isFinite(durationMinutes) || (durationMinutes as number) <= 0) {
        reply.code(400).send({ error: 'durationMinutes must be a positive number' });
        return;
      }

      const event = deps.db.prepare('SELECT status FROM events WHERE id = ?').get(eventId) as { status: string } | undefined;
      if (!event) {
        reply.code(404).send({ error: 'event not found' });
        return;
      }
      if (event.status !== 'draft') {
        reply.code(409).send({ error: 'event has already started' });
        return;
      }

      const deadlineAt = new Date(Date.now() + (durationMinutes as number) * 60_000).toISOString();
      deps.db.prepare("UPDATE events SET status = 'open', deadline_at = ? WHERE id = ?").run(deadlineAt, eventId);
      return { ok: true, deadlineAt };
    }
  );

  app.post<{ Params: { id: string } }>(
    '/events/:id/finish',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const eventId = Number(request.params.id);
      const event = deps.db.prepare('SELECT status, deadline_at FROM events WHERE id = ?').get(eventId) as
        | { status: string; deadline_at: string | null }
        | undefined;
      if (!event) {
        reply.code(404).send({ error: 'event not found' });
        return;
      }
      if (event.status !== 'open') {
        reply.code(409).send({ error: 'event is not open' });
        return;
      }

      // Only force the deadline into the past if it isn't already there — an admin
      // finishing after the countdown already ran out shouldn't have the recorded
      // deadline jump forward to "now".
      const alreadyPast = !!event.deadline_at && new Date(event.deadline_at).getTime() < Date.now();
      const deadlineAt = alreadyPast ? (event.deadline_at as string) : new Date().toISOString();
      deps.db.prepare("UPDATE events SET status = 'resolved', deadline_at = ? WHERE id = ?").run(deadlineAt, eventId);
      return { ok: true };
    }
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/server/routes/events.test.ts`
Expected: PASS

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (this will still show errors from `items.ts`/`screenshots.ts` referencing the old resolve-era shapes if Task 2/3 haven't run yet in a from-scratch checkout — for this task alone, `events.ts` itself must compile clean; unrelated pre-existing files are addressed in their own tasks)

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/events.ts tests/server/routes/events.test.ts
git commit -m "$(cat <<'EOF'
Add draft/start/finish event lifecycle, drop the random-draw endpoint

Events now start in draft (invisible to users, editable) and move to
open via POST /events/:id/start, which is when the deadline timer
begins. POST /events/:id/resolve is gone along with the random draw
it ran; winners display now reads straight from claims instead of the
item_winners table the draw used to populate.
EOF
)"
```

---

### Task 2: Draft-only edit lock

**Files:**
- Modify: `src/server/routes/items.ts`
- Modify: `src/server/routes/screenshots.ts`
- Modify: `tests/server/routes/items.test.ts`
- Modify: `tests/server/routes/screenshots.test.ts`

**Interfaces:**
- Consumes: nothing new from Task 1 (this task only needs `events.status`, already available via plain SQL).
- Produces: `export function isEventDraft(deps: AppDeps, eventId: number): boolean` in `items.ts`, imported by `screenshots.ts`. Task 3's claim/unclaim rewrite touches the same two files but a different pair of routes (`claim`/`unclaim`, not `PUT`/`DELETE`/`merge`) — no overlap.

- [ ] **Step 1: Update the shared event fixture and add draft-lock tests in `tests/server/routes/items.test.ts`**

Change the `beforeEach` event creation from `'open'` to `'draft'` (every existing `PUT`/`DELETE`/`merge` test needs a draft event now that editing is draft-only), and add new tests that lock editing once the event is open:

```typescript
    eventId = db.prepare("INSERT INTO events (title, status) VALUES ('Ивент', 'draft')").run().lastInsertRowid as number;
```

Then, at the end of the `describe('items routes', ...)` block, right before its closing `});`, add:

```typescript
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
```

Now find the existing `'POST /items/:id/merge folds the source lot into the target and carries its bidders over'` and `'POST /items/:id/merge dedupes a bidder who had claimed both lots'` tests. Both rely on claiming an item before merging it — but claiming now requires an `open` event and merging now requires a `draft` one, so that combination can no longer happen (a lot can never already have a claimant while it's still mergeable). Delete both tests and replace them with:

```typescript
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
```

- [ ] **Step 2: Add a draft-lock test to `tests/server/routes/screenshots.test.ts`**

At the end of the `describe('POST /api/events/:id/screenshots', ...)` block, right before its closing `});`, add:

```typescript
  it('rejects uploading once the event is no longer draft', async () => {
    const createEventRes = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
      body: JSON.stringify({ title: 'Ивент' }),
    });
    const { id: eventId } = await createEventRes.json();
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);

    const imageBuffer = await sharp({
      create: { width: 300, height: 120, channels: 3, background: { r: 209, g: 67, b: 78 } },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append('rows', '1');
    form.append('template', 'feast');
    form.append('file', new Blob([imageBuffer], { type: 'image/png' }), 'reward.png');

    const res = await fetch(`${baseUrl}/api/events/${eventId}/screenshots`, {
      method: 'POST',
      headers: { 'x-telegram-init-data': adminInitData },
      body: form,
    });
    expect(res.status).toBe(409);
  });
```

- [ ] **Step 3: Run the tests to verify the new/changed ones fail**

Run: `npx vitest run tests/server/routes/items.test.ts tests/server/routes/screenshots.test.ts`
Expected: FAIL — the three new draft-lock tests get 200 instead of 409 (no lock exists yet); the rewritten merge test is unaffected either way since it doesn't touch claims (should already pass, confirming it's not a false-positive win); the upload draft-lock test gets 200 instead of 409.

- [ ] **Step 4: Add the draft-lock helper and checks to `src/server/routes/items.ts`**

Add this helper near the top of the file, after the `VALID_CATEGORIES` constant and before `isPastDeadline`:

```typescript
// Editing (name/color/category/quantity, remove, merge) is only allowed while the event
// is still in draft. Once it's open, users may already be looking at (or claiming) these
// exact lots, so admin edits are locked to avoid changing what someone already claimed
// out from under them — see docs/superpowers/specs/2026-08-31-fcfs-reservation-design.md.
export function isEventDraft(deps: AppDeps, eventId: number): boolean {
  const event = deps.db.prepare('SELECT status FROM events WHERE id = ?').get(eventId) as { status: string } | undefined;
  return event?.status === 'draft';
}

function itemEventId(deps: AppDeps, itemId: number): number | undefined {
  const row = deps.db.prepare('SELECT event_id FROM items WHERE id = ?').get(itemId) as { event_id: number } | undefined;
  return row?.event_id;
}
```

Then in the `PUT /items/:id` handler, replace:

```typescript
    async (request, reply) => {
      const { name, color, category, quantity } = request.body ?? {};
```

with:

```typescript
    async (request, reply) => {
      const itemId = Number(request.params.id);
      const eventId = itemEventId(deps, itemId);
      if (eventId === undefined || !isEventDraft(deps, eventId)) {
        reply.code(409).send({ error: 'event is not in draft' });
        return;
      }

      const { name, color, category, quantity } = request.body ?? {};
```

and remove the now-duplicate `const itemId = Number(request.params.id);` line further down (right before `values.push(itemId);` — that line itself stays, only the `const itemId = ...` declaration above it is deleted since `itemId` is now already in scope from the top of the handler).

In the `DELETE /items/:id` handler, replace:

```typescript
  app.delete<{ Params: { id: string } }>('/items/:id', { preHandler: requireAdmin(deps) }, async (request) => {
    deps.db.prepare("UPDATE items SET status = 'removed' WHERE id = ?").run(Number(request.params.id));
    return { ok: true };
  });
```

with:

```typescript
  app.delete<{ Params: { id: string } }>('/items/:id', { preHandler: requireAdmin(deps) }, async (request, reply) => {
    const itemId = Number(request.params.id);
    const eventId = itemEventId(deps, itemId);
    if (eventId === undefined || !isEventDraft(deps, eventId)) {
      reply.code(409).send({ error: 'event is not in draft' });
      return;
    }
    deps.db.prepare("UPDATE items SET status = 'removed' WHERE id = ?").run(itemId);
    return { ok: true };
  });
```

In the `POST /items/:id/merge` handler, update the doc comment and insert the draft-lock check, and drop the now-dead claim-carrying step. Replace:

```typescript
  // Manual escape hatch for icon-dedup misses across separate screenshot uploads
  // (see dedup.ts) — admin folds a duplicate lot into another by hand instead of
  // relying on the pixel-signature threshold, which can't reliably tell "same
  // item, different photo" from "different item" at the margin observed in
  // practice. Source's bidders carry over (deduped, a claimant on both keeps
  // one bid) and it's soft-removed rather than merging its own quantity twice.
  app.post<{ Params: { id: string }; Body: { intoId?: number } }>(
    '/items/:id/merge',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const sourceId = Number(request.params.id);
      const targetId = Number(request.body?.intoId);
      if (!Number.isInteger(targetId)) {
        reply.code(400).send({ error: 'intoId is required' });
        return;
      }
      if (sourceId === targetId) {
        reply.code(400).send({ error: 'cannot merge an item into itself' });
        return;
      }

      const source = deps.db.prepare('SELECT event_id, status, quantity FROM items WHERE id = ?').get(sourceId) as
        | { event_id: number; status: string; quantity: number }
        | undefined;
      const target = deps.db.prepare('SELECT event_id, status FROM items WHERE id = ?').get(targetId) as
        | { event_id: number; status: string }
        | undefined;
      if (!source || !target) {
        reply.code(404).send({ error: 'item not found' });
        return;
      }
      if (source.event_id !== target.event_id) {
        reply.code(400).send({ error: 'items belong to different events' });
        return;
      }
      if (source.status !== 'pool' || target.status !== 'pool') {
        reply.code(409).send({ error: 'both lots must still be in the pool' });
        return;
      }

      const mergeItems = deps.db.transaction(() => {
        deps.db
          .prepare('INSERT OR IGNORE INTO claims (item_id, telegram_id) SELECT ?, telegram_id FROM claims WHERE item_id = ?')
          .run(targetId, sourceId);
        deps.db.prepare('DELETE FROM claims WHERE item_id = ?').run(sourceId);
        deps.db.prepare('UPDATE items SET quantity = quantity + ? WHERE id = ?').run(source.quantity, targetId);
        deps.db.prepare("UPDATE items SET status = 'removed' WHERE id = ?").run(sourceId);
      });
      mergeItems();

      return { ok: true };
    }
  );
```

with:

```typescript
  // Manual escape hatch for icon-dedup misses across separate screenshot uploads
  // (see dedup.ts) — admin folds a duplicate lot into another by hand instead of
  // relying on the pixel-signature threshold, which can't reliably tell "same
  // item, different photo" from "different item" at the margin observed in
  // practice. Draft-only (see isEventDraft) — and since claiming requires an open
  // event, a draft-time lot can never already have claimants, so merging never
  // needs to carry bids over the way it used to.
  app.post<{ Params: { id: string }; Body: { intoId?: number } }>(
    '/items/:id/merge',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const sourceId = Number(request.params.id);
      const targetId = Number(request.body?.intoId);
      if (!Number.isInteger(targetId)) {
        reply.code(400).send({ error: 'intoId is required' });
        return;
      }
      if (sourceId === targetId) {
        reply.code(400).send({ error: 'cannot merge an item into itself' });
        return;
      }

      const source = deps.db.prepare('SELECT event_id, status, quantity FROM items WHERE id = ?').get(sourceId) as
        | { event_id: number; status: string; quantity: number }
        | undefined;
      const target = deps.db.prepare('SELECT event_id, status FROM items WHERE id = ?').get(targetId) as
        | { event_id: number; status: string }
        | undefined;
      if (!source || !target) {
        reply.code(404).send({ error: 'item not found' });
        return;
      }
      if (source.event_id !== target.event_id) {
        reply.code(400).send({ error: 'items belong to different events' });
        return;
      }
      if (!isEventDraft(deps, source.event_id)) {
        reply.code(409).send({ error: 'event is not in draft' });
        return;
      }
      if (source.status !== 'pool' || target.status !== 'pool') {
        reply.code(409).send({ error: 'both lots must still be in the pool' });
        return;
      }

      deps.db.prepare('UPDATE items SET quantity = quantity + ? WHERE id = ?').run(source.quantity, targetId);
      deps.db.prepare("UPDATE items SET status = 'removed' WHERE id = ?").run(sourceId);

      return { ok: true };
    }
  );
```

- [ ] **Step 5: Add the draft-lock check to `src/server/routes/screenshots.ts`**

Add the import:

```typescript
import { isEventDraft } from './items';
```

Then, right after `const eventId = Number(request.params.id);` at the top of the `POST /events/:id/screenshots` handler, insert:

```typescript
      if (!isEventDraft(deps, eventId)) {
        reply.code(409).send({ error: 'event is not in draft' });
        return;
      }
```

(check before consuming `request.parts()`, so a locked upload fails fast instead of after reading the whole multipart body).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/server/routes/items.test.ts tests/server/routes/screenshots.test.ts`
Expected: PASS

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add src/server/routes/items.ts src/server/routes/screenshots.ts tests/server/routes/items.test.ts tests/server/routes/screenshots.test.ts
git commit -m "$(cat <<'EOF'
Lock lot editing once an event leaves draft

PUT/DELETE /items/:id, the merge endpoint, and screenshot upload all
now 409 once their event's status isn't 'draft' — once bidding is
open, users may already be claiming these exact lots. Merge also
drops its claim-carrying step, which can no longer fire now that
merging and claiming can never overlap in time.
EOF
)"
```

---

### Task 3: FCFS claim/unclaim

**Files:**
- Modify: `src/server/routes/items.ts`
- Modify: `tests/server/routes/items.test.ts`

**Interfaces:**
- Consumes: `winLimitGroup` exported from `src/server/routes/events.ts` (Task 1).
- Produces: `POST /items/:id/claim` and `DELETE /items/:id/claim` with the new request/response contract described below — `web/views/pool.ts` (Task 6) is the only other consumer, and it already treats both as opaque `apiFetch` calls needing no signature changes.

- [ ] **Step 1: Update the claim/unclaim tests in `tests/server/routes/items.test.ts`**

The shared `beforeEach` event is `draft` as of Task 2, but claiming/unclaiming now requires `open` — every test below starts by flipping the event open. Find the existing claim/unclaim tests (`'a user can bid on multiple items with no limit'` through `'claiming the same item twice does not create duplicate claims'`) and replace all of them with:

```typescript
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
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    // itemA/itemB default to feast + category 'item' (see beforeEach) — put B in a
    // different group so this actually exercises "different groups", not "same group
    // twice" (which the limit test below covers instead).
    db.prepare("UPDATE items SET category = 'stone' WHERE id = ?").run(itemBId);

    const first = await app.inject({ method: 'POST', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: `/api/items/${itemBId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
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

  it('unclaiming an item nobody claimed leaves quantity untouched', async () => {
    db.prepare("UPDATE events SET status = 'open' WHERE id = ?").run(eventId);
    const res = await app.inject({ method: 'DELETE', url: `/api/items/${itemAId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(res.statusCode).toBe(200);
    const row = db.prepare('SELECT quantity FROM items WHERE id = ?').get(itemAId) as any;
    expect(row.quantity).toBe(1); // unchanged
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
    db.prepare("INSERT INTO users (telegram_id, username) VALUES (2, 'alice')").run();
    db.prepare('INSERT INTO claims (item_id, telegram_id) VALUES (?, 2)').run(lateItemId);

    const res = await app.inject({ method: 'DELETE', url: `/api/items/${lateItemId}/claim`, headers: { 'x-telegram-init-data': aliceInitData } });
    expect(res.statusCode).toBe(409);
    const row = db.prepare('SELECT COUNT(*) as count FROM claims WHERE item_id = ?').get(lateItemId) as any;
    expect(row.count).toBe(1);
  });
```

(the `'POST /items/:id/merge rejects merging an already-auctioned lot'` test near the end of the file is untouched by this task — it doesn't involve claiming).

- [ ] **Step 2: Run the tests to verify the new/changed ones fail**

Run: `npx vitest run tests/server/routes/items.test.ts`
Expected: FAIL — claim still silently `INSERT OR IGNORE`s without checking event status, without checking win limits, and without touching `quantity`/`status`; unclaim doesn't restore `quantity`/`status` either.

- [ ] **Step 3: Rewrite the claim/unclaim handlers in `src/server/routes/items.ts`**

Add the import at the top of the file:

```typescript
import { winLimitGroup } from './events';
```

Add this helper near `isPastDeadline` (same "shared by claim/unclaim logic" grouping):

```typescript
// Tallies this user's current claims for the event by win-limit-group key (see
// winLimitGroup in events.ts) — the live, per-attempt equivalent of the counter the old
// end-of-event draw used to build once over the whole claimant pool.
function getUserGroupCounts(deps: AppDeps, eventId: number, userId: number): Map<string, number> {
  const rows = deps.db
    .prepare(
      `SELECT i.color, i.category, s.template
       FROM claims c
       JOIN items i ON i.id = c.item_id
       JOIN screenshots s ON s.id = i.screenshot_id
       WHERE i.event_id = ? AND c.telegram_id = ?`
    )
    .all(eventId, userId) as { color: string; category: string; template: string }[];

  const counts = new Map<string, number>();
  for (const row of rows) {
    const { key } = winLimitGroup(row.template, row.color, row.category);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
```

Replace the whole `POST /items/:id/claim` handler:

```typescript
  app.post<{ Params: { id: string } }>('/items/:id/claim', async (request, reply) => {
    const itemId = Number(request.params.id);
    const userId = request.telegramUser!.telegramId;

    const item = deps.db
      .prepare(
        `SELECT i.status, i.event_id, i.quantity, i.color, i.category, s.template
         FROM items i JOIN screenshots s ON s.id = i.screenshot_id
         WHERE i.id = ?`
      )
      .get(itemId) as
      | { status: string; event_id: number; quantity: number; color: string; category: string; template: string }
      | undefined;
    if (!item || item.status !== 'pool') {
      reply.code(409).send({ error: 'item is not claimable' });
      return;
    }

    const event = deps.db.prepare('SELECT status FROM events WHERE id = ?').get(item.event_id) as
      | { status: string }
      | undefined;
    if (!event || event.status !== 'open') {
      reply.code(409).send({ error: 'auction is not open' });
      return;
    }
    // The UI hides the bid button once the countdown runs out, but only enforcing it
    // there means a request sent straight to the API (or a stale page left open past
    // the deadline) can still place a bid — the deadline has to be checked server-side
    // to actually mean anything.
    if (isPastDeadline(deps, item.event_id)) {
      reply.code(409).send({ error: 'bidding has ended' });
      return;
    }

    const already = deps.db.prepare('SELECT 1 FROM claims WHERE item_id = ? AND telegram_id = ?').get(itemId, userId);
    if (already) {
      reply.code(409).send({ error: 'already claimed' });
      return;
    }

    const { key, limit, exclusiveWith } = winLimitGroup(item.template, item.color, item.category);
    const counts = getUserGroupCounts(deps, item.event_id, userId);
    if ((counts.get(key) ?? 0) >= limit) {
      reply.code(409).send({ error: 'win limit reached' });
      return;
    }
    if (exclusiveWith && (counts.get(exclusiveWith) ?? 0) > 0) {
      reply.code(409).send({ error: 'already won in the other category' });
      return;
    }

    // Claiming a lot immediately reserves one unit of it — first come, first served —
    // instead of just registering interest for a later random draw.
    deps.db.prepare('INSERT INTO claims (item_id, telegram_id) VALUES (?, ?)').run(itemId, userId);
    const remaining = item.quantity - 1;
    deps.db
      .prepare('UPDATE items SET quantity = ?, status = ? WHERE id = ?')
      .run(remaining, remaining <= 0 ? 'auctioned' : 'pool', itemId);

    return { ok: true };
  });
```

Replace the whole `DELETE /items/:id/claim` handler:

```typescript
  app.delete<{ Params: { id: string } }>('/items/:id/claim', async (request, reply) => {
    const itemId = Number(request.params.id);
    const userId = request.telegramUser!.telegramId;

    const item = deps.db.prepare('SELECT event_id FROM items WHERE id = ?').get(itemId) as { event_id: number } | undefined;
    if (item) {
      const event = deps.db.prepare('SELECT status FROM events WHERE id = ?').get(item.event_id) as
        | { status: string }
        | undefined;
      if (event?.status !== 'open' || isPastDeadline(deps, item.event_id)) {
        reply.code(409).send({ error: 'bidding has ended' });
        return;
      }
    }

    const result = deps.db.prepare('DELETE FROM claims WHERE item_id = ? AND telegram_id = ?').run(itemId, userId);
    if (result.changes > 0 && item) {
      // Giving the unit back always returns the lot to 'pool', even if claiming it was
      // what had taken it to 'auctioned' (sold out) — the quantity math is symmetric.
      deps.db.prepare("UPDATE items SET quantity = quantity + 1, status = 'pool' WHERE id = ?").run(itemId);
    }
    return { ok: true };
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/server/routes/items.test.ts`
Expected: PASS

- [ ] **Step 5: Type-check and run the full backend test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no type errors, all tests pass (this is the first point where the whole backend — Tasks 1–3 together — is exercised at once)

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/items.ts tests/server/routes/items.test.ts
git commit -m "$(cat <<'EOF'
Make claiming an instant reservation instead of a raffle entry

POST /items/:id/claim now decrements quantity and flips the lot to
'auctioned' (sold out) at zero, checking the event is open, not past
deadline, not already claimed by this user, and not over their
per-event win-limit group — all synchronously, since there's no more
end-of-event draw to defer those checks to. DELETE reverses it.
EOF
)"
```

---

### Task 4: Admin UI — event list & create form

**Files:**
- Modify: `web/views/admin.ts`

**Interfaces:**
- Consumes: `POST /events` now takes `{ title }` only (Task 1); `EventSummary.status` from `GET /events` can now be `'draft'`.
- Produces: nothing consumed elsewhere — `renderAdmin`'s exported signature is unchanged.

- [ ] **Step 1: Simplify the create form and update status labels**

In `web/views/admin.ts`, replace the `EventSummary` interface and `STATUS_LABEL`:

```typescript
interface EventSummary {
  id: number;
  title: string;
  deadlineAt: string | null;
  status: 'draft' | 'open' | 'resolved';
  itemCount: number;
}

const STATUS_LABEL: Record<string, string> = { draft: 'Черновик', open: 'Открыт', resolved: 'Завершён' };
```

Replace the create-event form (drop the duration field — starting the auction, and picking its duration, now happens on the event-detail screen once the admin is done editing):

```typescript
    <section>
      <h3>Новый ивент</h3>
      <form id="event-form">
        <input name="title" placeholder="Название ивента" required />
        <button type="submit" class="btn-block">Создать ивент</button>
      </form>
      <p id="create-error" class="error"></p>
    </section>
```

Replace the submit handler's payload:

```typescript
  (root.querySelector('#event-form') as HTMLFormElement).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);
    try {
      const event = await apiFetch('/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: fd.get('title') }),
      });
      form.reset();
      renderEventDetail(root, event.id, () => showEventList(root));
    } catch (err) {
      showError('#create-error', err);
    }
  });
```

(the `durationMinutes` reset line that followed `form.reset()` is deleted along with the field itself).

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add web/views/admin.ts
git commit -m "$(cat <<'EOF'
Drop duration from event creation; it's now set at start time

Creating an event only asks for a title — duration moves to the new
"Начать аукцион" step in eventDetail.ts, since drafts no longer carry
a deadline until the admin is done editing and explicitly starts them.
EOF
)"
```

---

### Task 5: Admin UI — event detail lifecycle (draft/open/resolved)

**Files:**
- Modify: `web/views/eventDetail.ts`

**Interfaces:**
- Consumes: `event.status` (`'draft' | 'open' | 'resolved'`) from `GET /events/:id` (Task 1); `POST /events/:id/start`, `POST /events/:id/finish` (Task 1); items' `quantity` now reads as live remaining stock (Task 3) — no shape change, just meaning.
- Produces: nothing consumed elsewhere — `renderEventDetail`'s exported signature is unchanged.

- [ ] **Step 1: Branch the template on `event.status`**

In `web/views/eventDetail.ts`, replace the `STATUS_LABEL` constant (item-status labels — unrelated to the event-status labels added in Task 4's `admin.ts`) and add an event-status label map:

```typescript
const STATUS_LABEL: Record<string, string> = { pool: 'В пуле', auctioned: 'Раскуплено', removed: 'Убран' };
const EVENT_STATUS_LABEL: Record<string, string> = { draft: 'Черновик', open: 'Открыт', resolved: 'Завершён' };
```

Replace the whole `root.innerHTML = ...` template assignment (from `root.innerHTML = \`\n    <button id="back-btn"...` through the closing `\`;` right before `(root.querySelector('#back-btn')...`) with:

```typescript
  const status: 'draft' | 'open' | 'resolved' = data.event.status;

  root.innerHTML = `
    <button id="back-btn" class="back-btn">← Все ивенты</button>
    <section>
      <div class="section-title">
        <h3>${escapeHtml(data.event.title)}</h3>
        <span class="status-pill">${EVENT_STATUS_LABEL[status] ?? status}</span>
      </div>
      <p style="color:var(--text-muted)">
        ${data.event.deadlineAt ? `Приём заявок до ${new Date(data.event.deadlineAt).toLocaleString('ru-RU')}` : ''}
      </p>
    </section>
    ${
      status === 'draft'
        ? `
    <section>
      <h3>Загрузить скриншоты аукциона</h3>
      <p style="color:var(--text-muted);font-size:0.85rem">
        Можно выбрать сразу несколько скриншотов — все они должны показывать одинаковое
        количество строк. Приложение порежет их на лоты, определит цвет редкости и само
        объединит одинаковые на вид предметы в один лот с количеством («Кол-во»). Ставка
        бронирует один экземпляр лота сразу — кто раньше нажал, тому и досталось; когда
        «Кол-во» дойдёт до нуля, лот станет серым и недоступным для ставок. Проверь
        получившееся кол-во и поправь, если распозналось не то. Название не распознаётся
        автоматически — впиши вручную только если по иконке не понятно, что за лот
        (например, у сундуков одного вида, но разного уровня — учти, что такие лоты тоже
        объединятся в один, раз иконка совпадает, так что кол-во и пометку для них стоит
        проверить особенно внимательно). Цену не показываем — участники и так видят её в
        игре. Редактировать лоты можно, пока не нажата «Начать аукцион» — после старта
        список блокируется.
      </p>
      <form id="screenshot-form">
        <div class="field-row">
          <input name="rows" type="number" min="1" max="50" placeholder="Строк на каждом скрине" required />
          <select name="template" required>
            <option value="feast">Пир победы</option>
            <option value="invasion">Аукцион вторжения</option>
          </select>
        </div>
        <input name="file" type="file" accept="image/*" multiple required />
        <button type="submit" class="btn-block">Загрузить</button>
      </form>
      <p id="upload-error" class="error"></p>
      <p id="upload-status" style="color:var(--text-muted);font-size:0.85rem"></p>
    </section>`
        : ''
    }
    <section>
      <div class="section-title"><h3>Лоты</h3></div>
      ${status === 'draft' ? `<input id="lot-search" type="search" placeholder="Поиск лота по названию…" />` : ''}
      <div id="event-items"></div>
      ${
        status === 'draft'
          ? `
      <label style="margin-top:0.75rem">Длительность приёма заявок (в минутах)
        <input id="start-duration" type="number" min="1" value="25" required />
      </label>
      <button id="start-btn" class="btn-block" style="margin-top:0.5rem">Начать аукцион</button>
      <p id="start-error" class="error"></p>`
          : status === 'open'
            ? `
      <button id="finish-btn" class="btn-block" style="margin-top:0.75rem">Завершить аукцион</button>
      <p id="finish-error" class="error"></p>`
            : ''
      }
    </section>
  `;
```

- [ ] **Step 2: Add a read-only item renderer and switch to it outside draft**

Add this function alongside `renderItemsFiltered` (the existing editable renderer stays unchanged, and is used only when `status === 'draft'`):

```typescript
  function renderReadOnlyItems() {
    const itemsEl = root.querySelector('#event-items') as HTMLElement;
    if (allItems.length === 0) {
      itemsEl.innerHTML = '<p class="empty-state">Лотов нет</p>';
      return;
    }
    itemsEl.innerHTML = `<div class="items">${allItems
      .map((item) => {
        const colorLabel = ITEM_COLORS.find((c) => c.value === item.color)?.label ?? item.color;
        const categoryLabel = ITEM_CATEGORIES.find((c) => c.value === item.category)?.label ?? item.category;
        return `
        <div class="admin-item" data-id="${item.id}">
          <img src="/uploads/${item.imagePath}" />
          <p>${escapeHtml(item.name) || '—'}</p>
          <span class="status-pill">
            ${colorLabel} · ${categoryLabel} · Осталось ${item.quantity} · ${STATUS_LABEL[item.status]}
            ${item.winners.length > 0 ? ' · ' + item.winners.map((w) => escapeHtml(w.nickname ?? '—')).join(', ') : ''}
          </span>
        </div>`;
      })
      .join('')}</div>`;
  }
```

Replace the `loadItems` function:

```typescript
  async function loadItems() {
    const current = await apiFetch(`/events/${eventId}`);
    allItems = current.items;
    if (status === 'draft') {
      renderItemsFiltered((root.querySelector('#lot-search') as HTMLInputElement).value);
    } else {
      renderReadOnlyItems();
    }
  }
```

- [ ] **Step 3: Guard the draft-only listeners and add start/finish handlers**

Wrap the existing `#lot-search` listener registration in a draft check:

```typescript
  if (status === 'draft') {
    (root.querySelector('#lot-search') as HTMLInputElement).addEventListener('input', (e) => {
      renderItemsFiltered((e.target as HTMLInputElement).value);
    });
  }
```

Wrap the existing `#screenshot-form` submit-listener block (the whole `(root.querySelector('#screenshot-form') as HTMLFormElement).addEventListener(...)` call) in the same `if (status === 'draft') { ... }`.

Replace the existing `#resolve-btn` click-listener block with start/finish handlers:

```typescript
  if (status === 'draft') {
    (root.querySelector('#start-btn') as HTMLButtonElement).addEventListener('click', async () => {
      const durationMinutes = Number((root.querySelector('#start-duration') as HTMLInputElement).value);
      try {
        await apiFetch(`/events/${eventId}/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ durationMinutes }),
        });
        renderEventDetail(root, eventId, onBack);
      } catch (err) {
        (root.querySelector('#start-error') as HTMLElement).textContent = (err as Error).message;
      }
    });
  }

  if (status === 'open') {
    (root.querySelector('#finish-btn') as HTMLButtonElement).addEventListener('click', async () => {
      if (!confirm('Завершить приём заявок? Дальше никто не сможет поставить или отменить ставку.')) return;
      try {
        await apiFetch(`/events/${eventId}/finish`, { method: 'POST' });
        renderEventDetail(root, eventId, onBack);
      } catch (err) {
        (root.querySelector('#finish-error') as HTMLElement).textContent = (err as Error).message;
      }
    });
  }
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors — check in particular that `renderItemsFiltered`, `mergeSourceId`, and the merge-button listeners (all still only reachable when `status === 'draft'`, since `renderReadOnlyItems` never renders their buttons) don't produce unused-variable or null-ref errors.

- [ ] **Step 5: Manual smoke test**

Run: `npm run dev:server` (one terminal) and `npm run dev:web` (another), then open the app as the configured admin. Create an event (title only), confirm it shows "Черновик". Upload a screenshot, edit a lot's color/quantity, confirm editing still works. Click "Начать аукцион" with a duration, confirm the status pill flips to "Открыт", the upload form and edit controls disappear, and the lot list becomes read-only. Click "Завершить аукцион", confirm the status pill flips to "Завершён" and the button disappears.

- [ ] **Step 6: Commit**

```bash
git add web/views/eventDetail.ts
git commit -m "$(cat <<'EOF'
Branch admin event detail on draft/open/resolved

Draft keeps today's upload+edit UI, now ending in a "Начать аукцион"
duration prompt instead of "Разыграть всё". Open and resolved render
lots read-only; open additionally shows "Завершить аукцион".
EOF
)"
```

---

### Task 6: User UI — sold-out styling

**Files:**
- Modify: `web/views/pool.ts`

**Interfaces:**
- Consumes: `item.status === 'auctioned'` now means "sold out" rather than "drawn" (Task 3); `item.winners` now reflects current claimants (Task 1).
- Produces: nothing consumed elsewhere — `renderPool`'s exported signature is unchanged.

- [ ] **Step 1: Gray the border and relabel the claimant list**

In `web/views/pool.ts`, in `renderItem`, replace the border-left style:

```typescript
      <div class="lot-row" data-id="${item.id}" style="border-left: 4px solid ${item.status === 'auctioned' ? 'var(--border)' : colorHex(item.color)}">
```

Replace the winners/badge branch:

```typescript
        ${
          item.status === 'auctioned'
            ? item.winners.length > 0
              ? `<details class="winners">
                   <summary>Забрали (${item.winners.length})</summary>
                   <p>${item.winners.map((w) => escapeHtml(w.nickname ?? '—')).join(', ')}</p>
                 </details>`
              : `<p class="badge">Раскуплено: —</p>`
            : biddingClosed
              ? `<p class="badge">Приём заявок окончен</p>`
              : item.claimedByMe
                ? `<button data-action="unclaim" class="btn-sm btn-secondary">Отменить</button>`
                : `<button data-action="claim" class="btn-sm">Ставка</button>`
        }
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Manual smoke test**

With the dev server running (from Task 5's step 5) and an `open` event that has an item with `quantity: 1`, open the pool view as a regular user, click "Ставка" and confirm the lot immediately turns gray with a "Забрали (1)" disclosure showing your nickname, and no other lot's styling changed.

- [ ] **Step 4: Commit**

```bash
git add web/views/pool.ts
git commit -m "$(cat <<'EOF'
Gray out sold-out lots and relabel claimants as "Забрали"

Reuses the existing inline border-left mechanism and the .winners
component as-is — no new CSS, no new class, just a status-conditional
color and accurate wording now that there's no draw to have "won".
EOF
)"
```

---

### Task 7: HANDOFF.md + full verification pass

**Files:**
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: nothing — documentation only.
- Produces: nothing — end of plan.

- [ ] **Step 1: Update `HANDOFF.md`**

Add a new dated section near the top (above "## Где что физически работает", following this file's existing convention of newest-first status notes) summarizing the mechanic change: `draft → open → resolved` event lifecycle, `POST /events/:id/start`/`POST /events/:id/finish` replacing `POST /events/:id/resolve`, claiming as instant FCFS reservation with `items.quantity` as live remaining stock, win-limit rule enforcement moved from draw-time to claim-time, `item_winners` unused-but-not-dropped, `src/server/random.ts` unused-but-not-deleted. Link to [docs/superpowers/specs/2026-08-31-fcfs-reservation-design.md](docs/superpowers/specs/2026-08-31-fcfs-reservation-design.md).

- [ ] **Step 2: Run the full verification suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass, no type errors

- [ ] **Step 3: Commit**

```bash
git add HANDOFF.md
git commit -m "$(cat <<'EOF'
Document the FCFS reservation mechanic in HANDOFF.md
EOF
)"
```

---

## Deploying

Not part of this plan's tasks (per the user's own deploy process — see repo memory) — once all tasks above are committed on `main` and pushed, the standard VPS deploy is: `cd /opt/loot_auction && git pull origin main && npm run build:web && sudo systemctl restart loot-auction && sudo systemctl status loot-auction --no-pager`.
