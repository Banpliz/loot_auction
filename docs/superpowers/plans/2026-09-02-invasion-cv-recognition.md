# Invasion CV Recognition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace invasion's Claude-Vision-only geometry detection with deterministic
code-side panel/frame detection (`sharp`, no ML), keeping a single narrow batched Vision
call only for reading each icon's quantity digit off an already-cropped badge — and keep
the existing full-image Vision path as a fallback for screenshots the code pipeline can't
confidently parse.

**Architecture:** New module `src/server/invasion-cv.ts` does panel-bounds detection
(color match) then connected-component frame detection (BFS flood fill over rarity-colored
pixels) — both plain pixel analysis, no model calls. `src/server/vision.ts` gains
`readQuantities()`, a batched Vision call over small pre-cropped badge images, with
response validation keyed on an explicit `index` field (not array position) so a
misaligned/incomplete response fails loudly instead of silently mismatching quantities to
icons. `src/server/routes/screenshots.ts`'s invasion branch tries the code pipeline first;
`null` (couldn't confidently find a panel or any frames) falls through to the existing,
untouched `extractInvasionLoot`.

**Tech Stack:** TypeScript, `sharp` (already a dependency), Fastify, vitest.

**Spec:** [2026-09-02-invasion-cv-recognition-design.md](../specs/2026-09-02-invasion-cv-recognition-design.md)

## Global Constraints

- No `opencv4nodejs` or other native CV dependency — `sharp` (raw pixel buffers) only.
- No revival of `tesseract.js` for quantity reading — already tried and abandoned for
  exactly this (commit `e8b9f3d`: "tesseract misreading digits even on a clean crop").
- `extractInvasionLoot` (`src/server/vision.ts`) must remain fully functional, unchanged,
  as the fallback path — no behavior change to it in this plan.
- `ANTHROPIC_API_KEY` / `anthropicBaseUrl` config plumbing already exists in `AppDeps` —
  reuse it, don't add new env vars or config surface.
- Reuse `color-detect.ts`'s rarity RGB reference values (export the existing const) rather
  than hand-copying the numbers into a second file.
- `dedup.ts`'s `SAME_ITEM_THRESHOLD` (widened 8→16 to tolerate the old pipeline's
  inconsistent crop framing) is explicitly **out of scope** for this plan — code-detected
  crops are far more consistent than the old vision-detected ones, so the threshold could
  likely come back down, but that's a separate, later change once this pipeline is proven
  live, not bundled into this one.
- After every task: `npx vitest run` and `npx tsc --noEmit` must both be clean before
  committing.

---

### Task 1: Panel + icon-frame detection (`invasion-cv.ts`)

**Files:**
- Modify: `src/server/color-detect.ts:6` (export the existing rarity reference colors)
- Create: `src/server/invasion-cv.ts`
- Test: `tests/server/invasion-cv.test.ts`

