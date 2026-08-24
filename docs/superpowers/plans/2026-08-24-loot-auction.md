# Loot Auction Mini App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Telegram Mini App where admins upload grid-of-icons reward screenshots, alliance members claim items they want, and admins resolve an entire event at once with a random winner per item.

**Architecture:** Single Node.js/TypeScript process — a Telegraf bot plus a Fastify HTTP server (API under `/api/*`, static file serving for uploads and the built frontend) — backed by one SQLite file and a local uploads folder. The Vite-built vanilla-TS frontend is a Telegram Mini App that talks to the API using Telegram's `initData` for auth.

**Tech Stack:** TypeScript, Fastify, `@fastify/multipart`, `@fastify/static`, better-sqlite3, sharp, Telegraf, Vite (frontend build only), vitest.

**Spec:** [docs/superpowers/specs/2026-08-24-loot-auction-design.md](../specs/2026-08-24-loot-auction-design.md)

## Global Constraints

- No push notifications — status is pull-only (spec: Non-goals).
- No OCR / auto-naming — admin types every item name (spec: Non-goals).
- No freehand crop editor — grid slicing (rows × cols) is the only cropping mechanism (spec: Non-goals).
- No bidding/currency — claim + random draw only (spec: Non-goals).
- The claim-window countdown is informational only — never gates or auto-triggers the draw; the admin always presses "Разыграть всё" manually (spec: Non-goals, Admin flow step 5).
- Every `/api/*` request must carry a verified Telegram `initData`; never trust a client-supplied telegram id without verifying it (spec: Auth / security).
- Admin status is derived from a fixed `ADMIN_TELEGRAM_IDS` env var list, checked server-side on every admin endpoint — no stored roles/permissions table (spec: Auth / security). This plan does **not** persist an `is_admin` column on `users`, since the spec already treats the DB copy as non-authoritative ("cached ... for convenience") and the config list is simpler and always correct.
- Grid slicing on a size that doesn't evenly divide: crop with `floor(width/cols)`, `floor(height/rows)` per cell, accepting leftover edge pixels rather than rejecting the upload (spec: Error handling).
- Resolving an already-resolved event is a no-op, not an error (spec: Error handling).
- Claiming a non-`pool` item or claiming past the per-user limit is rejected with a clear error, never a silent no-op (spec: Error handling).
- Backend testing is unit tests on real branching logic only (initData verification, random winner selection, claim-limit enforcement, grid slicing) — no e2e suite (spec: Testing).

---

## File Structure

```
package.json
tsconfig.json
vite.config.ts
.env.example
.gitignore
src/
  server/
    config.ts
    db.ts
    telegram-init-data.ts
    random.ts
    grid-slice.ts
    types.ts
    auth.ts
    server.ts
    bot.ts
    index.ts
    routes/
      users.ts
      settings.ts
      events.ts
      screenshots.ts
      items.ts
web/
  index.html
  main.ts
  api.ts
  telegram.ts
  style.css
  views/
    profile.ts
    pool.ts
    admin.ts
tests/
  test-helpers.ts
  server/
    config.test.ts
    db.test.ts
    telegram-init-data.test.ts
    random.test.ts
    grid-slice.test.ts
    server.test.ts
    routes/
      users.test.ts
      settings.test.ts
      events.test.ts
      screenshots.test.ts
      items.test.ts
deploy/
  nginx.conf.example
  loot-auction.service.example
data/            (created at runtime, gitignored)
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`

**Interfaces:**
- Produces: an installable Node project with `npm run test`, `npm run dev:server`, `npm run dev:web`, `npm run build:web`, `npm start` available for every later task.

- [ ] **Step 1: Configure git identity for this repo (prerequisite for every commit step below)**

