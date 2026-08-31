# Invasion Vision Recognition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace invasion's fixed pixel-grid screenshot recognition with a Claude vision call against the game's "Трофеи" recap screen — variable row/icon count, quantity read from each icon's own `×N` badge instead of inferred by counting duplicate rows. Feast's recognition is untouched.

**Architecture:** New `src/server/vision.ts` module calls Anthropic's Messages API (forced tool-use for guaranteed-valid structured JSON) and returns a flat list of `{x, y, w, h, rarity, quantity}` per reward icon. `screenshots.ts`'s upload handler branches per-file on `template`: feast keeps today's local grid-slice + pixel color-sample path; invasion calls `extractInvasionLoot` once per screenshot and crops each returned box with the existing `cropBox` utility. Both paths converge into a shared `LotCandidate[]` (`{screenshotId, imagePath, color, quantity}`) before the existing icon-signature dedup/grouping/insert logic runs, which changes in exactly one place: quantity is **summed** across a group's candidates instead of counted, so a `×2` and a `×1` of the same icon on one screenshot correctly become one lot with quantity 3 (a no-op change for feast, where every candidate already carries `quantity: 1`).

**Tech Stack:** TypeScript, Fastify, better-sqlite3, sharp, vitest. No new npm dependency — the vision call is a plain `fetch` (Node 20+ has it built in).

**Spec:** [docs/superpowers/specs/2026-08-31-invasion-vision-recognition-design.md](../specs/2026-08-31-invasion-vision-recognition-design.md)

## Global Constraints

