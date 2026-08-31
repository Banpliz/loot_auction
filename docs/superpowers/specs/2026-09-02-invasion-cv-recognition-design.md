# Invasion Loot Recognition via Code-Side CV — Design

## Purpose

Replace invasion's Claude-Vision-only recognition (`src/server/vision.ts`,
`extractInvasionLoot`, see
[2026-08-31-invasion-vision-recognition-design.md](2026-08-31-invasion-vision-recognition-design.md))
with a deterministic, code-driven pipeline for the parts a general vision model kept
getting wrong across ~21 live-tuning rounds (bounding-box geometry: margins, height/width
ratios, top-edge drift, neighbor bleed, phantom boxes over blank panel/tab-bar regions).
Geometry, icon-frame detection, and rarity become plain pixel analysis (`sharp`, no ML).
Only the one piece that genuinely requires reading arbitrary text — the icon's own `×N`
quantity badge — still goes through a Claude Vision call, but a much narrower one: a
single batched request per screenshot containing only the already-cropped badge images,
asking for nothing but the digit in each. The existing full-image Vision path
(`extractInvasionLoot`) is kept, untouched, as the fallback for screenshots the code
pipeline can't confidently parse at all.

Feast's recognition (fixed pixel grid, `color-detect.ts`) is untouched by this change.

## Context

- The 21 tuning rounds all lived in `vision.ts`'s `validateItem()` post-processing
  constants (`MARGIN_RATIO`, `TOP_MARGIN_RATIO`, `Y_DRIFT_MARGIN_RATIO`,
  `MAX_HEIGHT_TO_WIDTH_RATIO`, `MAX_WIDTH_TO_HEIGHT_RATIO`, `MIN_CONTENT_STDEV`) and the
  prompt's ignore-list. Every fix for one screenshot's failure mode risked reintroducing an
  earlier one (round 8 vs round 5, round 13 vs round 14, round 18 vs round 20) because the
  model's own geometry judgment is inherently non-deterministic — the same icon can get a
  differently-sized/positioned box from one run to the next. This is the core motivation:
  stop asking a general vision model to *locate* things it's unreliable at locating, and
  only ask it to do the one narrow thing left that code can't do (read a digit).
- `dedup.ts`'s `SAME_ITEM_THRESHOLD` was widened (8 → 16) specifically to tolerate
  invasion's inconsistent crop framing from the old pipeline. Once crops come from
  deterministic code instead (same icon → same crop, every time, like feast already gets),
  this widened threshold may no longer be necessary — revisit during implementation, but
  don't touch feast's crops which never had this problem.
- **`tesseract.js` was already tried for exactly this kind of task (reading a digit off a
  clean crop) and abandoned** — commit `e8b9f3d` (2026-08-27), quote: *"tesseract
  misreading digits even on a clean crop [...] the least reliable part of the pipeline"*.
  It's still an installed-but-unused dependency (`package.json`). This design does **not**
  revive it — quantity reading stays on Claude Vision, just on tiny pre-cropped badge
  images instead of the whole screenshot, which is cheaper and gives the model nothing to
  misjudge except the one digit.
- `color-detect.ts`'s `REFERENCE_COLORS` (blue/purple/red RGB triples) were calibrated
  against feast's icon frames. Invasion's frames look visually similar (same game, same
  rarity palette) but were never independently calibrated — treat these as a starting
  point, not a guarantee, and re-sample against real invasion screenshots during
  implementation if matches look wrong.

## Non-goals

- No change to feast's recognition path or `layout-templates.ts`'s `feast` entry.
- No removal of `ANTHROPIC_API_KEY` or `extractInvasionLoot` — both stay, as the fallback
  path and its config requirement.
- No `opencv4nodejs` or other native CV dependency — frame detection is plain color
  thresholding + connected-component grouping over `sharp`'s raw pixel output, the same
  category of technique `color-detect.ts` already uses for feast, just extended to find an
  unknown number of regions instead of sampling one fixed point.