Run (with the user's own name/email):

```bash
git config user.email "heniston333@gmail.com"
git config user.name "Your Name"
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "loot-auction",
  "private": true,
  "type": "module",
  "scripts": {
    "dev:server": "tsx watch src/server/index.ts",
    "dev:web": "vite",
    "build:web": "vite build",
    "start": "tsx src/server/index.ts",
    "test": "vitest run"
  }
}
```

- [ ] **Step 3: Install dependencies**

```bash
npm install fastify @fastify/static @fastify/multipart better-sqlite3 telegraf sharp
npm install -D typescript tsx vite vitest @types/node @types/better-sqlite3
```

- [ ] **Step 4: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist"
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules
dist
data
.env
```

- [ ] **Step 6: Create `.env.example`**

```
BOT_TOKEN=123456:ABC-DEF-your-bot-token
ADMIN_TELEGRAM_IDS=111111111,222222222
MINI_APP_URL=https://your-domain.example
PORT=3000
DATA_DIR=./data
```

- [ ] **Step 7: Verify the project installs and the test runner works**

Run: `npx tsc --version && npx vitest --version`
Expected: both print version numbers with no errors — confirms the toolchain is installed and wired before any code exists. (Do not run `npm test` yet: vitest exits non-zero when no test files exist, which would look like a failure.)

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore .env.example
git commit -m "chore: scaffold project"
```

---

### Task 2: Pure logic — Telegram initData verification

**Files:**
- Create: `src/server/telegram-init-data.ts`
- Create: `tests/test-helpers.ts`
- Test: `tests/server/telegram-init-data.test.ts`

**Interfaces:**
- Produces: `verifyInitData(initData: string, botToken: string): TelegramUser | null`, `interface TelegramUser { telegramId: number; username?: string }` — consumed by Task 8 (`auth.ts`) and every route test from Task 9 onward.
- Produces (test helper): `signInitData(params: Record<string, string>, botToken: string): string` — reused by every later route test that needs an authenticated request.

- [ ] **Step 1: Write the test helper for signing fake initData**

```typescript
// tests/test-helpers.ts
import { createHmac } from 'node:crypto';

export function signInitData(params: Record<string, string>, botToken: string): string {
  const usp = new URLSearchParams(params);
  const dataCheckString = [...usp.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  usp.set('hash', hash);
  return usp.toString();
}

export function signUserInitData(telegramId: number, username: string, botToken: string): string {
  return signInitData({ user: JSON.stringify({ id: telegramId, username }), auth_date: '1700000000' }, botToken);
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/server/telegram-init-data.test.ts
import { describe, it, expect } from 'vitest';
import { verifyInitData } from '../../src/server/telegram-init-data';
import { signInitData, signUserInitData } from '../test-helpers';

describe('verifyInitData', () => {
  const botToken = 'test-token-123';

  it('accepts a validly signed payload', () => {
    const initData = signUserInitData(42, 'alice', botToken);
    expect(verifyInitData(initData, botToken)).toEqual({ telegramId: 42, username: 'alice' });
  });

  it('rejects a tampered payload', () => {
    const initData = signUserInitData(42, 'alice', botToken);
    const tampered = initData.replace('alice', 'mallory');
    expect(verifyInitData(tampered, botToken)).toBeNull();
  });

  it('rejects a payload signed with a different bot token', () => {
    const initData = signUserInitData(42, 'alice', botToken);
    expect(verifyInitData(initData, 'other-token')).toBeNull();
  });

  it('rejects a payload with no hash', () => {
    expect(verifyInitData(signInitData({ user: '{}' }, ''), botToken)).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/server/telegram-init-data.test.ts`
Expected: FAIL — `src/server/telegram-init-data.ts` does not exist yet.

- [ ] **Step 4: Implement**

```typescript
// src/server/telegram-init-data.ts
import { createHmac } from 'node:crypto';

export interface TelegramUser {
  telegramId: number;
  username?: string;
}

export function verifyInitData(initData: string, botToken: string): TelegramUser | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computedHash !== hash) return null;

  const userJson = params.get('user');
  if (!userJson) return null;

  try {
    const user = JSON.parse(userJson) as { id: number; username?: string };
    return { telegramId: user.id, username: user.username };
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/server/telegram-init-data.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/server/telegram-init-data.ts tests/test-helpers.ts tests/server/telegram-init-data.test.ts
git commit -m "feat: verify Telegram Mini App initData"
```

---

### Task 3: Pure logic — random winner picker

**Files:**
- Create: `src/server/random.ts`
- Test: `tests/server/random.test.ts`

**Interfaces:**
- Produces: `pickRandom<T>(items: readonly T[]): T | null` — consumed by Task 11 (`routes/events.ts` resolve endpoint).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/random.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { pickRandom } from '../../src/server/random';

describe('pickRandom', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null for an empty array', () => {
    expect(pickRandom([])).toBeNull();
  });

  it('returns the only item for a single-element array', () => {
    expect(pickRandom(['a'])).toBe('a');
  });

  it('picks the item at the index implied by Math.random', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(pickRandom(['a', 'b', 'c', 'd'])).toBe('c'); // floor(0.5 * 4) = 2
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/random.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/server/random.ts
export function pickRandom<T>(items: readonly T[]): T | null {
  if (items.length === 0) return null;
  return items[Math.floor(Math.random() * items.length)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/random.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/random.ts tests/server/random.test.ts
git commit -m "feat: add random winner picker"
```

---

### Task 4: Pure logic — grid slicing

**Files:**
- Create: `src/server/grid-slice.ts`
- Test: `tests/server/grid-slice.test.ts`

**Interfaces:**
- Produces: `interface Cell { left: number; top: number; width: number; height: number }`, `computeGridCells(imageWidth: number, imageHeight: number, rows: number, cols: number): Cell[]`, `sliceImageToCells(sourcePath: string, rows: number, cols: number, outDir: string, baseName: string): Promise<string[]>` — consumed by Task 12 (`routes/screenshots.ts`). `sliceImageToCells` returns file paths in row-major order matching `computeGridCells`.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/server/grid-slice.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { computeGridCells, sliceImageToCells } from '../../src/server/grid-slice';

describe('computeGridCells', () => {
  it('divides the image into rows*cols equal cells in row-major order', () => {
    const cells = computeGridCells(100, 40, 2, 5);
    expect(cells).toHaveLength(10);
    expect(cells[0]).toEqual({ left: 0, top: 0, width: 20, height: 20 });
    expect(cells[4]).toEqual({ left: 80, top: 0, width: 20, height: 20 });
    expect(cells[5]).toEqual({ left: 0, top: 20, width: 20, height: 20 });
    expect(cells[9]).toEqual({ left: 80, top: 20, width: 20, height: 20 });
  });

  it('floors leftover pixels instead of throwing on uneven division', () => {
    const cells = computeGridCells(101, 41, 2, 5);
    expect(cells[0]).toEqual({ left: 0, top: 0, width: 20, height: 20 });
  });
});

describe('sliceImageToCells', () => {
  let tmpDir: string;
  let sourcePath: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grid-slice-'));
    sourcePath = path.join(tmpDir, 'source.png');
    await sharp({
      create: { width: 100, height: 40, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toFile(sourcePath);
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('produces rows*cols files matching cell dimensions', async () => {
    const outDir = path.join(tmpDir, 'out');
    const paths = await sliceImageToCells(sourcePath, 2, 5, outDir, 'item');
    expect(paths).toHaveLength(10);
    const meta = await sharp(paths[0]).metadata();
    expect(meta.width).toBe(20);
    expect(meta.height).toBe(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/grid-slice.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/server/grid-slice.ts
import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs/promises';

export interface Cell {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function computeGridCells(imageWidth: number, imageHeight: number, rows: number, cols: number): Cell[] {
  const cellWidth = Math.floor(imageWidth / cols);
  const cellHeight = Math.floor(imageHeight / rows);
  const cells: Cell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({ left: c * cellWidth, top: r * cellHeight, width: cellWidth, height: cellHeight });
    }
  }
  return cells;
}

export async function sliceImageToCells(
  sourcePath: string,
  rows: number,
  cols: number,
  outDir: string,
  baseName: string
): Promise<string[]> {
  const metadata = await sharp(sourcePath).metadata();
  const cells = computeGridCells(metadata.width ?? 0, metadata.height ?? 0, rows, cols);

  await fs.mkdir(outDir, { recursive: true });

  const outputPaths: string[] = [];
  for (let i = 0; i < cells.length; i++) {
    const outPath = path.join(outDir, `${baseName}-${i}.png`);
    await sharp(sourcePath).extract(cells[i]).toFile(outPath);
    outputPaths.push(outPath);
  }
  return outputPaths;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/grid-slice.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/grid-slice.ts tests/server/grid-slice.test.ts
git commit -m "feat: add grid-based image slicing"
```

---

### Task 5: Config loader

**Files:**
- Create: `src/server/config.ts`
- Test: `tests/server/config.test.ts`

**Interfaces:**
- Produces: `interface Config { botToken: string; adminTelegramIds: number[]; port: number; dataDir: string; miniAppUrl: string }`, `loadConfig(env?: NodeJS.ProcessEnv): Config` — consumed by Task 13 (`index.ts`).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/config.test.ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/server/config';

describe('loadConfig', () => {
  const base = { BOT_TOKEN: 'token', MINI_APP_URL: 'https://example.test' };

  it('throws when BOT_TOKEN is missing', () => {
    expect(() => loadConfig({ MINI_APP_URL: 'https://example.test' })).toThrow(/BOT_TOKEN/);
  });

  it('throws when MINI_APP_URL is missing', () => {
    expect(() => loadConfig({ BOT_TOKEN: 'token' })).toThrow(/MINI_APP_URL/);
  });

  it('parses a comma-separated admin id list', () => {
    const config = loadConfig({ ...base, ADMIN_TELEGRAM_IDS: '111, 222,333' });
    expect(config.adminTelegramIds).toEqual([111, 222, 333]);
  });

  it('defaults port to 3000 and dataDir to ./data', () => {
    const config = loadConfig(base);
    expect(config.port).toBe(3000);
    expect(config.dataDir.endsWith('data')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/server/config.ts
import path from 'node:path';

export interface Config {
  botToken: string;
  adminTelegramIds: number[];
  port: number;
  dataDir: string;
  miniAppUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const botToken = env.BOT_TOKEN;
  if (!botToken) throw new Error('BOT_TOKEN is required');

  const miniAppUrl = env.MINI_APP_URL;
  if (!miniAppUrl) throw new Error('MINI_APP_URL is required');

  return {
    botToken,
    miniAppUrl,
    adminTelegramIds: (env.ADMIN_TELEGRAM_IDS ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
    port: Number(env.PORT ?? 3000),
    dataDir: env.DATA_DIR ?? path.join(process.cwd(), 'data'),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/config.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/config.ts tests/server/config.test.ts
git commit -m "feat: add env config loader"
```

---

### Task 6: Database schema and connection

**Files:**
- Create: `src/server/db.ts`
- Test: `tests/server/db.test.ts`

**Interfaces:**
- Produces: `type Db = import('better-sqlite3').Database`, `openDb(filePath: string): Db` — consumed by every route task (9–12) and Task 13 (`index.ts`). Table names/columns below are used verbatim by every route task.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/db.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/server/db';

describe('openDb', () => {
  it('creates all six tables', () => {
    const db = openDb(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row: any) => row.name);
    expect(tables).toEqual(['claims', 'events', 'items', 'screenshots', 'settings', 'users']);
  });

  it('seeds a single settings row with a default claim limit', () => {
    const db = openDb(':memory:');
    const row = db.prepare('SELECT max_simultaneous_claims FROM settings WHERE id = 1').get() as any;
    expect(row.max_simultaneous_claims).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/db.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/server/db.ts
import Database from 'better-sqlite3';

export type Db = Database.Database;

export function openDb(filePath: string): Db {
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT,
      game_nickname TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      deadline_at TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS screenshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id),
      original_path TEXT NOT NULL,
      rows INTEGER NOT NULL,
      cols INTEGER NOT NULL,
      uploaded_by INTEGER NOT NULL REFERENCES users(telegram_id),
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id),
      screenshot_id INTEGER NOT NULL REFERENCES screenshots(id),
      name TEXT NOT NULL DEFAULT '',
      image_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pool',
      winner_telegram_id INTEGER REFERENCES users(telegram_id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      auctioned_at TEXT
    );

    CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES items(id),
      telegram_id INTEGER NOT NULL REFERENCES users(telegram_id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(item_id, telegram_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      max_simultaneous_claims INTEGER NOT NULL DEFAULT 5
    );

    INSERT OR IGNORE INTO settings (id, max_simultaneous_claims) VALUES (1, 5);
  `);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/db.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts tests/server/db.test.ts
git commit -m "feat: add SQLite schema and connection"
```

---

### Task 7: Shared server types

**Files:**
- Create: `src/server/types.ts`

**Interfaces:**
- Produces: `interface AppDeps { db: Db; botToken: string; adminTelegramIds: number[]; dataDir: string }` — consumed by every file in Tasks 8–12.

- [ ] **Step 1: Implement**

```typescript
// src/server/types.ts
import type { Db } from './db';

export interface AppDeps {
  db: Db;
  botToken: string;
  adminTelegramIds: number[];
  dataDir: string;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors (only this file and Task 1–6 files exist so far; there should be no type errors).

- [ ] **Step 3: Commit**

```bash
git add src/server/types.ts
git commit -m "feat: add shared AppDeps type"
```

---

### Task 8: Fastify server shell with initData auth

**Files:**
- Create: `src/server/auth.ts`
- Create: `src/server/server.ts`
- Test: `tests/server/server.test.ts`

**Interfaces:**
- Consumes: `verifyInitData` (Task 2), `AppDeps` (Task 7), `openDb` (Task 6).
- Produces: `buildServer(deps: AppDeps, webDistDir?: string): FastifyInstance`, `registerAuth(app: FastifyInstance, deps: AppDeps): void`, `requireAdmin(deps: AppDeps): preHandler function`, and the `request.telegramUser` decoration (`{ telegramId: number; username?: string }`) — consumed by every route task (9–12).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/server.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../src/server/db';
import { buildServer } from '../../src/server/server';
import { signUserInitData } from '../test-helpers';
import type { FastifyInstance } from 'fastify';

describe('buildServer auth', () => {
  const botToken = 'test-token';
  let db: Db;
  let app: FastifyInstance;

  beforeEach(() => {
    db = openDb(':memory:');
    app = buildServer({ db, botToken, adminTelegramIds: [1], dataDir: '/tmp/loot-auction-test' });
  });

  it('rejects requests with no initData header', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests with a tampered initData header', async () => {
    const initData = signUserInitData(1, 'admin', botToken).replace('admin', 'mallory');
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-telegram-init-data': initData } });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a validly signed request and upserts the user', async () => {
    const initData = signUserInitData(1, 'admin', botToken);
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-telegram-init-data': initData } });
    expect(res.statusCode).toBe(200);
    const row = db.prepare('SELECT username FROM users WHERE telegram_id = 1').get() as any;
    expect(row.username).toBe('admin');
  });
});
```

Note: this test references `GET /api/me`, which does not exist until Task 9. Write a temporary inline route stub in this step's server so the auth hook itself is testable in isolation, then Task 9 will replace it with the real implementation — **do this instead**: register a minimal placeholder route directly inside this test's server build by calling `buildServer` and relying on `/api/me` being implemented already, because Task 9 is next and small. To keep this task's test runnable on its own, add a trivial `GET /me` inside the `/api` plugin in `server.ts` now (`return { ok: true }`), and Task 9 will replace its body — update the test above to assert `res.statusCode` only (no body shape assertions), which it already does.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `auth.ts`**

```typescript
// src/server/auth.ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyInitData, type TelegramUser } from './telegram-init-data';
import type { AppDeps } from './types';

declare module 'fastify' {
  interface FastifyRequest {
    telegramUser?: TelegramUser;
  }
}

export function registerAuth(app: FastifyInstance, deps: AppDeps) {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const initData = request.headers['x-telegram-init-data'];
    if (typeof initData !== 'string') {
      reply.code(401).send({ error: 'missing init data' });
      return;
    }
    const user = verifyInitData(initData, deps.botToken);
    if (!user) {
      reply.code(401).send({ error: 'invalid init data' });
      return;
    }
    request.telegramUser = user;
    deps.db
      .prepare(
        `INSERT INTO users (telegram_id, username) VALUES (?, ?)
         ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username`
      )
      .run(user.telegramId, user.username ?? null);
  });
}

export function requireAdmin(deps: AppDeps) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const id = request.telegramUser?.telegramId;
    if (!id || !deps.adminTelegramIds.includes(id)) {
      reply.code(403).send({ error: 'admin only' });
    }
  };
}
```

- [ ] **Step 4: Implement `server.ts` with a temporary `/me` stub**

```typescript
// src/server/server.ts
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import path from 'node:path';
import type { AppDeps } from './types';
import { registerAuth } from './auth';

export function buildServer(deps: AppDeps, webDistDir?: string) {
  const app = Fastify();

  app.register(fastifyMultipart);

  app.register(
    async (api) => {
      registerAuth(api, deps);
      api.get('/me', async () => ({ ok: true })); // replaced in Task 9
    },
    { prefix: '/api' }
  );

  app.register(fastifyStatic, {
    root: path.join(deps.dataDir, 'uploads'),
    prefix: '/uploads/',
    decorateReply: false,
  });

  if (webDistDir) {
    app.register(fastifyStatic, {
      root: webDistDir,
      prefix: '/',
      decorateReply: false,
    });
  }

  return app;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/server/server.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/server/auth.ts src/server/server.ts tests/server/server.test.ts
git commit -m "feat: add Fastify server shell with initData auth"
```

---

### Task 9: Users API

**Files:**
- Create: `src/server/routes/users.ts`
- Modify: `src/server/server.ts` (replace the `/me` stub with `registerUserRoutes`)
- Test: `tests/server/routes/users.test.ts`

**Interfaces:**
- Consumes: `AppDeps` (Task 7), auth's `request.telegramUser` (Task 8).
- Produces: `registerUserRoutes(app: FastifyInstance, deps: AppDeps): void` registering `GET /me` → `{ telegramId, username, gameNickname, isAdmin }` and `PUT /me` (body `{ gameNickname: string }`) → `{ ok: true }`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/routes/users.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../../src/server/db';
import { buildServer } from '../../../src/server/server';
import { signUserInitData } from '../../test-helpers';
import type { FastifyInstance } from 'fastify';

describe('users routes', () => {
  const botToken = 'test-token';
  let db: Db;
  let app: FastifyInstance;
  let initData: string;

  beforeEach(() => {
    db = openDb(':memory:');
    app = buildServer({ db, botToken, adminTelegramIds: [1], dataDir: '/tmp/loot-auction-test' });
    initData = signUserInitData(1, 'admin', botToken);
  });

  it('GET /me reports isAdmin true for a configured admin id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-telegram-init-data': initData } });
    expect(res.json()).toMatchObject({ telegramId: 1, username: 'admin', gameNickname: null, isAdmin: true });
  });

  it('GET /me reports isAdmin false for a non-admin id', async () => {
    const memberInitData = signUserInitData(2, 'bob', botToken);
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-telegram-init-data': memberInitData } });
    expect(res.json().isAdmin).toBe(false);
  });

  it('PUT /me rejects an empty nickname', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/me',
      headers: { 'x-telegram-init-data': initData, 'content-type': 'application/json' },
      payload: { gameNickname: '  ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT /me saves the nickname and GET /me reflects it', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/me',
      headers: { 'x-telegram-init-data': initData, 'content-type': 'application/json' },
      payload: { gameNickname: 'Дракоша' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-telegram-init-data': initData } });
    expect(res.json().gameNickname).toBe('Дракоша');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/routes/users.test.ts`
Expected: FAIL — `gameNickname`/`isAdmin` not present, `PUT /me` returns 404.

- [ ] **Step 3: Implement `routes/users.ts`**

```typescript
// src/server/routes/users.ts
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../types';

export function registerUserRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get('/me', async (request) => {
    const id = request.telegramUser!.telegramId;
    const row = deps.db
      .prepare('SELECT telegram_id, username, game_nickname FROM users WHERE telegram_id = ?')
      .get(id) as { telegram_id: number; username: string | null; game_nickname: string | null };

    return {
      telegramId: row.telegram_id,
      username: row.username,
      gameNickname: row.game_nickname,
      isAdmin: deps.adminTelegramIds.includes(id),
    };
  });

  app.put<{ Body: { gameNickname: string } }>('/me', async (request, reply) => {
    const gameNickname = request.body?.gameNickname?.trim();
    if (!gameNickname) {
      reply.code(400).send({ error: 'gameNickname is required' });
      return;
    }
    const id = request.telegramUser!.telegramId;
    deps.db.prepare('UPDATE users SET game_nickname = ? WHERE telegram_id = ?').run(gameNickname, id);
    return { ok: true };
  });
}
```

- [ ] **Step 4: Wire it into `server.ts`**

Replace the temporary `/me` stub block with:

```typescript
  app.register(
    async (api) => {
      registerAuth(api, deps);
      registerUserRoutes(api, deps);
    },
    { prefix: '/api' }
  );
```

Add the import at the top: `import { registerUserRoutes } from './routes/users';`

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/server/routes/users.test.ts tests/server/server.test.ts`
Expected: PASS (all tests, including the earlier server.test.ts suite)

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/users.ts src/server/server.ts tests/server/routes/users.test.ts
git commit -m "feat: add users API (profile + admin flag)"
```

---

### Task 10: Settings API

**Files:**
- Create: `src/server/routes/settings.ts`
- Modify: `src/server/server.ts` (register `registerSettingsRoutes`)
- Test: `tests/server/routes/settings.test.ts`

**Interfaces:**
- Consumes: `AppDeps`, `requireAdmin` (Task 8).
- Produces: `registerSettingsRoutes(app, deps)` registering `GET /settings` → `{ maxSimultaneousClaims }` and `PUT /settings` (admin only, body `{ maxSimultaneousClaims: number }`) → `{ ok: true }`. Consumed by Task 12's items claim endpoint.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/routes/settings.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../../src/server/db';
import { buildServer } from '../../../src/server/server';
import { signUserInitData } from '../../test-helpers';
import type { FastifyInstance } from 'fastify';

describe('settings routes', () => {
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
  });

  it('GET /settings returns the default limit', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: { 'x-telegram-init-data': memberInitData } });
    expect(res.json()).toEqual({ maxSimultaneousClaims: 5 });
  });

  it('PUT /settings is rejected for a non-admin', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'x-telegram-init-data': memberInitData, 'content-type': 'application/json' },
      payload: { maxSimultaneousClaims: 3 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('PUT /settings updates the limit for an admin', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { maxSimultaneousClaims: 3 },
    });
    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: { 'x-telegram-init-data': memberInitData } });
    expect(res.json()).toEqual({ maxSimultaneousClaims: 3 });
  });

  it('PUT /settings rejects a non-positive limit', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'x-telegram-init-data': adminInitData, 'content-type': 'application/json' },
      payload: { maxSimultaneousClaims: 0 },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/routes/settings.test.ts`
Expected: FAIL — 404s on `/api/settings`.

- [ ] **Step 3: Implement `routes/settings.ts`**

```typescript
// src/server/routes/settings.ts
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';

export function registerSettingsRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get('/settings', async () => {
    const row = deps.db.prepare('SELECT max_simultaneous_claims FROM settings WHERE id = 1').get() as {
      max_simultaneous_claims: number;
    };
    return { maxSimultaneousClaims: row.max_simultaneous_claims };
  });

  app.put<{ Body: { maxSimultaneousClaims: number } }>(
    '/settings',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const value = request.body?.maxSimultaneousClaims;
      if (!Number.isInteger(value) || value < 1) {
        reply.code(400).send({ error: 'maxSimultaneousClaims must be a positive integer' });
        return;
      }
      deps.db.prepare('UPDATE settings SET max_simultaneous_claims = ? WHERE id = 1').run(value);
      return { ok: true };
    }
  );
}
```

- [ ] **Step 4: Wire it into `server.ts`**

Add `registerSettingsRoutes(api, deps);` inside the `/api` plugin block, and `import { registerSettingsRoutes } from './routes/settings';` at the top.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/server/routes/settings.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/settings.ts src/server/server.ts tests/server/routes/settings.test.ts
git commit -m "feat: add settings API (claim limit)"
```