**Interfaces:**
- Produces: `export interface DetectedFrame { x: number; y: number; w: number; h: number; rarity: RarityColor }` (fractions of full image, same shape convention `vision.ts`'s `VisionLotItem` already uses minus `quantity`)
- Produces: `export async function detectInvasionFrames(imageBuffer: Buffer): Promise<DetectedFrame[] | null>`
- Consumes: `RarityColor` type and rarity reference colors from `color-detect.ts`

- [ ] **Step 1: Export the rarity reference colors from `color-detect.ts`**

In `src/server/color-detect.ts`, change:

```typescript
const REFERENCE_COLORS: Record<RarityColor, [number, number, number]> = {
```

to:

```typescript
export const REFERENCE_COLORS: Record<RarityColor, [number, number, number]> = {
```

No other change to this file. Run `npx vitest run tests/server/color-detect.test.ts` — must still pass unchanged (this is a pure export addition, no behavior change).

- [ ] **Step 2: Write the failing tests for `detectInvasionFrames`**

Create `tests/server/invasion-cv.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { detectInvasionFrames } from '../../src/server/invasion-cv';

// Matches invasion-cv.ts's PANEL_REFERENCE_COLOR and RARITY reference colors exactly —
// these tests build synthetic images the detector should recognize, not real screenshots.
const PANEL_COLOR = { r: 237, g: 224, b: 196 };
const BLUE = { r: 74, g: 144, b: 217 };
const PURPLE = { r: 156, g: 74, b: 201 };
const RED = { r: 209, g: 67, b: 78 };
const DARK_BG = { r: 10, g: 10, b: 15 };

async function buildImage(
  width: number,
  height: number,
  panel: { top: number; bottom: number } | null,
  rects: { left: number; top: number; width: number; height: number; color: { r: number; g: number; b: number } }[]
): Promise<Buffer> {
  const layers: sharp.OverlayOptions[] = [];
  if (panel) {
    layers.push({
      input: await sharp({
        create: { width, height: panel.bottom - panel.top, channels: 3, background: PANEL_COLOR },
      })
        .png()
        .toBuffer(),
      left: 0,
      top: panel.top,
    });
  }
  for (const rect of rects) {
    layers.push({
      input: await sharp({ create: { width: rect.width, height: rect.height, channels: 3, background: rect.color } })
        .png()
        .toBuffer(),
      left: rect.left,
      top: rect.top,
    });
  }
  return sharp({ create: { width, height, channels: 3, background: DARK_BG } })
    .composite(layers)
    .png()
    .toBuffer();
}

describe('detectInvasionFrames', () => {
  it('detects a single icon frame inside the panel', async () => {
    const image = await buildImage(100, 200, { top: 20, bottom: 180 }, [
      { left: 60, top: 100, width: 30, height: 40, color: BLUE },
    ]);
    const frames = await detectInvasionFrames(image);
    expect(frames).not.toBeNull();
    expect(frames).toHaveLength(1);
    expect(frames![0].rarity).toBe('blue');
    expect(frames![0].x).toBeCloseTo(0.6, 1);
    expect(frames![0].y).toBeCloseTo(0.5, 1);
    expect(frames![0].w).toBeCloseTo(0.3, 1);
    expect(frames![0].h).toBeCloseTo(0.2, 1);
  });

  it('detects multiple frames of different rarities, left to right', async () => {
    const image = await buildImage(150, 200, { top: 20, bottom: 180 }, [
      { left: 10, top: 50, width: 20, height: 20, color: BLUE },
      { left: 60, top: 50, width: 20, height: 20, color: PURPLE },
      { left: 110, top: 50, width: 20, height: 20, color: RED },
    ]);
    const frames = await detectInvasionFrames(image);
    expect(frames).not.toBeNull();
    expect(frames!.map((f) => f.rarity)).toEqual(['blue', 'purple', 'red']);
  });

  it('returns null when no panel-colored region is found', async () => {
    const image = await buildImage(100, 200, null, [{ left: 60, top: 100, width: 30, height: 40, color: BLUE }]);
    expect(await detectInvasionFrames(image)).toBeNull();
  });

  it('returns null when the panel exists but contains no rarity-colored frames', async () => {
    const image = await buildImage(100, 200, { top: 20, bottom: 180 }, []);
    expect(await detectInvasionFrames(image)).toBeNull();
  });

  it('ignores a rarity-colored blob too small to be a real icon', async () => {
    const image = await buildImage(100, 200, { top: 20, bottom: 180 }, [
      { left: 60, top: 100, width: 2, height: 2, color: BLUE }, // 4px, well under the noise floor
    ]);
    expect(await detectInvasionFrames(image)).toBeNull();
  });
});
```

- [ ] **Step 2b: Run the tests to confirm they fail**

Run: `npx vitest run tests/server/invasion-cv.test.ts`
Expected: FAIL — `src/server/invasion-cv.ts` doesn't exist yet (import error).

- [ ] **Step 3: Implement `invasion-cv.ts`**

Create `src/server/invasion-cv.ts`:

```typescript
import sharp from 'sharp';
import { REFERENCE_COLORS, type RarityColor } from './color-detect';

export interface DetectedFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  rarity: RarityColor;
}

// Estimated from screenshots seen 2026-09-01/02 — the "Трофеи" panel's light cream/beige
// background. Not independently calibrated against a large sample; retune here if live
// testing shows the panel isn't being found (see Open Risks in the design doc).
const PANEL_REFERENCE_COLOR: [number, number, number] = [237, 224, 196];
const PANEL_COLOR_TOLERANCE = 28;

// Invasion's frames look visually identical to feast's (same game, same rarity palette),
// but were never independently sampled — reusing feast's calibrated values as a starting
// point, not a guarantee (see design doc's Open Risks).
const RARITY_COLOR_TOLERANCE = 40;

// A real panel spans most of the screenshot's height in every real example seen this
// session — a smaller match is more likely a false positive (a chat bubble, an unrelated
// icon) than an actual panel.
const MIN_PANEL_HEIGHT_RATIO = 0.25;

// Filters single-pixel/anti-aliasing color noise out of the connected-component pass — a
// real icon frame is a meaningful fraction of the image, never a handful of pixels.
const MIN_FRAME_AREA_RATIO = 0.0008;

type RawPixels = { data: Buffer; width: number; height: number; channels: number };

function colorDistance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

async function readRawRgb(imageBuffer: Buffer): Promise<RawPixels> {
  const { data, info } = await sharp(imageBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

// Finds the largest contiguous vertical span of rows that are mostly the panel's cream
// color. Returns pixel bounds, or null if nothing large enough matches.
function findPanelBounds(pixels: RawPixels): { top: number; bottom: number } | null {
  const { data, width, height, channels } = pixels;
  const rowIsPanel: boolean[] = new Array(height);
  for (let y = 0; y < height; y++) {
    let matchCount = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      if (colorDistance([data[i], data[i + 1], data[i + 2]], PANEL_REFERENCE_COLOR) <= PANEL_COLOR_TOLERANCE) {
        matchCount++;
      }
    }
    rowIsPanel[y] = matchCount / width > 0.5;
  }

  let bestStart = -1;
  let bestLength = 0;
  let currentStart = -1;
  for (let y = 0; y < height; y++) {
    if (rowIsPanel[y]) {
      if (currentStart === -1) currentStart = y;
    } else if (currentStart !== -1) {
      const length = y - currentStart;
      if (length > bestLength) {
        bestLength = length;
        bestStart = currentStart;
      }
      currentStart = -1;
    }
  }
  if (currentStart !== -1 && height - currentStart > bestLength) {
    bestLength = height - currentStart;
    bestStart = currentStart;
  }

  if (bestStart === -1 || bestLength / height < MIN_PANEL_HEIGHT_RATIO) return null;
  return { top: bestStart, bottom: bestStart + bestLength };
}

// Connected-component search (BFS flood fill) for pixels matching any rarity color, scoped
// to the panel's vertical span. Each component becomes one DetectedFrame; its rarity is
// whichever reference color the majority of its pixels matched (a component isn't split
// per exact color match — anti-aliased edge pixels can drift toward a neighboring
// reference color, so connectivity treats "any rarity color" as one foreground class and
// resolves the actual rarity afterward by majority vote).
function findFrames(pixels: RawPixels, panelTop: number, panelBottom: number): DetectedFrame[] {
  const { data, width, height, channels } = pixels;
  const rarityLabels: (RarityColor | null)[] = new Array(width * height).fill(null);
  const colorEntries = Object.entries(REFERENCE_COLORS) as [RarityColor, [number, number, number]][];

  for (let y = panelTop; y < panelBottom; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const pixel: [number, number, number] = [data[i], data[i + 1], data[i + 2]];
      let bestColor: RarityColor | null = null;
      let bestDist = RARITY_COLOR_TOLERANCE;
      for (const [color, ref] of colorEntries) {
        const dist = colorDistance(pixel, ref);
        if (dist <= bestDist) {
          bestDist = dist;
          bestColor = color;
        }
      }
      rarityLabels[y * width + x] = bestColor;
    }
  }

  const visited = new Uint8Array(width * height);
  const frames: DetectedFrame[] = [];
  const minArea = width * height * MIN_FRAME_AREA_RATIO;

  for (let y = panelTop; y < panelBottom; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (visited[idx] || !rarityLabels[idx]) continue;

      const stack = [idx];
      visited[idx] = 1;
      let pixelCount = 0;
      const colorCounts: Record<RarityColor, number> = { blue: 0, purple: 0, red: 0 };
      let minX = x, maxX = x, minY = y, maxY = y;

      while (stack.length > 0) {
        const current = stack.pop()!;
        pixelCount++;
        const cx = current % width;
        const cy = Math.floor(current / width);
        colorCounts[rarityLabels[current]!]++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const neighbors: [number, number][] = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= width || ny < panelTop || ny >= panelBottom) continue;
          const nIdx = ny * width + nx;
          if (visited[nIdx] || !rarityLabels[nIdx]) continue;
          visited[nIdx] = 1;
          stack.push(nIdx);
        }
      }

      if (pixelCount < minArea) continue;

      let rarity: RarityColor = 'blue';
      let bestCount = -1;
      for (const [color, count] of Object.entries(colorCounts) as [RarityColor, number][]) {
        if (count > bestCount) {
          bestCount = count;
          rarity = color;
        }
      }

      frames.push({
        x: minX / width,
        y: minY / height,
        w: (maxX - minX + 1) / width,
        h: (maxY - minY + 1) / height,
        rarity,
      });
    }
  }

  return frames;
}

// Returns null when the pipeline isn't confident it found the panel or any icon frames —
// the caller (screenshots.ts) falls back to extractInvasionLoot (vision.ts) in that case.
export async function detectInvasionFrames(imageBuffer: Buffer): Promise<DetectedFrame[] | null> {
  const pixels = await readRawRgb(imageBuffer);
  const panel = findPanelBounds(pixels);
  if (!panel) return null;

  const frames = findFrames(pixels, panel.top, panel.bottom);
  if (frames.length === 0) return null;

  return frames;
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run tests/server/invasion-cv.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit` — must be clean.

```bash
git add src/server/color-detect.ts src/server/invasion-cv.ts tests/server/invasion-cv.test.ts
git commit -m "Add code-side panel + icon-frame detection for invasion screenshots"
```

---

### Task 2: Badge cropping (`cropBadge`)

**Files:**
- Modify: `src/server/invasion-cv.ts`
- Test: `tests/server/invasion-cv.test.ts`

**Interfaces:**
- Consumes: `DetectedFrame` from Task 1
- Produces: `export async function cropBadge(imageBuffer: Buffer, frame: DetectedFrame): Promise<Buffer>` — crops the frame's bottom-right corner (where the `×N` quantity badge sits), returns a PNG buffer

- [ ] **Step 1: Write the failing test**

Add to `tests/server/invasion-cv.test.ts` (new top-level `describe`, same file):

```typescript
import { cropBadge } from '../../src/server/invasion-cv';

describe('cropBadge', () => {
  it('crops the bottom-right corner of the frame, sized relative to the frame', async () => {
    const image = await buildImage(100, 200, { top: 20, bottom: 180 }, [
      { left: 60, top: 100, width: 30, height: 40, color: BLUE },
    ]);
    const frame = { x: 0.6, y: 0.5, w: 0.3, h: 0.2, rarity: 'blue' as const };
    const crop = await cropBadge(image, frame);
    const metadata = await sharp(crop).metadata();
    // BADGE_WIDTH_RATIO=0.4, BADGE_HEIGHT_RATIO=0.3 against a 30x40px frame ->
    // round(30*0.4)=12, round(40*0.3)=12.
    expect(metadata.width).toBe(12);
    expect(metadata.height).toBe(12);
  });

  it('never crops past the image edge for a frame flush against a corner', async () => {
    const image = await buildImage(100, 200, { top: 20, bottom: 180 }, [
      { left: 90, top: 160, width: 10, height: 20, color: RED },
    ]);
    const frame = { x: 0.9, y: 0.8, w: 0.1, h: 0.1, rarity: 'red' as const };
    const crop = await cropBadge(image, frame);
    const metadata = await sharp(crop).metadata();
    expect(metadata.width).toBeGreaterThan(0);
    expect(metadata.height).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run tests/server/invasion-cv.test.ts`
Expected: FAIL — `cropBadge` is not exported yet.

- [ ] **Step 3: Implement `cropBadge`**

Add to `src/server/invasion-cv.ts` (after `detectInvasionFrames`):

```typescript
// The quantity badge sits in the icon frame's bottom-right corner in every real screenshot
// seen this session — these ratios are a first estimate, not measured against a large
// sample; retune if live testing shows the crop misses the number (see design doc's Open
// Risks).
const BADGE_WIDTH_RATIO = 0.4;
const BADGE_HEIGHT_RATIO = 0.3;

export async function cropBadge(imageBuffer: Buffer, frame: DetectedFrame): Promise<Buffer> {
  const { width, height } = await sharp(imageBuffer).metadata();
  if (!width || !height) {
    throw new Error('cropBadge: could not read image dimensions');
  }

  const badgeLeftFraction = frame.x + frame.w * (1 - BADGE_WIDTH_RATIO);
  const badgeTopFraction = frame.y + frame.h * (1 - BADGE_HEIGHT_RATIO);
  const left = Math.max(0, Math.min(width - 1, Math.round(badgeLeftFraction * width)));
  const top = Math.max(0, Math.min(height - 1, Math.round(badgeTopFraction * height)));
  const cropWidth = Math.max(1, Math.min(width - left, Math.round(frame.w * BADGE_WIDTH_RATIO * width)));
  const cropHeight = Math.max(1, Math.min(height - top, Math.round(frame.h * BADGE_HEIGHT_RATIO * height)));

  return sharp(imageBuffer).extract({ left, top, width: cropWidth, height: cropHeight }).png().toBuffer();
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run tests/server/invasion-cv.test.ts`
Expected: PASS, all 7 tests (5 from Task 1 + 2 new).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit` — must be clean.

```bash
git add src/server/invasion-cv.ts tests/server/invasion-cv.test.ts
git commit -m "Add badge cropping for the code-side invasion detection pipeline"
```

---

### Task 3: Batched quantity reading (`readQuantities`)

**Files:**
- Modify: `src/server/vision.ts`
- Test: `tests/server/vision.test.ts`

**Interfaces:**
- Produces: `export async function readQuantities(badgeCrops: Buffer[], apiKey: string, baseUrl?: string): Promise<number[]>` — returns one quantity per input crop, **in input order**, regardless of what order the model's response lists them in (matched by an explicit `index` field, not array position)
- Consumes: `MODEL`, `ANTHROPIC_VERSION`, `DEFAULT_BASE_URL` constants already in `vision.ts`

**Global Constraint reminder:** a batched multi-image request has an obvious failure mode
— the model returns the wrong count or desyncs image N from output N. This function must
never guess an alignment; see Step 3's validation.

- [ ] **Step 1: Write the failing tests**

Add to `tests/server/vision.test.ts`, as a new top-level `describe` block (after the
existing `extractInvasionLoot` describe closes):

```typescript
import { readQuantities } from '../../src/server/vision';

describe('readQuantities', () => {
  const crops = [Buffer.from('crop-0'), Buffer.from('crop-1'), Buffer.from('crop-2')];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetchOnce(response: { ok: boolean; status?: number; json?: () => Promise<unknown>; text?: () => Promise<string> }) {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('returns [] without calling fetch when there are no crops', async () => {
    const fetchMock = mockFetchOnce({ ok: true, json: async () => ({}) });
    const result = await readQuantities([], 'test-key');
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws without calling fetch when apiKey is empty', async () => {
    const fetchMock = mockFetchOnce({ ok: true, json: async () => ({}) });
    await expect(readQuantities(crops, '')).rejects.toThrow('ANTHROPIC_API_KEY is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('matches results to input crops by index, not by response order', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      json: async () => ({
        content: [{
          type: 'tool_use',
          input: { items: [{ index: 2, quantity: 7 }, { index: 0, quantity: 3 }, { index: 1, quantity: 5 }] },
        }],
      }),
    });
    const result = await readQuantities(crops, 'test-key');
    expect(result).toEqual([3, 5, 7]); // input order, not response order

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(options.body);
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'read_quantities' });
    expect(body.thinking).toEqual({ type: 'disabled' });
    const imageBlocks = body.messages[0].content.filter((b: any) => b.type === 'image');
    expect(imageBlocks).toHaveLength(3);
    expect(imageBlocks[0].source.data).toBe(crops[0].toString('base64'));
  });

  it('throws when the response is missing an index', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', input: { items: [{ index: 0, quantity: 3 }, { index: 1, quantity: 5 }] } }],
      }),
    });
    await expect(readQuantities(crops, 'test-key')).rejects.toThrow(/index 2/);
  });

  it('throws when the response has an extra out-of-range index alongside every valid one', async () => {
    // All 3 valid indices (0, 1, 2) are present — nothing is "missing" — but a 4th, bogus
    // entry (index 5) makes the response untrustworthy anyway: something desynced.
    mockFetchOnce({
      ok: true,
      json: async () => ({
        content: [{
          type: 'tool_use',
          input: {
            items: [
              { index: 0, quantity: 3 },
              { index: 1, quantity: 5 },
              { index: 2, quantity: 1 },
              { index: 5, quantity: 9 },
            ],
          },
        }],
      }),
    });
    await expect(readQuantities(crops, 'test-key')).rejects.toThrow(/distinct indices/);
  });

  it('calls a custom baseUrl when one is passed', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', input: { items: [{ index: 0, quantity: 1 }] } }],
      }),
    });
    await readQuantities([crops[0]], 'test-key', 'https://router.example');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://router.example/v1/messages');
  });

  it('throws with the status code when the API responds non-2xx', async () => {
    mockFetchOnce({ ok: false, status: 500, text: async () => 'server error' });
    await expect(readQuantities(crops, 'test-key')).rejects.toThrow(/500/);
  });

  it('throws when the response has no tool_use block', async () => {
    mockFetchOnce({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'oops' }] }) });
    await expect(readQuantities(crops, 'test-key')).rejects.toThrow('tool_use');
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run tests/server/vision.test.ts`
Expected: FAIL — `readQuantities` is not exported yet.

- [ ] **Step 3: Implement `readQuantities`**

Add to `src/server/vision.ts` (after `extractInvasionLoot` and before `validateItem`):

```typescript
const QUANTITY_PROMPT = `Каждое изображение выше — маленький кроп бейджика с числом
(количество предмета) в мобильной игре, пронумерованный по порядку начиная с 0
("Изображение 0", "Изображение 1", ...). Для КАЖДОГО изображения верни ровно одну запись:
index (номер изображения, как подписано выше) и quantity — число, которое там написано.
Если число нечитаемо или бейджика не видно на конкретном изображении — верни quantity: 1
для этого index, но всё равно включи запись. Не пропускай ни один index и не добавляй
лишних.`;