- No revival of `tesseract.js` for quantity reading (see Context above).
- No per-icon Vision calls — quantity reading is one batched call per screenshot, all
  detected badge crops packed into a single request (cheaper, less latency, matches the
  existing single-call-per-screenshot cost shape the admin is already used to).
- No change to how rarity is stored/consumed downstream (`items.color`) — the CV pipeline
  produces the same `VisionLotItem`-shaped output (`x, y, w, h, rarity, quantity`) that
  `screenshots.ts` already knows how to crop and insert; `screenshots.ts`'s call site
  changes only in *which function* it calls first, not in what it does with the result.

## Architecture

### New module: `src/server/invasion-cv.ts`

```typescript
export interface DetectedFrame {
  x: number; y: number; w: number; h: number; // fractions of full image
  rarity: 'blue' | 'purple' | 'red';
}

// Returns null when the pipeline isn't confident it found the panel/rows/icons at all —
// the caller falls back to extractInvasionLoot (vision.ts) in that case. Never throws for
// "couldn't find things"; only for genuine I/O errors (unreadable image buffer).
export async function detectInvasionFrames(imageBuffer: Buffer): Promise<DetectedFrame[] | null>
```

Internally, in order:

1. **Panel bounds** — sample rows of the image for the dominant light cream/beige color
   (a known reference, sampled from real screenshots during implementation) and find the
   largest contiguous vertical span matching it. No panel found (color never dominates a
   large-enough region) → return `null`.
2. **Row bands** — within the panel, scan top-to-bottom for horizontal bands with non-panel
   content (text/icon pixels) separated by thin panel-colored gaps. This naturally handles
   any number of rows of any height — no fixed row count or row height, unlike feast's
   grid. Zero rows found → return `null`.
3. **Icon frames per row** — within each row's right-hand portion (icons are always
   right-aligned after the boss name text, confirmed across every real screenshot seen this
   session), scan for pixels close to one of the three rarity reference colors, group
   adjacent matching pixels into connected components (flood fill over the raw pixel
   buffer), and keep components above a minimum size (filters single-pixel color noise).
   Each component's bounding box is one `DetectedFrame`; its rarity is whichever reference
   color it matched. Zero frames found across every row → return `null` (something's
   structurally off — safer to hand the whole image to the fallback than guess).
4. Apply the same anchored margin expansion `vision.ts` already validated works well for
   feeding `cropBox()` — small, symmetric padding around each detected component, not the
   asymmetric/drift-compensating margins `vision.ts` needed (those existed specifically to
   correct a *model's* geometry error; code-detected boxes don't have that error to correct
   for, so they only need cosmetic breathing room).

### Quantity reading: extend `src/server/vision.ts`

```typescript
// One batched call: every detected frame's badge-corner crop goes in as its own small
// image. A frame whose badge the model can't read confidently defaults to 1 (matches the
// existing "no visible badge → 1" convention already in extractInvasionLoot's prompt) —
// this does NOT trigger the full-screenshot fallback; it's a single-item default, not a
// pipeline failure.
export async function readQuantities(
  badgeCrops: Buffer[],
  apiKey: string,
  baseUrl?: string
): Promise<number[]>
```

Reuses the request wiring `extractInvasionLoot` already has proven in production
(`thinking: disabled`, forced `tool_choice`, `ANTHROPIC_VERSION`, `baseUrl` override).

**Answer misalignment is a named risk, not an assumption away.** A batched multi-image
request asking for "N numbers in order" has an obvious failure mode: the model returns the
wrong count, duplicates one slot, or otherwise desyncs image N from output N — which would
silently write one icon's quantity onto a different icon. The tool schema therefore doesn't
trust position at all: each result item must carry an explicit `index` field (the model is
told image 1 is index 0, image 2 is index 1, etc., matching how `extractInvasionLoot`
already numbers things in its own prompt), and the code validates the full set before using
any of it — every index `0..badgeCrops.length-1` present exactly once, no duplicates, no
extras. Any mismatch fails the whole `readQuantities` call (see Fallback semantics below)
rather than guessing which number belongs where. Only messages the model failed to read
default to `1` — this is the per-image parseability check, not the alignment check.