---

### Task 11: Events API (create, current pool, bulk resolve)

**Files:**
- Create: `src/server/routes/events.ts`
- Modify: `src/server/server.ts` (register `registerEventRoutes`)
- Test: `tests/server/routes/events.test.ts`

**Interfaces:**
- Consumes: `AppDeps`, `requireAdmin` (Task 8), `pickRandom` (Task 3).
- Produces: `registerEventRoutes(app, deps)` registering:
  - `POST /events` (admin, body `{ title: string; durationMinutes: number }`) → `{ id, title, deadlineAt, status }`
  - `GET /events/current` → `{ event: { id, title, deadlineAt, status } | null, items: Array<{ id, name, imagePath, status, winnerTelegramId, winnerNickname, claimedByMe: 0|1 }> }` — `items` excludes `status = 'removed'`. Consumed by the frontend Pool/Admin views (Tasks 16–19).
  - `POST /events/:id/resolve` (admin) → `{ ok: true }` — for each `pool` item in the event, picks a random claimant and marks it `auctioned`; items with no claims stay `pool`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/routes/events.test.ts
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
    // seed user 2's nickname so winnerNickname can be asserted later
    db.prepare("UPDATE users SET game_nickname = 'Bob' WHERE telegram_id = 2").run();
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/routes/events.test.ts`
Expected: FAIL — 404s on `/api/events*`.

- [ ] **Step 3: Implement `routes/events.ts`**

```typescript
// src/server/routes/events.ts
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';
import { pickRandom } from '../random';