// One batched call: every badge crop goes in as its own small image, numbered in the
// prompt text so the model can report an explicit index per result. The response is
// matched to input crops BY THAT INDEX, never by array position — a batched multi-image
// request desyncing image N from output N is a real failure mode (see Global Constraints
// in the plan this shipped from), so any response whose indices don't exactly cover
// 0..badgeCrops.length-1 is treated as a failed call, not silently reordered or truncated.
export async function readQuantities(
  badgeCrops: Buffer[],
  apiKey: string,
  baseUrl: string = DEFAULT_BASE_URL
): Promise<number[]> {
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }
  if (badgeCrops.length === 0) {
    return [];
  }

  const content: Record<string, unknown>[] = [];
  badgeCrops.forEach((crop, i) => {
    content.push({ type: 'text', text: `Изображение ${i}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: crop.toString('base64') } });
  });
  content.push({ type: 'text', text: QUANTITY_PROMPT });

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      thinking: { type: 'disabled' },
      tools: [
        {
          name: 'read_quantities',
          description: 'Records the quantity number read off each small badge image.',
          input_schema: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    index: { type: 'integer', minimum: 0 },
                    quantity: { type: 'integer', minimum: 1 },
                  },
                  required: ['index', 'quantity'],
                },
              },
            },
            required: ['items'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'read_quantities' },
      messages: [{ role: 'user', content }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content?: { type: string; input?: unknown }[]; stop_reason?: string };
  if (data.stop_reason === 'max_tokens') {
    throw new Error('Anthropic API response was truncated (max_tokens)');
  }
  const toolUse = data.content?.find((block) => block.type === 'tool_use') as
    | { type: 'tool_use'; input?: { items?: unknown[] } }
    | undefined;
  if (!toolUse || !Array.isArray(toolUse.input?.items)) {
    throw new Error('Anthropic API response did not include the expected tool_use block');
  }

  const byIndex = new Map<number, number>();
  for (const raw of toolUse.input.items) {
    const item = raw as { index?: unknown; quantity?: unknown };
    if (
      typeof item.index === 'number' &&
      Number.isInteger(item.index) &&
      typeof item.quantity === 'number' &&
      Number.isInteger(item.quantity) &&
      item.quantity >= 1
    ) {
      byIndex.set(item.index, item.quantity);
    }
  }

  // Missing-index check runs BEFORE the size check: it gives a precise "index N missing"
  // message for the common case (the model just dropped one). The size check afterward
  // catches what the missing-index loop can't — every 0..N-1 present, but padded with an
  // extra/out-of-range index too, which is just as untrustworthy as a missing one, so it
  // isn't given a free pass by inspecting the count.
  const quantities: number[] = [];
  for (let i = 0; i < badgeCrops.length; i++) {
    const quantity = byIndex.get(i);
    if (quantity === undefined) {
      throw new Error(`readQuantities: response missing index ${i}`);
    }
    quantities.push(quantity);
  }

  if (byIndex.size !== badgeCrops.length) {
    throw new Error(
      `readQuantities: response had ${byIndex.size} distinct valid indices, expected exactly ${badgeCrops.length}`
    );
  }

  return quantities;
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run tests/server/vision.test.ts`
Expected: PASS, all tests (existing `extractInvasionLoot` tests + new `readQuantities` tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit` — must be clean.

```bash
git add src/server/vision.ts tests/server/vision.test.ts
git commit -m "Add batched, index-validated quantity reading to vision.ts"
```

---

### Task 4: Wire the CV pipeline into the upload route

**Files:**
- Modify: `src/server/routes/screenshots.ts`
- Modify: `tests/server/routes/screenshots.test.ts`

**Interfaces:**
- Consumes: `detectInvasionFrames`, `cropBadge` (Tasks 1-2), `readQuantities` (Task 3),
  `extractInvasionLoot` (existing, unchanged)
- No new exports — this task only changes `screenshots.ts`'s internal invasion branch

- [ ] **Step 1: Write the failing test for the CV-success path**

In `tests/server/routes/screenshots.test.ts`, update the `vi.mock` factory at the top to
also stub `readQuantities` (needed because the mock replaces the whole `vision` module):

```typescript
vi.mock('../../../src/server/vision', () => ({
  extractInvasionLoot: vi.fn(),
  readQuantities: vi.fn(),
}));
```

And update the import line just above it:

```typescript
import { extractInvasionLoot, readQuantities } from '../../../src/server/vision';
```

Add a new test (near the other invasion tests, e.g. after "invasion sums quantities..."):

```typescript
it('uses the code-side CV pipeline when it confidently detects a panel and frames, skipping the Vision fallback', async () => {
  const createEventRes = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
    body: JSON.stringify({ title: 'Ивент CV' }),
  });
  const { id: eventId } = await createEventRes.json();

  // Dark background, a large cream panel spanning most of the height, one blue rectangle
  // inside it — exactly what detectInvasionFrames (Task 1) is built to recognize for real,
  // no mocking of the detection itself.
  const panel = await sharp({ create: { width: 300, height: 240, channels: 3, background: { r: 237, g: 224, b: 196 } } })
    .png()
    .toBuffer();
  const frame = await sharp({ create: { width: 60, height: 60, channels: 3, background: { r: 74, g: 144, b: 217 } } })
    .png()
    .toBuffer();
  const imageBuffer = await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 10, g: 10, b: 15 } } })
    .composite([
      { input: panel, left: 0, top: 30 },
      { input: frame, left: 150, top: 100 },
    ])
    .png()
    .toBuffer();

  vi.mocked(readQuantities).mockResolvedValueOnce([4]);

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
  expect(body.itemIds).toHaveLength(1);

  const row = db.prepare('SELECT color, quantity FROM items WHERE id = ?').get(body.itemIds[0]) as any;
  expect(row.color).toBe('blue');
  expect(row.quantity).toBe(4);
  expect(extractInvasionLoot).not.toHaveBeenCalled();
  expect(readQuantities).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run to confirm the new test fails, existing ones still pass**

Run: `npx vitest run tests/server/routes/screenshots.test.ts`
Expected: the new test FAILs (screenshots.ts doesn't call `detectInvasionFrames` yet, so
`extractInvasionLoot`'s default mock resolves and gets used instead — `extractInvasionLoot`
IS called, failing the `not.toHaveBeenCalled()` assertion). All pre-existing tests in this
file still PASS unchanged (their fixtures are solid-color images with no cream panel, so
once Step 3 lands they'll still fall through to the `extractInvasionLoot` path exactly as
before).

- [ ] **Step 3: Wire `screenshots.ts`'s invasion branch**

In `src/server/routes/screenshots.ts`, update the import line:

```typescript
import { extractInvasionLoot } from '../vision';
```

to:

```typescript
import { extractInvasionLoot, readQuantities, type VisionLotItem } from '../vision';
import { detectInvasionFrames, cropBadge } from '../invasion-cv';
```

Then replace the invasion branch (the `else` block that currently calls
`extractInvasionLoot` directly):

```typescript
} else {
  let visionItems;
  try {
    visionItems = await extractInvasionLoot(fileBuffers[f], deps.anthropicApiKey!, deps.anthropicBaseUrl);
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
```

with:

```typescript
} else {
  let visionItems: VisionLotItem[];
  try {
    // Code-side detection first (deterministic panel/frame geometry, no model call) —
    // only the digit-reading call below touches Vision. null means the pipeline isn't
    // confident it found a panel or any frames at all, so the whole screenshot falls
    // back to the original full-image Vision path unchanged.
    const frames = await detectInvasionFrames(fileBuffers[f]);
    if (frames) {
      const badgeCrops = await Promise.all(frames.map((frame) => cropBadge(fileBuffers[f], frame)));
      const quantities = await readQuantities(badgeCrops, deps.anthropicApiKey!, deps.anthropicBaseUrl);
      visionItems = frames.map((frame, i) => ({ ...frame, quantity: quantities[i] }));
    } else {
      visionItems = await extractInvasionLoot(fileBuffers[f], deps.anthropicApiKey!, deps.anthropicBaseUrl);
    }
  } catch (err) {
    request.log.error({ err }, 'invasion recognition failed');
    reply.code(502).send({ error: `Не удалось распознать скриншот: ${(err as Error).message}` });
    return;
  }
  for (let i = 0; i < visionItems.length; i++) {
    const item = visionItems[i];
    const imagePath = await cropBox(originalPath, item, path.join(itemsDir, `${baseName}-${i}-icon.png`));
    candidates.push({ screenshotId, imagePath, color: item.rarity, quantity: item.quantity });
  }
}
```

- [ ] **Step 4: Run the full test suite to confirm everything passes**

Run: `npx vitest run`
Expected: PASS, full suite (the new CV-success test, plus every pre-existing test in
`screenshots.test.ts` and elsewhere, unchanged).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit` — must be clean.

```bash
git add src/server/routes/screenshots.ts tests/server/routes/screenshots.test.ts
git commit -m "Wire code-side CV detection into the invasion upload route, Vision as fallback"
```

---

## Post-implementation

- Push to `main` (`git push origin main`) and deploy to the VPS the same way every round
  this session has (`git pull origin main && git log -1 --oneline && sudo systemctl
  restart loot-auction`) — confirm the deployed commit hash before testing, since a stale
  restart has caused false "still broken" reports earlier this session.
- This is a genuinely new pipeline, not a tuning round — expect the panel/rarity reference
  colors and badge-crop ratios to need at least one live-calibration pass against real
  screenshots, same as the Vision pipeline did. The difference is the failure surface is
  now much smaller (deterministic detection vs. a model's geometry judgment), and the
  `null` fallback means a miscalibration degrades to "acts like before," not "produces
  wrong data."