Badge crops are small sub-regions of each detected frame — the bottom-right corner where
the `×N` number sits, sized relative to the frame (calibrated against real screenshots
during implementation, the same way `color-detect.ts`'s `colorSample` point is a
relative-position constant).

### Call site: `src/server/routes/screenshots.ts`

```typescript
const frames = await detectInvasionFrames(fileBuffers[f]);
let visionItems: VisionLotItem[];
if (frames) {
  // Every crop comes from the same full-resolution screenshot buffer — frames are
  // fractional coordinates into it, not separate images.
  const badgeCrops = await Promise.all(frames.map((frame) => cropBadge(fileBuffers[f], frame)));
  const quantities = await readQuantities(badgeCrops, deps.anthropicApiKey!, deps.anthropicBaseUrl);
  visionItems = frames.map((frame, i) => ({ ...frame, quantity: quantities[i] }));
} else {
  visionItems = await extractInvasionLoot(fileBuffers[f], deps.anthropicApiKey!, deps.anthropicBaseUrl);
}
```

Everything downstream (cropping the full icon via `cropBox()`, dedup, DB insert) is
unchanged — both paths produce the same `VisionLotItem[]` shape.

## Fallback semantics

| Condition | Behavior |
|---|---|
| Panel not found | Whole screenshot → `extractInvasionLoot` (existing Vision path) |
| Zero rows found | Same — whole screenshot → fallback |
| Zero icon frames found (all rows) | Same — whole screenshot → fallback |
| Some rows/frames found, but fewer than expected | **Not** treated as failure — a screenshot legitimately can have few rows. No fallback trigger exists for "seems low"; only "found literally nothing" triggers it. Getting this wrong (over-triggering fallback) would silently bring back the old instability for screenshots the new pipeline actually handles fine. |
| A frame's badge crop unreadable in the batch call | Default that item's quantity to 1, keep the rest of the batch — no fallback |
| Response's set of indices doesn't exactly match `0..badgeCrops.length-1` (missing, duplicate, or extra index — the "wrong slot" risk) | Whole `readQuantities` call treated as failed — throws, does **not** guess an alignment. This is a distinct check from the per-item "unreadable" default above: that default only applies once every index is confirmed present exactly once. |
| `readQuantities` API call itself fails (network, non-2xx, malformed response, or the index-alignment failure above) | Propagates as an error the same way `extractInvasionLoot`'s failures already do today (502 to the admin) — the CV pipeline still needs *a* working Vision call for quantities; this isn't a case for falling back to the full-image path, since that would just make the *same* API call fail differently |

## Testing strategy

- Synthetic fixture images built with `sharp` (colored rectangles/diamonds standing in for
  frames, solid panel-colored backgrounds, gaps) for deterministic unit tests of panel/row/
  frame detection — same technique `dedup.test.ts` already uses for its chest-signature
  test.
- `readQuantities`'s HTTP call tested the same way `vision.test.ts` already tests
  `extractInvasionLoot` — stubbed `fetch`, assert request shape and response parsing.
- No test depends on real OCR/Vision accuracy on real screenshots (that's inherently
  non-deterministic and not something a unit test should assert on) — the pipeline's
  *structure* is what's tested; whether a live screenshot parses well is validated the same
  way it has been all session, by the user testing against the real deployed service.

## Open risks

- Reference colors and the badge crop's relative position/size are **estimates from
  screenshots seen this session**, not yet calibrated against a larger sample. Expect at
  least one live-tuning round after initial deployment, same as any new recognition path —
  but the failure surface is much smaller now (frame detection is deterministic; only the
  digit-reading call has any model variance left, and it has nothing to misjudge but the
  number itself).
- A row or icon whose rarity color happens to closely resemble the panel's cream background
  or another rarity's color range could be mis-detected. This is the direct code-side
  analog of the old pipeline's content-selection misses, but should be far rarer since
  color thresholding on real rarity colors (saturated blue/purple/red) vs. a desaturated
  cream panel is a much easier discrimination than a language model classifying an entire
  scene's content.