- No boss name or rank/place extraction — the model is told to ignore that part of the screenshot and return only reward icons (spec: Non-goals).
- No change to feast's recognition path, `color-detect.ts`'s pixel sampling, or `layout-templates.ts`'s `feast` entry (spec: Non-goals).
- No new npm dependency (spec: Non-goals, Architecture).
- No caching of vision results across retries — a retried upload just calls the API again (spec: Non-goals).
- No configurable model/prompt — `claude-sonnet-5` and the prompt text are constants in `vision.ts` (spec: Non-goals). Confirmed with the user: Sonnet is the right tier for this task (structured extraction, not creative reasoning); bump to Opus later only if accuracy proves insufficient in practice.
- No client-side image-format change — the vision call reuses the client's existing JPEG-compressed bytes, declared as `image/jpeg` (spec: Non-goals).
- `ANTHROPIC_API_KEY` is optional at config-load time (feast-only deployments and every existing test don't need it); `vision.ts` throws its own clear error if actually called without one (spec: Config & wiring).
- `rows` stops being read/required for `template === 'invasion'` — the model determines layout itself. It stays required for `feast` (spec: `screenshots.ts`).

---

## File Structure

```
src/server/vision.ts               — new: Claude vision call + response validation
src/server/config.ts               — add optional anthropicApiKey
src/server/types.ts                — add optional anthropicApiKey to AppDeps
src/server/index.ts                — thread config.anthropicApiKey into AppDeps
src/server/layout-templates.ts     — drop the invasion entry (dead once vision replaces it)
src/server/color-detect.ts         — narrow detectColor's template param to 'feast'
src/server/routes/screenshots.ts   — per-template candidate extraction, summed quantity
web/views/eventDetail.ts           — hide/un-require the rows field when invasion is selected
.env.example                       — document ANTHROPIC_API_KEY
HANDOFF.md                         — status notes
tests/server/vision.test.ts        — new
tests/server/color-detect.test.ts  — drop dead invasion-specific cases
tests/server/routes/screenshots.test.ts — mock vision.ts, new invasion-specific cases
```

Untouched: `src/server/grid-slice.ts` (`cropBox` is reused as-is — a `VisionLotItem`'s `{x,y,w,h}` is exactly the `Box` shape it already accepts), `src/server/dedup.ts`, `src/server/lot-library.ts`, `src/server/db.ts` (no schema change — `screenshots.rows` stays `NOT NULL`; invasion uploads just insert `0` as an unused placeholder, cheaper than a migration for a column nothing reads back).

---

### Task 1: Vision module

**Files:**
- Create: `src/server/vision.ts`
- Create: `tests/server/vision.test.ts`

**Interfaces:**
- Produces: `export interface VisionLotItem { x: number; y: number; w: number; h: number; rarity: 'blue' | 'purple' | 'red'; quantity: number }` and `export async function extractInvasionLoot(imageBuffer: Buffer, apiKey: string): Promise<VisionLotItem[]>` — Task 4's `screenshots.ts` rewrite imports both.

- [ ] **Step 1: Write the failing tests in `tests/server/vision.test.ts`**

```typescript
import { describe, it, expect, afterEach, vi } from 'vitest';
import { extractInvasionLoot } from '../../src/server/vision';

describe('extractInvasionLoot', () => {
  const fakeImage = Buffer.from('fake-image-bytes');

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetchOnce(response: { ok: boolean; status?: number; json?: () => Promise<unknown>; text?: () => Promise<string> }) {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('throws without calling fetch when apiKey is empty', async () => {
    const fetchMock = mockFetchOnce({ ok: true, json: async () => ({}) });
    await expect(extractInvasionLoot(fakeImage, '')).rejects.toThrow('ANTHROPIC_API_KEY is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the image as base64 with a forced tool_choice, and parses a valid tool_use response', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'tool_use',
            name: 'extract_trophy_loot',
            input: {
              items: [{ x: 0.1, y: 0.2, w: 0.1, h: 0.1, rarity: 'purple', quantity: 2 }],
            },
          },
        ],
      }),
    });

    const result = await extractInvasionLoot(fakeImage, 'test-key');
    expect(result).toEqual([{ x: 0.1, y: 0.2, w: 0.1, h: 0.1, rarity: 'purple', quantity: 2 }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(options.headers['x-api-key']).toBe('test-key');
    expect(options.headers['anthropic-version']).toBeTruthy();

    const body = JSON.parse(options.body);
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'extract_trophy_loot' });
    const imageBlock = body.messages[0].content.find((b: any) => b.type === 'image');
    expect(imageBlock.source.media_type).toBe('image/jpeg');
    expect(imageBlock.source.data).toBe(fakeImage.toString('base64'));
    const textBlock = body.messages[0].content.find((b: any) => b.type === 'text');
    expect(textBlock.text.toLowerCase()).toContain('трофеи');
    expect(textBlock.text.toLowerCase()).toMatch(/игнорир/); // instructed to ignore boss name/rank
  });

  it('throws with the status code when the API responds non-2xx', async () => {
    mockFetchOnce({ ok: false, status: 500, text: async () => 'server error' });
    await expect(extractInvasionLoot(fakeImage, 'test-key')).rejects.toThrow(/500/);
  });

  it('throws when the response has no tool_use block', async () => {
    mockFetchOnce({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'oops' }] }) });
    await expect(extractInvasionLoot(fakeImage, 'test-key')).rejects.toThrow('tool_use');
  });

  it('throws when an item fails validation (bad rarity)', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', input: { items: [{ x: 0.1, y: 0.1, w: 0.1, h: 0.1, rarity: 'green', quantity: 1 }] } }],
      }),
    });
    await expect(extractInvasionLoot(fakeImage, 'test-key')).rejects.toThrow('rarity');
  });

  it('throws when an item has a non-integer quantity', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', input: { items: [{ x: 0.1, y: 0.1, w: 0.1, h: 0.1, rarity: 'blue', quantity: 1.5 }] } }],
      }),
    });
    await expect(extractInvasionLoot(fakeImage, 'test-key')).rejects.toThrow('quantity');
  });

  it('throws when a box coordinate is out of the 0..1 range', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', input: { items: [{ x: 1.5, y: 0.1, w: 0.1, h: 0.1, rarity: 'blue', quantity: 1 }] } }],
      }),
    });
    await expect(extractInvasionLoot(fakeImage, 'test-key')).rejects.toThrow('x/y/w/h');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/server/vision.test.ts`
Expected: FAIL — `src/server/vision.ts` doesn't exist yet (module-not-found).

- [ ] **Step 3: Create `src/server/vision.ts`**

```typescript
const MODEL = 'claude-sonnet-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface VisionLotItem {
  x: number;
  y: number;
  w: number;
  h: number;
  rarity: 'blue' | 'purple' | 'red';
  quantity: number;
}

// Fraction-of-image box tightly around the icon + its rarity frame + its own ×N
// quantity badge — matches grid-slice.ts's Box shape exactly, so the caller can crop
// it with the same cropBox() feast already uses for its iconBox. Boss name and
// place/rank are explicitly excluded — the admin only cares about the loot itself.
const PROMPT = `Это скриншот экрана "Трофеи" из мобильной игры — список побеждённых боссов, у каждого своя строка с наградами. Для КАЖДОЙ иконки награды на скриншоте (по всем строкам) верни:
- рамку (x, y, w, h — доли от размера всей картинки, 0..1), плотно обхватывающую саму иконку награды вместе с её рамкой редкости и числом-бейджиком в углу (без имени босса, без места/медали и без окружающего текста);
- rarity — цвет рамки редкости иконки: "blue", "purple" или "red";
- quantity — число с маленького бейджика "×N" в углу иконки (если бейджика не видно, используй 1).

Игнорируй имя босса и место (медаль/1/2/3/4) — они не нужны. Верни только сами иконки наград.`;

export async function extractInvasionLoot(imageBuffer: Buffer, apiKey: string): Promise<VisionLotItem[]> {
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      tools: [
        {
          name: 'extract_trophy_loot',
          description: 'Records every reward icon found on the trophies screenshot.',
          input_schema: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                    w: { type: 'number' },
                    h: { type: 'number' },
                    rarity: { type: 'string', enum: ['blue', 'purple', 'red'] },
                    quantity: { type: 'integer', minimum: 1 },
                  },
                  required: ['x', 'y', 'w', 'h', 'rarity', 'quantity'],
                },
              },
            },
            required: ['items'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'extract_trophy_loot' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBuffer.toString('base64') } },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content?: { type: string; input?: unknown }[] };
  const toolUse = data.content?.find((block) => block.type === 'tool_use') as
    | { type: 'tool_use'; input?: { items?: unknown[] } }
    | undefined;
  if (!toolUse || !Array.isArray(toolUse.input?.items)) {
    throw new Error('Anthropic API response did not include the expected tool_use block');
  }

  return toolUse.input.items.map((raw, i) => validateItem(raw, i));
}

function validateItem(raw: unknown, index: number): VisionLotItem {
  const item = raw as Partial<VisionLotItem>;
  const isFraction = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  if (!isFraction(item.x) || !isFraction(item.y) || !isFraction(item.w) || !isFraction(item.h)) {
    throw new Error(`item ${index}: x/y/w/h must be numbers between 0 and 1`);
  }
  if (item.rarity !== 'blue' && item.rarity !== 'purple' && item.rarity !== 'red') {
    throw new Error(`item ${index}: rarity must be blue, purple, or red`);
  }
  if (!Number.isInteger(item.quantity) || (item.quantity as number) < 1) {
    throw new Error(`item ${index}: quantity must be a positive integer`);
  }
  return { x: item.x, y: item.y, w: item.w, h: item.h, rarity: item.rarity, quantity: item.quantity };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/server/vision.test.ts`
Expected: PASS

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors in `vision.ts`/`vision.test.ts` (other files may still error until later tasks land — only this task's own files need to be clean now).

- [ ] **Step 6: Commit**

```bash
git add src/server/vision.ts tests/server/vision.test.ts
git commit -m "$(cat <<'EOF'
Add Claude vision module for invasion loot extraction

extractInvasionLoot() sends a screenshot to Anthropic's Messages API
with a forced tool call so the response is guaranteed-valid structured
JSON (per-icon bounding box, rarity, and the quantity read off its own
×N badge) instead of free-text parsing. Plain fetch, no new dependency.
EOF
)"
```

---

### Task 2: Config & dependency wiring

**Files:**
- Modify: `src/server/config.ts`
- Modify: `src/server/types.ts`
- Modify: `src/server/index.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `AppDeps.anthropicApiKey?: string`, threaded from `Config.anthropicApiKey?: string` — Task 4's `screenshots.ts` reads `deps.anthropicApiKey`.

- [ ] **Step 1: Add `anthropicApiKey` to `Config` in `src/server/config.ts`**

Replace the `Config` interface:

```typescript
export interface Config {
  botToken: string;
  adminTelegramIds: number[];
  port: number;
  dataDir: string;
  miniAppUrl: string;
  anthropicApiKey?: string;
}
```

Replace the `loadConfig` return statement:

```typescript
  return {
    botToken,
    miniAppUrl,
    adminTelegramIds: (env.ADMIN_TELEGRAM_IDS ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
    port: Number(env.PORT ?? 3000),
    dataDir: path.resolve(env.DATA_DIR ?? 'data'),
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
  };
```

- [ ] **Step 2: Add `anthropicApiKey` to `AppDeps` in `src/server/types.ts`**

```typescript
import type { Db } from './db';

export interface AppDeps {
  db: Db;
  botToken: string;
  adminTelegramIds: number[];
  dataDir: string;
  anthropicApiKey?: string;
}
```

- [ ] **Step 3: Thread it through in `src/server/index.ts`**

Replace the `buildServer` call's deps object:

```typescript
const app = buildServer(
  { db, botToken: config.botToken, adminTelegramIds: config.adminTelegramIds, dataDir: config.dataDir, anthropicApiKey: config.anthropicApiKey },
  path.join(process.cwd(), 'dist', 'web')
);
```

- [ ] **Step 4: Document the env var in `.env.example`**

Append:

```
# Only needed for invasion screenshot recognition (paid, per screenshot) — get one
# at console.anthropic.com. Feast-only deployments can leave this unset.
ANTHROPIC_API_KEY=
```

- [ ] **Step 5: Type-check and run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no new errors from this task's changes (pre-existing failures in files later tasks touch — `screenshots.ts`/`layout-templates.ts`/`color-detect.ts` — are not yours to fix here; this task's own files are `config.ts`/`types.ts`/`index.ts`, all of which should be clean and shouldn't have broken any currently-passing test, since `anthropicApiKey` is optional everywhere it's added).

- [ ] **Step 6: Commit**

```bash
git add src/server/config.ts src/server/types.ts src/server/index.ts .env.example
git commit -m "$(cat <<'EOF'
Add optional ANTHROPIC_API_KEY config, threaded through to AppDeps

Optional at load time — feast-only deployments and the existing test
suite don't need it. vision.ts throws its own clear error if it's
actually called without one.
EOF
)"
```

---

### Task 3: Drop invasion's dead pixel-grid layout

**Files:**
- Modify: `src/server/layout-templates.ts`
- Modify: `src/server/color-detect.ts`
- Modify: `tests/server/color-detect.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: `LAYOUT_TEMPLATES: Partial<Record<Template, LayoutTemplate>>` (only `feast` defined) and `detectColor(stripPath: string, template: 'feast'): Promise<RarityColor>` — Task 4's `screenshots.ts` rewrite calls `detectColor(cellPath, 'feast')` only, matching this narrowed signature.

- [ ] **Step 1: Fix the two invasion-specific tests in `tests/server/color-detect.test.ts`**

Change the red-color test (currently uses `'invasion'` only incidentally, to get a second template value — any template works for testing plain color-matching):

```typescript
  it('matches a solid red strip to red', async () => {
    const file = await solidStrip('red.png', [209, 67, 78]);
    expect(await detectColor(file, 'feast')).toBe('red');
  });
```

Delete the whole `'samples below the countdown-pill band for the invasion template'` test (its premise — invasion's specific pixel-sample coordinates — no longer applies once invasion stops calling `detectColor` at all):

```typescript
  it('samples below the countdown-pill band for the invasion template', async () => {
    // Invasion row-units have a countdown pill (top ~25%, unrelated color)
    // above the actual item card (bottom ~75%, carries the rarity color) —
    // colorSample.y = 0.62 must land in the card band, not the pill.
    const file = path.join(tmpDir, 'invasion-row.png');
    const width = 200;
    const height = 100;
    const pillHeight = Math.round(height * 0.25);
    await sharp({ create: { width, height, channels: 3, background: { r: 209, g: 67, b: 78 } } })
      .composite([
        {
          input: await sharp({
            create: { width, height: pillHeight, channels: 3, background: { r: 230, g: 180, b: 90 } },
          })
            .png()
            .toBuffer(),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toFile(file);

    expect(await detectColor(file, 'invasion')).toBe('red');
  });
```

(remove this whole block — don't leave an empty `it`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/server/color-detect.test.ts`
Expected: FAIL — `detectColor`'s signature doesn't accept `'feast'`-only yet, but more importantly this step is really about confirming there's no OTHER hidden reliance on the invasion test before you delete `layout-templates.ts`'s invasion entry in Step 3. If this run passes as-is (signature unchanged yet), that's fine — the meaningful red/green cycle for this task is Step 4 below, after Step 3's source changes; run this now mainly as a sanity check that the file edits from Step 1 didn't break syntax.

- [ ] **Step 3: Trim `src/server/layout-templates.ts`**

Change the `LAYOUT_TEMPLATES` declaration and delete the `invasion` entry:

```typescript
export const LAYOUT_TEMPLATES: Partial<Record<Template, LayoutTemplate>> = {
  feast: {
    // Measured pixel-exact from a real 1177x2560 "Пир победы" screenshot
    // (2026-08-27): row-unit (countdown pill) tops at
    // y=712/972/1231/1491/1750/2010 → contentTop=712/2560,
    // rowHeight=(2010-712)/5/2560. The old eyeballed contentTop=0.43 was
    // close by coincidence-ish but still off by several rows' worth of drift
    // by the time it reached the last row of a long list.
    contentTop: 0.278,
    rowHeight: 0.1014,
    // Sampled at the icon frame's inner-left border, clear of both the
    // corner level/material badges and the center sprite art (which can be
    // any color) — verified to classify as the item's real rarity color
    // across every row in the reference screenshot.
    colorSample: { x: 0.13, y: 0.65 },
    // The rarity-framed icon badge (level pill + sprite), left/right edges at
    // x=136/311 of 1177, top/bottom at row-offset 58/220 of a 259.5 row.
    // Measured the same way as contentTop/rowHeight above.
    iconBox: { x: 0.115, y: 0.223, w: 0.149, h: 0.626 },
  },
};
```

(the whole `invasion: { ... }` entry — contentTop 0.439 through the iconBox measurement comment — is deleted; `Template`/`isTemplate()` below it are unchanged, `'invasion'` is still a valid template value elsewhere, it just no longer indexes this record).

- [ ] **Step 4: Narrow `detectColor`'s signature in `src/server/color-detect.ts`**

Replace:

```typescript
export async function detectColor(stripPath: string, template: Template): Promise<RarityColor> {
  const { colorSample } = LAYOUT_TEMPLATES[template];
```

with:

```typescript
export async function detectColor(stripPath: string, template: 'feast'): Promise<RarityColor> {
  // Non-null assertion is safe: 'feast' is always present in LAYOUT_TEMPLATES (invasion's
  // entry was removed once its screenshots stopped using pixel-grid recognition — see
  // docs/superpowers/specs/2026-08-31-invasion-vision-recognition-design.md).
  const { colorSample } = LAYOUT_TEMPLATES[template]!;
```

Also update the import on line 2 — `Template` becomes unused once `detectColor`'s param is narrowed to the literal `'feast'` (confirmed: nothing else in this file references `Template`, and `tsconfig.json` has no `noUnusedLocals`, so this wouldn't fail `tsc` either way, but it's dead code):

```typescript
import { LAYOUT_TEMPLATES } from './layout-templates';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/server/color-detect.test.ts`
Expected: PASS

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: `layout-templates.ts`/`color-detect.ts`/`color-detect.test.ts` clean. `screenshots.ts` will show a type error here (it still calls `LAYOUT_TEMPLATES[template]` and `detectColor(cellPath, template)` with a general `Template`-typed value) — that's expected and is Task 4's job to fix, not this task's.

- [ ] **Step 7: Commit**

```bash
git add src/server/layout-templates.ts src/server/color-detect.ts tests/server/color-detect.test.ts
git commit -m "$(cat <<'EOF'
Drop invasion's dead pixel-grid layout

Invasion no longer slices by a fixed grid or samples pixel color —
see vision.ts. LAYOUT_TEMPLATES keeps only feast; detectColor's
template param narrows to 'feast' accordingly.
EOF
)"
```

---

### Task 4: `screenshots.ts` — per-template candidate extraction

**Files:**
- Modify: `src/server/routes/screenshots.ts`
- Modify: `tests/server/routes/screenshots.test.ts`

**Interfaces:**
- Consumes: `extractInvasionLoot`/`VisionLotItem` (Task 1), `deps.anthropicApiKey` (Task 2), `LAYOUT_TEMPLATES.feast`/`detectColor(path, 'feast')` (Task 3).
- Produces: no new exports — this is the integration point where everything from Tasks 1-3 gets used.

- [ ] **Step 1: Update `tests/server/routes/screenshots.test.ts`**

Add the vitest mock and import at the top of the file (right after the existing imports):

```typescript
import { extractInvasionLoot } from '../../../src/server/vision';

vi.mock('../../../src/server/vision', () => ({
  extractInvasionLoot: vi.fn(),
}));
```

(add `vi` to the existing `import { describe, it, expect, beforeEach, afterEach } from 'vitest';` line, making it `import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';`).

Replace the `beforeEach`:

```typescript
  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'screenshots-test-'));
    db = openDb(':memory:');
    app = buildServer({ db, botToken, adminTelegramIds: [1], dataDir, anthropicApiKey: 'test-key' });
    await app.listen({ port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    adminInitData = signUserInitData(1, 'admin', botToken);

    vi.mocked(extractInvasionLoot).mockReset();
    // Safe default for the many existing tests that use template='invasion' only
    // incidentally (to get a second template value, not to test vision behavior
    // itself) — tests that care about specific vision output override with
    // mockResolvedValueOnce/mockRejectedValueOnce before making their request.
    vi.mocked(extractInvasionLoot).mockResolvedValue([{ x: 0.1, y: 0.1, w: 0.3, h: 0.3, rarity: 'purple', quantity: 1 }]);
  });
```

Replace the `'crops the item image down to just the icon badge for templates with a measured iconBox'` test (its premise — invasion having a local `iconBox` — no longer holds; invasion's cropping now comes from the vision-returned box, and its color from the vision-returned rarity, not pixel sampling):

```typescript
  it('invasion crops each vision-detected icon into its own file, using the model-provided rarity', async () => {
    const createEventRes = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
      body: JSON.stringify({ title: 'Ивент 4' }),
    });
    const { id: eventId } = await createEventRes.json();

    vi.mocked(extractInvasionLoot).mockResolvedValueOnce([
      { x: 0.1, y: 0.1, w: 0.3, h: 0.3, rarity: 'red', quantity: 1 },
    ]);

    const imageBuffer = await sharp({ create: { width: 720, height: 1565, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .png()
      .toBuffer();

    const form = new FormData();
    form.append('template', 'invasion'); // rows is intentionally not sent — invasion doesn't need it
    form.append('file', new Blob([imageBuffer], { type: 'image/png' }), 'reward.png');

    const res = await fetch(`${baseUrl}/api/events/${eventId}/screenshots`, {
      method: 'POST',
      headers: { 'x-telegram-init-data': adminInitData },
      body: form,
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    const row = db.prepare('SELECT image_path, color FROM items WHERE id = ?').get(body.itemIds[0]) as any;
    expect(row.image_path).toMatch(/-icon\.png$/);
    expect(row.color).toBe('red'); // comes straight from the mocked vision response, not pixel sampling
  });
```

Add these new tests at the end of the `describe` block, right before its closing `});` (after the existing `'rejects uploading once the event is no longer draft'` test):

```typescript
  it('invasion reads quantity and rarity per icon, creating separate lots for visually distinct icons', async () => {
    const createEventRes = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
      body: JSON.stringify({ title: 'Ивент вторжение' }),
    });
    const { id: eventId } = await createEventRes.json();

    // Left half red, right half blue — two visually distinct icons on one screenshot.
    const imageBuffer = await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 209, g: 67, b: 78 } } })
      .composite([
        {
          input: await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 74, g: 144, b: 217 } } })
            .png()
            .toBuffer(),
          left: 200,
          top: 0,
        },
      ])
      .png()
      .toBuffer();

    vi.mocked(extractInvasionLoot).mockResolvedValueOnce([
      { x: 0.05, y: 0.1, w: 0.3, h: 0.7, rarity: 'red', quantity: 2 },
      { x: 0.65, y: 0.1, w: 0.3, h: 0.7, rarity: 'blue', quantity: 3 },
    ]);

    const form = new FormData();
    form.append('template', 'invasion');
    form.append('file', new Blob([imageBuffer], { type: 'image/png' }), 'reward.png');

    const res = await fetch(`${baseUrl}/api/events/${eventId}/screenshots`, {
      method: 'POST',
      headers: { 'x-telegram-init-data': adminInitData },
      body: form,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.itemIds).toHaveLength(2);

    const rows = db.prepare('SELECT color, quantity FROM items WHERE id IN (?, ?)').all(...body.itemIds) as {
      color: string;
      quantity: number;
    }[];
    const byColor = Object.fromEntries(rows.map((r) => [r.color, r.quantity]));
    expect(byColor.red).toBe(2);
    expect(byColor.blue).toBe(3);
  });

  it('invasion sums quantities when the same icon is detected more than once', async () => {
    const createEventRes = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
      body: JSON.stringify({ title: 'Ивент сумма' }),
    });
    const { id: eventId } = await createEventRes.json();

    // Solid color — any two boxes cropped from it look identical, simulating the same
    // item dropping from two different boss rows on one screenshot.
    const imageBuffer = await sharp({ create: { width: 300, height: 120, channels: 3, background: { r: 156, g: 74, b: 201 } } })
      .png()
      .toBuffer();

    vi.mocked(extractInvasionLoot).mockResolvedValueOnce([
      { x: 0.1, y: 0.1, w: 0.3, h: 0.3, rarity: 'purple', quantity: 2 },
      { x: 0.1, y: 0.1, w: 0.3, h: 0.3, rarity: 'purple', quantity: 3 },
    ]);

    const form = new FormData();
    form.append('template', 'invasion');
    form.append('file', new Blob([imageBuffer], { type: 'image/png' }), 'reward.png');

    const res = await fetch(`${baseUrl}/api/events/${eventId}/screenshots`, {
      method: 'POST',
      headers: { 'x-telegram-init-data': adminInitData },
      body: form,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.itemIds).toHaveLength(1); // same-looking icon -> one lot

    const row = db.prepare('SELECT quantity FROM items WHERE id = ?').get(body.itemIds[0]) as any;
    expect(row.quantity).toBe(5); // 2 + 3, not a count (2) or an overwrite
  });

  it('rejects an invasion upload with 400 when ANTHROPIC_API_KEY is not configured', async () => {
    const noKeyApp = buildServer({ db, botToken, adminTelegramIds: [1], dataDir });
    await noKeyApp.listen({ port: 0 });
    const address = noKeyApp.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const noKeyBaseUrl = `http://127.0.0.1:${port}`;

    try {
      const createEventRes = await fetch(`${noKeyBaseUrl}/api/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
        body: JSON.stringify({ title: 'Ивент без ключа' }),
      });
      const { id: eventId } = await createEventRes.json();

      const imageBuffer = await sharp({ create: { width: 100, height: 40, channels: 3, background: { r: 0, g: 0, b: 0 } } })
        .png()
        .toBuffer();
      const form = new FormData();
      form.append('template', 'invasion');
      form.append('file', new Blob([imageBuffer], { type: 'image/png' }), 'reward.png');

      const res = await fetch(`${noKeyBaseUrl}/api/events/${eventId}/screenshots`, {
        method: 'POST',
        headers: { 'x-telegram-init-data': adminInitData },
        body: form,
      });
      expect(res.status).toBe(400);
      expect(vi.mocked(extractInvasionLoot)).not.toHaveBeenCalled();
    } finally {
      await noKeyApp.close();
    }
  });

  it('surfaces a clear 502 error when vision extraction fails', async () => {
    const createEventRes = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
      body: JSON.stringify({ title: 'Ивент ошибка' }),
    });
    const { id: eventId } = await createEventRes.json();

    vi.mocked(extractInvasionLoot).mockRejectedValueOnce(new Error('Anthropic API request failed (500): boom'));

    const imageBuffer = await sharp({ create: { width: 100, height: 40, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append('template', 'invasion');
    form.append('file', new Blob([imageBuffer], { type: 'image/png' }), 'reward.png');

    const res = await fetch(`${baseUrl}/api/events/${eventId}/screenshots`, {
      method: 'POST',
      headers: { 'x-telegram-init-data': adminInitData },
      body: form,
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('Anthropic API request failed');
  });
```

Leave every other existing test in the file untouched — in particular `'never merges lots across templates, even when their icons happen to look identical'` needs no code change: it uploads the same solid-purple image as both `feast` and `invasion`, and the default mock configured in `beforeEach` now supplies invasion's side automatically.

- [ ] **Step 2: Run the tests to verify the new/changed ones fail**

Run: `npx vitest run tests/server/routes/screenshots.test.ts`
Expected: FAIL — `screenshots.ts` still does local grid-slicing for invasion (ignoring the mock entirely), so the rewritten/new tests' assertions (mocked rarity/quantity, `-icon.png` naming from vision boxes, 400 without a key, 502 on failure) don't hold yet. Some may even error before asserting, since the route still calls `LAYOUT_TEMPLATES[template]`/`sliceImageToCells` unconditionally for invasion too.

- [ ] **Step 3: Rewrite `src/server/routes/screenshots.ts`**

Replace the whole file:

```typescript
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';
import { sliceImageToCells, cropBox } from '../grid-slice';
import { isTemplate, LAYOUT_TEMPLATES } from '../layout-templates';
import { detectColor, type RarityColor } from '../color-detect';
import { computeIconSignature, groupBySignature, isSameIcon, isGenericChestIcon, type IconSignature } from '../dedup';
import { findInLibrary } from '../lot-library';
import { isEventDraft } from './items';
import { extractInvasionLoot } from '../vision';

interface LotCandidate {
  screenshotId: number;
  imagePath: string;
  color: RarityColor;
  quantity: number;
}

export function registerScreenshotRoutes(app: FastifyInstance, deps: AppDeps) {
  app.post<{ Params: { id: string } }>(
    '/events/:id/screenshots',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const eventId = Number(request.params.id);
      if (!isEventDraft(deps, eventId)) {
        reply.code(409).send({ error: 'event is not in draft' });
        return;
      }

      // Read every part regardless of order. Multiple files can arrive in one request
      // (admin picks several screenshots at once); rows/template apply to all of them.
      let rows: number | undefined;
      let template: string | undefined;
      const fileBuffers: Buffer[] = [];

      for await (const part of request.parts()) {
        if (part.type === 'file') {
          fileBuffers.push(await part.toBuffer());
        } else if (part.fieldname === 'rows') {
          rows = Number(part.value);
        } else if (part.fieldname === 'template') {
          template = part.value as string;
        }
      }

      if (fileBuffers.length === 0) {
        reply.code(400).send({ error: 'at least one file is required' });
        return;
      }
      if (!isTemplate(template)) {
        reply.code(400).send({ error: 'template must be feast or invasion' });
        return;
      }
      // invasion's layout is read by a Claude vision call instead of a manual row count —
      // see vision.ts — so rows is only required (and only used) for feast.
      if (template === 'feast' && (!Number.isInteger(rows) || rows! < 1 || rows! > 50)) {
        reply.code(400).send({ error: 'rows must be a positive integer between 1 and 50' });
        return;
      }
      if (template === 'invasion' && !deps.anthropicApiKey) {
        reply.code(400).send({ error: 'ANTHROPIC_API_KEY is not configured for invasion screenshots' });
        return;
      }

      const uploadsDir = path.join(deps.dataDir, 'uploads');
      const originalsDir = path.join(uploadsDir, 'originals');
      const itemsDir = path.join(uploadsDir, 'items');
      await fs.mkdir(originalsDir, { recursive: true });
      // feast's sliceImageToCells creates itemsDir as a side effect, but invasion's path
      // below calls cropBox directly on it without going through that helper — needs its
      // own mkdir or the first cropBox write fails with ENOENT.
      await fs.mkdir(itemsDir, { recursive: true });

      const userId = request.telegramUser!.telegramId;
      const insertScreenshot = deps.db.prepare(
        'INSERT INTO screenshots (event_id, original_path, rows, template, uploaded_by) VALUES (?, ?, ?, ?, ?)'
      );
      const insertItem = deps.db.prepare(
        "INSERT INTO items (event_id, screenshot_id, image_path, color, category, name, quantity, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pool')"
      );

      // Only feast still uses the fixed pixel-grid layout; invasion's icons/quantities
      // come from extractInvasionLoot instead (see vision.ts) — variable row/icon count,
      // quantity read off each icon's own badge rather than inferred by counting rows.
      const feastLayout = template === 'feast' ? LAYOUT_TEMPLATES.feast! : undefined;
      const candidates: LotCandidate[] = [];

      for (let f = 0; f < fileBuffers.length; f++) {
        const uploadStamp = Date.now();
        const originalPath = path.join(originalsDir, `${eventId}-${uploadStamp}-${f}.png`);
        await fs.writeFile(originalPath, fileBuffers[f]);

        // rows is meaningless for invasion — 0 is a placeholder, never read back (the
        // column stays NOT NULL; not worth a migration for a value nothing uses).
        const screenshotId = insertScreenshot.run(eventId, originalPath, feastLayout ? rows : 0, template, userId)
          .lastInsertRowid as number;

        // The prefix folds in uploadStamp, not just screenshotId, on purpose: `id` is a
        // plain SQLite INTEGER PRIMARY KEY (no AUTOINCREMENT), which reuses low numbers
        // once the table is emptied out — exactly what happens in the admin's own
        // workflow of deleting the previous test event before every new one. Deleting an
        // event drops its DB rows but leaves the old icon files on disk (see the cleanup
        // ponytail note in DELETE /events/:id), so a reused id would reuse the exact same
        // file path — and a client that cached that URL from the earlier test (Telegram's
        // WebView does this) would keep showing the old picture after it's overwritten,
        // even though the server and DB both already have the right one. Bug found
        // 2026-08-28: fresh event, brand-new screenshots, but the admin grid showed items
        // from an unrelated, already-deleted test event.
        const baseName = `ss${screenshotId}-${uploadStamp}`;

        if (feastLayout) {
          const cellPaths = await sliceImageToCells(
            originalPath,
            rows!,
            1,
            itemsDir,
            baseName,
            feastLayout.contentTop,
            feastLayout.rowHeight
          );
          for (let i = 0; i < cellPaths.length; i++) {
            const cellPath = cellPaths[i];
            // The icon badge alone identifies the item, so it's what gets shown as the
            // lot's image (and compared below to spot duplicate rows); the full row strip
            // stays only as the source for color detection.
            const imagePath = feastLayout.iconBox
              ? await cropBox(cellPath, feastLayout.iconBox, path.join(itemsDir, `${baseName}-${i}-icon.png`))
              : cellPath;
            let color: RarityColor = 'blue';
            try {
              color = await detectColor(cellPath, 'feast');
            } catch (err) {
              request.log.warn({ err }, 'color detection failed, defaulting to blue');
            }
            candidates.push({ screenshotId, imagePath, color, quantity: 1 });
          }
        } else {
          let visionItems;
          try {
            visionItems = await extractInvasionLoot(fileBuffers[f], deps.anthropicApiKey!);
          } catch (err) {
            request.log.error({ err }, 'invasion vision extraction failed');
            reply.code(502).send({ error: `Не удалось распознать скриншот: ${(err as Error).message}` });
            return;
          }
          for (let i = 0; i < visionItems.length; i++) {
            const item = visionItems[i];
            const imagePath = await cropBox(originalPath, item, path.join(itemsDir, `${baseName}-${i}-icon.png`));
            candidates.push({ screenshotId, imagePath, color: item.rarity, quantity: item.quantity });
          }
        }
      }

      // The same item often appears more than once (a common drop, or split across two
      // boss rows) — grouping identical-looking icons into one lot with a quantity,
      // instead of one lot per icon, is the whole point of this endpoint; see dedup.ts
      // for how "identical-looking" is decided and its one known blind spot (two
      // different items that share the exact same icon art, like a chest whose graphic
      // doesn't change between tiers, still merge).
      const withSignatures = await Promise.all(
        candidates.map(async (c) => ({ signature: await computeIconSignature(c.imagePath), value: c }))
      );
      const signatureByPath = new Map(withSignatures.map((s) => [s.value.imagePath, s.signature]));
      const groups = groupBySignature<LotCandidate>(withSignatures as { signature: IconSignature; value: LotCandidate }[]);

      // Дубли бьют не только внутри одной загрузки, но и между отдельными
      // выгрузками скриншотов (тот же лот попал на два разных скрина) — поэтому
      // здесь ещё раз сверяем иконку с тем, что уже лежит в пуле этого ивента,
      // и вместо нового лота просто добавляем количество к найденному.
      //
      // Обязательно только среди лотов ТОГО ЖЕ шаблона: один ивент может
      // содержать вперемешку лоты и пира, и вторжения (админ загружает оба на
      // тест), а их иконки — из совершенно разных наборов рамок/фонов, так что
      // сравнивать 16×16-отпечаток одного шаблона с другим — рулетка (порог 8
      // рассчитан на JPEG-артефакты одного и того же скриншота, а не на
      // совпадение между разными играми). Без фильтра по шаблону новый лот
      // вторжения мог случайно "слиться" со старым лотом пира — новый лот не
      // создавался, количество бампалось чужому, и в списке видна была старая
      // картинка/цвет вместо только что загруженной (баг, найден 2026-08-28).
      const existingPoolItems = deps.db
        .prepare(
          `SELECT i.id, i.image_path as imagePath, i.quantity
           FROM items i JOIN screenshots s ON s.id = i.screenshot_id
           WHERE i.event_id = ? AND i.status = 'pool' AND s.template = ?`
        )
        .all(eventId, template) as { id: number; imagePath: string; quantity: number }[];
      const existingSignatures = await Promise.all(
        existingPoolItems.map(async (item) => ({
          item,
          signature: await computeIconSignature(path.join(uploadsDir, item.imagePath)),
        }))
      );
      const bumpQuantity = deps.db.prepare('UPDATE items SET quantity = quantity + ? WHERE id = ?');

      const itemIds: number[] = [];
      for (const group of groups) {
        const representative = group[0];
        const signature = signatureByPath.get(representative.imagePath)!;
        const quantity = group.reduce((sum, c) => sum + c.quantity, 0);

        // The generic chest icon is excluded from cross-upload matching (see
        // isGenericChestIcon) — it looks identical across genuinely different
        // chest lots, so treating repeats across separate uploads as "the same
        // chest" would silently swallow real lots. Within this one upload,
        // groupBySignature above still merged any true repeats normally.
        const existingMatch = isGenericChestIcon(signature)
          ? undefined
          : existingSignatures.find((es) => isSameIcon(es.signature, signature));
        if (existingMatch) {
          bumpQuantity.run(quantity, existingMatch.item.id);
          existingMatch.item.quantity += quantity;
          itemIds.push(existingMatch.item.id);
          continue;
        }

        const relPath = path.relative(uploadsDir, representative.imagePath).split(path.sep).join('/');

        // A generic chest icon can't be trusted to identify what's actually inside it
        // (see isGenericChestIcon above), so it's excluded from library lookup the same
        // way it's excluded from cross-upload dedup — otherwise every chest lot would
        // get stamped with whatever name/category the first one was ever tagged.
        const known = isGenericChestIcon(signature) ? undefined : findInLibrary(deps.db, signature);

        const itemId = insertItem
          .run(
            eventId,
            representative.screenshotId,
            relPath,
            representative.color,
            known?.category ?? 'item',
            known?.name ?? '',
            quantity
          )
          .lastInsertRowid as number;
        itemIds.push(itemId);
        existingSignatures.push({ item: { id: itemId, imagePath: relPath, quantity }, signature });
      }

      return { itemIds };
    }
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/server/routes/screenshots.test.ts`
Expected: PASS

- [ ] **Step 5: Type-check and run the full backend test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no type errors, all tests pass (first point Tasks 1-4 are exercised together).

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/screenshots.ts tests/server/routes/screenshots.test.ts
git commit -m "$(cat <<'EOF'
Route invasion screenshots through Claude vision instead of a grid

Feast keeps its local grid-slice + pixel color-sample path unchanged.
Invasion calls extractInvasionLoot once per screenshot and crops each
returned box directly. Both paths converge into a shared candidate
list before the existing dedup/grouping runs; quantity is now summed
per group instead of counted, which is a no-op for feast (quantity 1
per row) and correct for invasion (each icon reports its own count).
EOF
)"
```

---

### Task 5: Admin upload UI — hide rows for invasion

**Files:**
- Modify: `web/views/eventDetail.ts`

**Interfaces:**
- Consumes: nothing new — purely a client-side convenience matching Task 4's server-side change (rows no longer required for invasion).
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Give the rows input and template select stable ids**

Replace:

```typescript
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
```

with:

```typescript
      <form id="screenshot-form">
        <div class="field-row">
          <input id="rows-input" name="rows" type="number" min="1" max="50" placeholder="Строк на каждом скрине" required />
          <select id="template-select" name="template" required>
            <option value="feast">Пир победы</option>
            <option value="invasion">Аукцион вторжения</option>
          </select>
        </div>
        <input name="file" type="file" accept="image/*" multiple required />
        <button type="submit" class="btn-block">Загрузить</button>
      </form>
```

- [ ] **Step 2: Add one sentence to the upload help text**

In the same `<section>`'s help paragraph, the sentence ending "...так что кол-во и пометку для них стоит проверить особенно внимательно)." stays as-is (feast-specific). Right after it, before "Цену не показываем...", insert: `Для вторжения строки указывать не нужно — модель сама разберёт скриншот.` So that segment of the paragraph reads:

```
        ...проверить особенно внимательно). Для вторжения строки указывать не нужно —
        модель сама разберёт скриншот. Цену не показываем — участники и так видят её в
        игре. Редактировать лоты можно, пока не нажата «Начать аукцион» — после старта
        список блокируется.
```

- [ ] **Step 3: Wire the show/hide toggle**

Inside the existing `if (status === 'draft') { (root.querySelector('#screenshot-form') as HTMLFormElement).addEventListener('submit', ...) }` block, insert this right before that `addEventListener('submit', ...)` call (same `if (status === 'draft') { ... }` guard, so these elements are guaranteed to exist):

```typescript
    const templateSelect = root.querySelector('#template-select') as HTMLSelectElement;
    const rowsInput = root.querySelector('#rows-input') as HTMLInputElement;
    const syncRowsField = () => {
      const isInvasion = templateSelect.value === 'invasion';
      rowsInput.disabled = isInvasion;
      rowsInput.required = !isInvasion;
      rowsInput.style.display = isInvasion ? 'none' : '';
    };
    templateSelect.addEventListener('change', syncRowsField);
    syncRowsField();
```

(the existing submit handler's `const rows = (form.elements.namedItem('rows') as HTMLInputElement).value;` line needs no change — a disabled input still has a `.value`, and the server now ignores `rows` entirely for invasion, so sending a stale/empty value there is harmless).

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual smoke test**

With `npm run dev:server` / `npm run dev:web` running (and `ANTHROPIC_API_KEY` set in `.env` if you want to exercise the real call — otherwise just check the UI toggle, which doesn't need it), open the admin event-detail screen for a draft event, and switch the template `<select>` between "Пир победы" and "Аукцион вторжения": confirm the "Строк на каждом скрине" field hides and stops being required when invasion is selected, and reappears/re-requires when switched back to feast.

- [ ] **Step 6: Commit**

```bash
git add web/views/eventDetail.ts
git commit -m "$(cat <<'EOF'
Hide the rows field for invasion uploads in the admin UI

Server no longer reads or requires it for invasion (see the previous
commit) — the field now hides and stops being required the moment
invasion is selected, so the admin isn't blocked filling in a number
that no longer means anything.
EOF
)"
```

---

### Task 6: HANDOFF.md + full verification pass

**Files:**
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: nothing — documentation only.
- Produces: nothing — end of plan.

- [ ] **Step 1: Update `HANDOFF.md`**

Add a new dated section near the top (above "## Где что физически работает", following this file's newest-first convention) summarizing: invasion screenshots are now recognized via a Claude vision call (`src/server/vision.ts`, `extractInvasionLoot`) instead of a fixed pixel grid — variable row/icon count, quantity read from each icon's own badge; feast is unaffected. Note the new optional `ANTHROPIC_API_KEY` env var (paid, per screenshot, get one at console.anthropic.com — this is a separate Anthropic API account/balance from a claude.ai subscription, which does not cover API usage). Note `rows` is no longer required/read for invasion uploads. Link to [docs/superpowers/specs/2026-08-31-invasion-vision-recognition-design.md](docs/superpowers/specs/2026-08-31-invasion-vision-recognition-design.md).

- [ ] **Step 2: Run the full verification suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 3: Commit**

```bash
git add HANDOFF.md
git commit -m "$(cat <<'EOF'
Document invasion vision recognition in HANDOFF.md
EOF
)"
```

---

## Deploying

Once all tasks are committed and merged to `main`: `cd /opt/loot_auction && git pull origin main && npm run build:web && sudo systemctl restart loot-auction && sudo systemctl status loot-auction --no-pager` — plus, this time, make sure `ANTHROPIC_API_KEY` is set in the VPS's `.env` before restarting, or invasion uploads will 400 until it is.