interface EventRow {
  id: number;
  title: string;
  deadline_at: string | null;
  status: string;
}

export function registerEventRoutes(app: FastifyInstance, deps: AppDeps) {
  app.post<{ Body: { title: string; durationMinutes: number } }>(
    '/events',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const title = request.body?.title?.trim();
      if (!title) {
        reply.code(400).send({ error: 'title is required' });
        return;
      }
      const durationMinutes = request.body?.durationMinutes;
      const deadlineAt =
        Number.isFinite(durationMinutes) && durationMinutes > 0
          ? new Date(Date.now() + durationMinutes * 60_000).toISOString()
          : null;

      const result = deps.db
        .prepare('INSERT INTO events (title, deadline_at, status) VALUES (?, ?, ?)')
        .run(title, deadlineAt, 'open');

      return { id: result.lastInsertRowid, title, deadlineAt, status: 'open' };
    }
  );

  app.get('/events/current', async (request) => {
    const event = deps.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 1').get() as EventRow | undefined;
    if (!event) return { event: null, items: [] };

    const userId = request.telegramUser!.telegramId;
    const items = deps.db
      .prepare(
        `SELECT i.id, i.name, i.image_path as imagePath, i.status,
                i.winner_telegram_id as winnerTelegramId,
                w.game_nickname as winnerNickname,
                EXISTS(SELECT 1 FROM claims c WHERE c.item_id = i.id AND c.telegram_id = ?) as claimedByMe
         FROM items i
         LEFT JOIN users w ON w.telegram_id = i.winner_telegram_id
         WHERE i.event_id = ? AND i.status != 'removed'
         ORDER BY i.id`
      )
      .all(userId, event.id);

    return {
      event: { id: event.id, title: event.title, deadlineAt: event.deadline_at, status: event.status },
      items,
    };
  });

  app.post<{ Params: { id: string } }>(
    '/events/:id/resolve',
    { preHandler: requireAdmin(deps) },
    async (request) => {
      const eventId = Number(request.params.id);
      const poolItems = deps.db.prepare("SELECT id FROM items WHERE event_id = ? AND status = 'pool'").all(eventId) as {
        id: number;
      }[];

      const resolveOne = deps.db.transaction((itemId: number) => {
        const claimants = deps.db.prepare('SELECT telegram_id FROM claims WHERE item_id = ?').all(itemId) as {
          telegram_id: number;
        }[];
        const winner = pickRandom(claimants);
        if (!winner) return;
        deps.db
          .prepare(
            "UPDATE items SET status = 'auctioned', winner_telegram_id = ?, auctioned_at = datetime('now') WHERE id = ?"
          )
          .run(winner.telegram_id, itemId);
      });

      for (const item of poolItems) resolveOne(item.id);

      deps.db.prepare("UPDATE events SET status = 'resolved' WHERE id = ?").run(eventId);
      return { ok: true };
    }
  );
}
```

- [ ] **Step 4: Wire it into `server.ts`**

Add `registerEventRoutes(api, deps);` inside the `/api` plugin block, and `import { registerEventRoutes } from './routes/events';` at the top.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/server/routes/events.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/events.ts src/server/server.ts tests/server/routes/events.test.ts
git commit -m "feat: add events API (create, current pool, bulk resolve)"
```

---

### Task 12: Screenshots API (upload + grid slice) and Items API (name, remove, claim)

**Files:**
- Create: `src/server/routes/screenshots.ts`
- Create: `src/server/routes/items.ts`
- Modify: `src/server/server.ts` (register both)
- Test: `tests/server/routes/screenshots.test.ts`
- Test: `tests/server/routes/items.test.ts`

**Interfaces:**
- Consumes: `AppDeps`, `requireAdmin` (Task 8), `sliceImageToCells` (Task 4).
- Produces: `registerScreenshotRoutes(app, deps)` registering `POST /events/:id/screenshots` (admin, multipart: fields `rows`, `cols` sent **before** the `file` field, plus the image file) → `{ screenshotId, itemIds }`, creating `rows*cols` items with `image_path` stored **relative to `<dataDir>/uploads`** (so the frontend can build `/uploads/${imagePath}`).
- Produces: `registerItemRoutes(app, deps)` registering `PUT /items/:id` (admin, body `{ name }`), `DELETE /items/:id` (admin, soft-removes), `POST /items/:id/claim`, `DELETE /items/:id/claim`.

- [ ] **Step 1: Write the failing screenshots test**

```typescript
// tests/server/routes/screenshots.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { openDb, type Db } from '../../../src/server/db';
import { buildServer } from '../../../src/server/server';
import { signUserInitData } from '../../test-helpers';
import type { FastifyInstance } from 'fastify';

describe('POST /api/events/:id/screenshots', () => {
  const botToken = 'test-token';
  let dataDir: string;
  let db: Db;
  let app: FastifyInstance;
  let baseUrl: string;
  let adminInitData: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'screenshots-test-'));
    db = openDb(':memory:');
    app = buildServer({ db, botToken, adminTelegramIds: [1], dataDir });
    await app.listen({ port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    adminInitData = signUserInitData(1, 'admin', botToken);
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('slices an uploaded screenshot into rows*cols pool items', async () => {
    const createEventRes = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
      body: JSON.stringify({ title: 'Ивент', durationMinutes: 25 }),
    });
    const { id: eventId } = await createEventRes.json();

    const imageBuffer = await sharp({
      create: { width: 100, height: 40, channels: 3, background: { r: 0, g: 255, b: 0 } },
    })
      .png()
      .toBuffer();

    const form = new FormData();
    form.append('rows', '2');
    form.append('cols', '5');
    form.append('file', new Blob([imageBuffer], { type: 'image/png' }), 'reward.png');

    const res = await fetch(`${baseUrl}/api/events/${eventId}/screenshots`, {
      method: 'POST',
      headers: { 'x-telegram-init-data': adminInitData },
      body: form,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.itemIds).toHaveLength(10);

    const row = db.prepare('SELECT image_path FROM items WHERE id = ?').get(body.itemIds[0]) as any;
    expect(row.image_path.startsWith('items/')).toBe(true);
  });
});
```

- [ ] **Step 2: Write the failing items test**

```typescript
// tests/server/routes/items.test.ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/server/routes/screenshots.test.ts tests/server/routes/items.test.ts`
Expected: FAIL — 404s on `/api/events/:id/screenshots`, `/api/items/:id`, `/api/items/:id/claim`.

- [ ] **Step 4: Implement `routes/screenshots.ts`**

```typescript
// src/server/routes/screenshots.ts
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';
import { sliceImageToCells } from '../grid-slice';

export function registerScreenshotRoutes(app: FastifyInstance, deps: AppDeps) {
  app.post<{ Params: { id: string } }>(
    '/events/:id/screenshots',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const eventId = Number(request.params.id);
      const data = await request.file();
      if (!data) {
        reply.code(400).send({ error: 'file is required' });
        return;
      }

      const fields = data.fields as Record<string, { value?: string } | undefined>;
      const rows = Number(fields.rows?.value);
      const cols = Number(fields.cols?.value);
      if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1) {
        reply.code(400).send({ error: 'rows and cols must be positive integers, sent before the file field' });
        return;
      }

      const uploadsDir = path.join(deps.dataDir, 'uploads');
      const originalsDir = path.join(uploadsDir, 'originals');
      await fs.mkdir(originalsDir, { recursive: true });
      const originalPath = path.join(originalsDir, `${eventId}-${Date.now()}.png`);
      await pipeline(data.file, createWriteStream(originalPath));

      const userId = request.telegramUser!.telegramId;
      const screenshotId = deps.db
        .prepare('INSERT INTO screenshots (event_id, original_path, rows, cols, uploaded_by) VALUES (?, ?, ?, ?, ?)')
        .run(eventId, originalPath, rows, cols, userId).lastInsertRowid as number;

      const itemsDir = path.join(uploadsDir, 'items');
      const cellPaths = await sliceImageToCells(originalPath, rows, cols, itemsDir, `ss${screenshotId}`);
      const relativePaths = cellPaths.map((p) => path.relative(uploadsDir, p).split(path.sep).join('/'));

      const insertItem = deps.db.prepare(
        "INSERT INTO items (event_id, screenshot_id, name, image_path, status) VALUES (?, ?, '', ?, 'pool')"
      );
      const itemIds = relativePaths.map(
        (relPath) => insertItem.run(eventId, screenshotId, relPath).lastInsertRowid as number
      );

      return { screenshotId, itemIds };
    }
  );
}
```

- [ ] **Step 5: Implement `routes/items.ts`**

```typescript
// src/server/routes/items.ts
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';

export function registerItemRoutes(app: FastifyInstance, deps: AppDeps) {
  app.put<{ Params: { id: string }; Body: { name: string } }>(
    '/items/:id',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const name = request.body?.name?.trim();
      if (!name) {
        reply.code(400).send({ error: 'name is required' });
        return;
      }
      deps.db.prepare('UPDATE items SET name = ? WHERE id = ?').run(name, Number(request.params.id));
      return { ok: true };
    }
  );

  app.delete<{ Params: { id: string } }>('/items/:id', { preHandler: requireAdmin(deps) }, async (request) => {
    deps.db.prepare("UPDATE items SET status = 'removed' WHERE id = ?").run(Number(request.params.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/items/:id/claim', async (request, reply) => {
    const itemId = Number(request.params.id);
    const userId = request.telegramUser!.telegramId;

    const item = deps.db.prepare('SELECT event_id, status FROM items WHERE id = ?').get(itemId) as
      | { event_id: number; status: string }
      | undefined;
    if (!item || item.status !== 'pool') {
      reply.code(409).send({ error: 'item is not claimable' });
      return;
    }

    const { max_simultaneous_claims: limit } = deps.db
      .prepare('SELECT max_simultaneous_claims FROM settings WHERE id = 1')
      .get() as { max_simultaneous_claims: number };

    const { count } = deps.db
      .prepare(
        `SELECT COUNT(*) as count FROM claims c
         JOIN items i ON i.id = c.item_id
         WHERE c.telegram_id = ? AND i.event_id = ? AND i.status = 'pool'`
      )
      .get(userId, item.event_id) as { count: number };

    if (count >= limit) {
      reply.code(409).send({ error: `claim limit of ${limit} reached` });
      return;
    }

    deps.db.prepare('INSERT OR IGNORE INTO claims (item_id, telegram_id) VALUES (?, ?)').run(itemId, userId);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/items/:id/claim', async (request) => {
    const itemId = Number(request.params.id);
    const userId = request.telegramUser!.telegramId;
    deps.db.prepare('DELETE FROM claims WHERE item_id = ? AND telegram_id = ?').run(itemId, userId);
    return { ok: true };
  });
}
```

- [ ] **Step 6: Wire both into `server.ts`**

Add `registerScreenshotRoutes(api, deps);` and `registerItemRoutes(api, deps);` inside the `/api` plugin block, and their imports at the top:

```typescript
import { registerScreenshotRoutes } from './routes/screenshots';
import { registerItemRoutes } from './routes/items';
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS — full suite green (all tasks 2–12).

- [ ] **Step 8: Commit**

```bash
git add src/server/routes/screenshots.ts src/server/routes/items.ts src/server/server.ts tests/server/routes/screenshots.test.ts tests/server/routes/items.test.ts
git commit -m "feat: add screenshot grid-upload and items claim API"
```

---

### Task 13: Telegram bot and server entrypoint

**Files:**
- Create: `src/server/bot.ts`
- Create: `src/server/index.ts`

**Interfaces:**
- Consumes: `loadConfig` (Task 5), `openDb` (Task 6), `buildServer` (Task 8).
- Produces: the runnable service (`npm run dev:server` / `npm start`).

This task is a thin wiring layer with no independent branching logic, so per the Global Constraint on testing scope it gets a manual smoke check instead of a unit test.

- [ ] **Step 1: Implement `bot.ts`**

```typescript
// src/server/bot.ts
import { Telegraf, Markup } from 'telegraf';

export function createBot(botToken: string, miniAppUrl: string) {
  const bot = new Telegraf(botToken);
  bot.start((ctx) =>
    ctx.reply('Открыть аукцион лута', Markup.inlineKeyboard([Markup.button.webApp('Открыть', miniAppUrl)]))
  );
  return bot;
}
```

- [ ] **Step 2: Implement `index.ts`**

```typescript
// src/server/index.ts
import path from 'node:path';
import { loadConfig } from './config';
import { openDb } from './db';
import { buildServer } from './server';
import { createBot } from './bot';

const config = loadConfig();
const db = openDb(path.join(config.dataDir, 'app.db'));
const app = buildServer(
  { db, botToken: config.botToken, adminTelegramIds: config.adminTelegramIds, dataDir: config.dataDir },
  path.join(process.cwd(), 'dist', 'web')
);
const bot = createBot(config.botToken, config.miniAppUrl);

app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then(() => {
    console.log(`Server listening on port ${config.port}`);
    return bot.launch();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
```

- [ ] **Step 3: Manual verification — server boots and rejects unauthenticated requests**

Create a real `.env` from `.env.example` with a throwaway `BOT_TOKEN` (from @BotFather) and your own Telegram id in `ADMIN_TELEGRAM_IDS`.

Run: `npm run dev:server`
Expected: console prints "Server listening on port 3000" and the bot starts without throwing.

In another terminal:

```bash
curl -i http://localhost:3000/api/settings
```

Expected: `401` with body `{"error":"missing init data"}` — confirms routing, auth, and DB wiring all work end-to-end.

- [ ] **Step 4: Commit**

```bash
git add src/server/bot.ts src/server/index.ts
git commit -m "feat: wire Telegram bot and server entrypoint"
```

---

### Task 14: Frontend scaffold (Vite, Telegram SDK wrapper, API client)

**Files:**
- Create: `vite.config.ts`
- Create: `web/index.html`
- Create: `web/style.css`
- Create: `web/telegram.ts`
- Create: `web/api.ts`

**Interfaces:**
- Produces: `getTelegramWebApp(): { initData: string }`, `apiFetch(path: string, options?: RequestInit): Promise<any>` — consumed by every view in Tasks 15–17.

- [ ] **Step 1: Create `vite.config.ts`**

```typescript
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/uploads': 'http://localhost:3000',
    },
  },
});
```

- [ ] **Step 2: Create `web/index.html`**

```html
<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Аукцион лута</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Create `web/style.css`**

```css
body {
  font-family: system-ui, sans-serif;
  margin: 0;
  padding: 1rem;
}
.tabs button {
  margin-right: 0.5rem;
}
.tabs button.active {
  font-weight: bold;
}
.items {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 0.75rem;
  margin-top: 1rem;
}
.item,
.admin-item {
  border: 1px solid #ccc;
  border-radius: 8px;
  padding: 0.5rem;
  text-align: center;
}
.item img,
.admin-item img {
  max-width: 100%;
  border-radius: 4px;
}
.badge {
  color: green;
  font-weight: bold;
}
.error {
  color: red;
}
section {
  margin-bottom: 1.5rem;
}
```

- [ ] **Step 4: Create `web/telegram.ts`**

```typescript
// web/telegram.ts
interface TelegramWebApp {
  initData: string;
  ready(): void;
  expand(): void;
}

export function getTelegramWebApp(): TelegramWebApp {
  const webApp = (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
  if (!webApp) throw new Error('Открой это приложение через кнопку в Telegram-боте');
  webApp.ready();
  webApp.expand();
  return webApp;
}
```

- [ ] **Step 5: Create `web/api.ts`**

```typescript
// web/api.ts
import { getTelegramWebApp } from './telegram';

export async function apiFetch(path: string, options: RequestInit = {}) {
  const webApp = getTelegramWebApp();
  const headers = new Headers(options.headers);
  headers.set('x-telegram-init-data', webApp.initData);

  const res = await fetch(`/api${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}
```

- [ ] **Step 6: Manual verification**

Run: `npm run dev:web`
Expected: Vite dev server starts on port 5173 (or similar) with no build errors. Opening it in a plain browser (not inside Telegram) shows a blank page and a console error "Открой это приложение через кнопку в Telegram-боте" once `main.ts` exists (Task 15) — that's expected, since `window.Telegram.WebApp.initData` is only populated inside the real Telegram client. Full interactive verification happens after deployment (Task 18) via the bot's Mini App button.

- [ ] **Step 7: Commit**

```bash
git add vite.config.ts web/index.html web/style.css web/telegram.ts web/api.ts
git commit -m "feat: scaffold Vite frontend with Telegram SDK wrapper"
```

---

### Task 15: Frontend profile and pool views, app shell

**Files:**
- Create: `web/views/profile.ts`
- Create: `web/views/pool.ts`
- Create: `web/main.ts`

**Interfaces:**
- Consumes: `apiFetch` (Task 14), `GET/PUT /api/me` (Task 9), `GET /api/events/current` (Task 11), `POST/DELETE /api/items/:id/claim` (Task 12).
- Produces: `renderProfilePrompt(root, me, onSaved)`, `renderPool(root, me)` — `renderPool` is also consumed by Task 16's `main.ts` tab switch (already wired here) and reused by Task 17.

- [ ] **Step 1: Create `web/views/profile.ts`**

```typescript
// web/views/profile.ts
import { apiFetch } from '../api';

export function renderProfilePrompt(root: HTMLElement, me: { gameNickname: string | null }, onSaved: () => void) {
  root.innerHTML = `
    <form id="profile-form">
      <label>Твой игровой ник:
        <input name="gameNickname" required value="${me.gameNickname ?? ''}" />
      </label>
      <button type="submit">Сохранить</button>
      <p id="profile-error" class="error"></p>
    </form>
  `;

  const form = root.querySelector('#profile-form') as HTMLFormElement;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const gameNickname = (new FormData(form).get('gameNickname') as string).trim();
    try {
      await apiFetch('/me', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gameNickname }),
      });
      onSaved();
    } catch (err) {
      (root.querySelector('#profile-error') as HTMLElement).textContent = (err as Error).message;
    }
  });
}
```

- [ ] **Step 2: Create `web/views/pool.ts`**

```typescript
// web/views/pool.ts
import { apiFetch } from '../api';

interface Item {
  id: number;
  name: string;
  imagePath: string;
  status: 'pool' | 'auctioned' | 'removed';
  winnerNickname: string | null;
  claimedByMe: number;
}

let countdownTimer: ReturnType<typeof setInterval> | undefined;

export async function renderPool(root: HTMLElement) {
  if (countdownTimer) clearInterval(countdownTimer);
  root.innerHTML = '<p>Загрузка...</p>';

  const data = await apiFetch('/events/current');
  if (!data.event) {
    root.innerHTML = '<p>Пока нет активного ивента.</p>';
    return;
  }

  root.innerHTML = `<p id="deadline"></p><div class="items"></div>`;

  const deadlineEl = root.querySelector('#deadline') as HTMLElement;
  const deadlineAt: Date | null = data.event.deadlineAt ? new Date(data.event.deadlineAt) : null;
  const updateCountdown = () => {
    if (!deadlineAt) {
      deadlineEl.textContent = '';
      return;
    }
    const msLeft = deadlineAt.getTime() - Date.now();
    deadlineEl.textContent =
      msLeft > 0
        ? `Приём заявок до ${deadlineAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
        : 'Приём заявок окончен';
  };
  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 1000);

  const itemsEl = root.querySelector('.items') as HTMLElement;
  itemsEl.innerHTML = (data.items as Item[])
    .map(
      (item) => `
      <div class="item" data-id="${item.id}">
        <img src="/uploads/${item.imagePath}" alt="${item.name}" />
        <p>${item.name}</p>
        ${
          item.status === 'auctioned'
            ? `<p class="badge">Разыграно: ${item.winnerNickname ?? '—'}</p>`
            : `<button data-action="${item.claimedByMe ? 'unclaim' : 'claim'}">${
                item.claimedByMe ? 'Отказаться' : 'Хочу'
              }</button>`
        }
      </div>`
    )
    .join('');

  itemsEl.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', async () => {
      const itemEl = button.closest('.item') as HTMLElement;
      const id = itemEl.dataset.id;
      const action = button.getAttribute('data-action');
      try {
        await apiFetch(`/items/${id}/claim`, { method: action === 'claim' ? 'POST' : 'DELETE' });
        await renderPool(root);
      } catch (err) {
        alert((err as Error).message);
      }
    });
  });
}
```

- [ ] **Step 3: Create `web/main.ts`**

```typescript
// web/main.ts
import { apiFetch } from './api';
import { renderProfilePrompt } from './views/profile';
import { renderPool } from './views/pool';

interface Me {
  telegramId: number;
  username: string | null;
  gameNickname: string | null;
  isAdmin: boolean;
}

async function main() {
  const root = document.getElementById('app')!;
  root.textContent = 'Загрузка...';

  let me: Me;
  try {
    me = await apiFetch('/me');
  } catch (err) {
    root.textContent = `Ошибка: ${(err as Error).message}`;
    return;
  }

  if (!me.gameNickname) {
    renderProfilePrompt(root, me, () => main());
    return;
  }

  renderShell(root, me);
}

function renderShell(root: HTMLElement, me: Me) {
  root.innerHTML = `
    <nav class="tabs">
      <button data-tab="pool" class="active">Лоты</button>
    </nav>
    <div id="tab-content"></div>
  `;
  const content = root.querySelector('#tab-content') as HTMLElement;
  renderPool(content);
  void me; // admin tab wired in Task 16
}

main();
```

- [ ] **Step 4: Manual verification**

Run `npm run dev:server` in one terminal and `npm run dev:web` in another. Deploy to the VPS is required for a real Telegram-context check (Task 18); for now confirm there are no TypeScript/build errors:

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add web/views/profile.ts web/views/pool.ts web/main.ts
git commit -m "feat: add profile and pool views with claim/unclaim flow"
```

---

### Task 16: Frontend admin view

**Files:**
- Create: `web/views/admin.ts`
- Modify: `web/main.ts` (add the admin tab for admins)

**Interfaces:**
- Consumes: `apiFetch` (Task 14), `POST /api/events`, `POST /api/events/:id/resolve` (Task 11), `POST /api/events/:id/screenshots` (Task 12), `PUT/DELETE /api/items/:id` (Task 12), `GET/PUT /api/settings` (Task 10).
- Produces: `renderAdmin(root, me)`.

- [ ] **Step 1: Create `web/views/admin.ts`**

```typescript
// web/views/admin.ts
import { apiFetch } from '../api';
import { getTelegramWebApp } from '../telegram';

export async function renderAdmin(root: HTMLElement) {
  root.innerHTML = `
    <section>
      <h3>Новый ивент</h3>
      <form id="event-form">
        <input name="title" placeholder="Название ивента" required />
        <input name="durationMinutes" type="number" placeholder="Минут на приём заявок" value="25" required />
        <button type="submit">Создать</button>
      </form>
    </section>
    <section>
      <h3>Загрузить скриншот</h3>
      <form id="screenshot-form">
        <input name="rows" type="number" placeholder="Строк" required />
        <input name="cols" type="number" placeholder="Столбцов" required />
        <input name="file" type="file" accept="image/*" required />
        <button type="submit">Нарезать</button>
      </form>
    </section>
    <section>
      <h3>Текущий ивент</h3>
      <div id="event-items"></div>
      <button id="resolve-btn">Разыграть всё</button>
    </section>
    <section>
      <h3>Настройки</h3>
      <form id="settings-form">
        <label>Лимит заявок на человека:
          <input name="maxSimultaneousClaims" type="number" required />
        </label>
        <button type="submit">Сохранить</button>
      </form>
    </section>
    <p id="admin-error" class="error"></p>
  `;

  const errorEl = root.querySelector('#admin-error') as HTMLElement;
  const showError = (err: unknown) => {
    errorEl.textContent = (err as Error).message;
  };

  async function loadEventItems() {
    const current = await apiFetch('/events/current');
    const itemsEl = root.querySelector('#event-items') as HTMLElement;
    if (!current.event) {
      itemsEl.innerHTML = '<p>Нет активного ивента</p>';
      return;
    }
    itemsEl.innerHTML = `<p>${current.event.title} — ${current.event.status}</p>` +
      current.items
        .map(
          (item: any) => `
          <div class="admin-item" data-id="${item.id}">
            <img src="/uploads/${item.imagePath}" />
            <input value="${item.name}" data-role="name" />
            <button data-action="save-name">Сохранить имя</button>
            <button data-action="remove">Убрать</button>
            <span>${item.status}</span>
          </div>`
        )
        .join('');

    itemsEl.querySelectorAll('[data-action="save-name"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const itemEl = button.closest('.admin-item') as HTMLElement;
        const name = (itemEl.querySelector('[data-role="name"]') as HTMLInputElement).value;
        try {
          await apiFetch(`/items/${itemEl.dataset.id}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
          });
        } catch (err) {
          showError(err);
        }
      });
    });

    itemsEl.querySelectorAll('[data-action="remove"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const itemEl = button.closest('.admin-item') as HTMLElement;
        try {
          await apiFetch(`/items/${itemEl.dataset.id}`, { method: 'DELETE' });
          await loadEventItems();
        } catch (err) {
          showError(err);
        }
      });
    });
  }

  (root.querySelector('#event-form') as HTMLFormElement).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);
    try {
      await apiFetch('/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: fd.get('title'), durationMinutes: Number(fd.get('durationMinutes')) }),
      });
      await loadEventItems();
    } catch (err) {
      showError(err);
    }
  });

  (root.querySelector('#screenshot-form') as HTMLFormElement).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    try {
      const current = await apiFetch('/events/current');
      if (!current.event) throw new Error('Сначала создай ивент');
      const webApp = getTelegramWebApp();
      const res = await fetch(`/api/events/${current.event.id}/screenshots`, {
        method: 'POST',
        headers: { 'x-telegram-init-data': webApp.initData },
        body: new FormData(form),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await loadEventItems();
      form.reset();
    } catch (err) {
      showError(err);
    }
  });

  (root.querySelector('#resolve-btn') as HTMLButtonElement).addEventListener('click', async () => {
    try {
      const current = await apiFetch('/events/current');
      if (!current.event) throw new Error('Нет активного ивента');
      await apiFetch(`/events/${current.event.id}/resolve`, { method: 'POST' });
      await loadEventItems();
    } catch (err) {
      showError(err);
    }
  });

  const settingsForm = root.querySelector('#settings-form') as HTMLFormElement;
  const currentSettings = await apiFetch('/settings');
  (settingsForm.elements.namedItem('maxSimultaneousClaims') as HTMLInputElement).value = String(
    currentSettings.maxSimultaneousClaims
  );
  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxSimultaneousClaims: Number(new FormData(settingsForm).get('maxSimultaneousClaims')) }),
      });
    } catch (err) {
      showError(err);
    }
  });

  await loadEventItems();
}
```

- [ ] **Step 2: Wire the admin tab into `web/main.ts`**

Replace the body of `renderShell` with:

```typescript
function renderShell(root: HTMLElement, me: Me) {
  root.innerHTML = `
    <nav class="tabs">
      <button data-tab="pool" class="active">Лоты</button>
      ${me.isAdmin ? '<button data-tab="admin">Админ</button>' : ''}
    </nav>
    <div id="tab-content"></div>
  `;
  const content = root.querySelector('#tab-content') as HTMLElement;
  renderPool(content);

  root.querySelectorAll('nav button').forEach((button) => {
    button.addEventListener('click', () => {
      root.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      if (button.getAttribute('data-tab') === 'admin') renderAdmin(content);
      else renderPool(content);
    });
  });
}
```

Add the import at the top: `import { renderAdmin } from './views/admin';`

- [ ] **Step 3: Manual verification**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run build:web`
Expected: build succeeds, `dist/web` is produced.

- [ ] **Step 4: Commit**

```bash
git add web/views/admin.ts web/main.ts
git commit -m "feat: add admin view (events, screenshots, resolve, settings)"
```

---

### Task 17: Deployment files

**Files:**
- Create: `deploy/nginx.conf.example`
- Create: `deploy/loot-auction.service.example`
- Create: `README.md`

**Interfaces:**
- Produces: reference configs for the VPS deploy; no code interfaces.

- [ ] **Step 1: Create `deploy/nginx.conf.example`**

```nginx
server {
    listen 80;
    server_name your-domain.example;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name your-domain.example;

    ssl_certificate     /etc/letsencrypt/live/your-domain.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.example/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

- [ ] **Step 2: Create `deploy/loot-auction.service.example`**

```ini
[Unit]
Description=Loot Auction Mini App
After=network.target

[Service]
WorkingDirectory=/opt/loot-auction
ExecStart=/usr/bin/npx tsx src/server/index.ts
Restart=on-failure
EnvironmentFile=/opt/loot-auction/.env
User=loot-auction

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Create `README.md`**

```markdown
# Loot Auction Mini App

## Local development

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `BOT_TOKEN` (from @BotFather), `ADMIN_TELEGRAM_IDS`, and `MINI_APP_URL`.
3. `npm run dev:server` in one terminal, `npm run dev:web` in another.
4. `npm test` runs the backend unit tests.

## Deploying to a VPS

1. Provision a small VPS with a domain pointed at it.
2. Install Node.js 20+, then `git clone` this repo into `/opt/loot-auction`.
3. `npm install`, `npm run build:web`.
4. Copy `.env.example` to `/opt/loot-auction/.env` and fill in real values, with `MINI_APP_URL` set to `https://your-domain.example`.
5. `certbot --nginx -d your-domain.example` to obtain a TLS certificate.
6. Copy `deploy/nginx.conf.example` to `/etc/nginx/sites-available/loot-auction`, adjust `server_name` and cert paths, symlink into `sites-enabled`, `nginx -t && systemctl reload nginx`.
7. Copy `deploy/loot-auction.service.example` to `/etc/systemd/system/loot-auction.service`, adjust paths/user, then:
   ```bash
   systemctl daemon-reload
   systemctl enable --now loot-auction
   ```
8. In @BotFather, set the bot's Mini App / Menu Button URL to `https://your-domain.example`.
9. Open the bot in Telegram, send `/start`, tap the button — confirms the full stack end to end.
```

- [ ] **Step 4: Commit**

```bash
git add deploy/nginx.conf.example deploy/loot-auction.service.example README.md
git commit -m "docs: add deployment configs and setup instructions"
```

---

## Self-Review Notes

- **Spec coverage:** Architecture (Task 1, 8, 13, 17), data model (Task 6), admin flow create-event/upload/name/resolve/remove (Tasks 11, 12, 16), user flow profile/claim/countdown/badge (Tasks 9, 11, 12, 15), auth (Tasks 2, 8), error handling for uneven grids/double-resolve/over-limit claims (Tasks 4, 11, 12), testing scope (Tasks 2–4, 6, 8–12). All spec sections have a task.
- **Placeholder scan:** no TBD/TODO; every step has runnable code or an exact command.
- **Type consistency:** `AppDeps` (Task 7) is used identically across Tasks 8–12; `TelegramUser { telegramId, username? }` (Task 2) matches `request.telegramUser` usage in Tasks 9–12; `image_path`/`imagePath` naming is consistent between the DB column, the `events/current` SQL alias, and the frontend's `/uploads/${item.imagePath}` usage (Tasks 11, 15, 16).
