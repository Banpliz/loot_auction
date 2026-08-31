# Invasion Loot Recognition via Claude Vision — Design

## Purpose

Replace invasion's fixed pixel-grid screenshot recognition (`LAYOUT_TEMPLATES.invasion`
in `layout-templates.ts`) with a Claude vision call. The admin now screenshots the
in-game **"Трофеи" (Trophies)** recap screen instead of the old "Аукцион вторжения"
list — a variable number of boss-kill rows, each with a variable number of reward
icons, each icon already showing its own `×N` quantity badge. The old grid math
assumed a fixed row height and a fixed icon position per row; neither holds for this
screen, and the quantity badge printed on each icon means the count no longer needs to
be inferred by counting duplicate rows across uploads — it can be read directly.

Feast's recognition (`LAYOUT_TEMPLATES.feast`, still a fixed grid over a fixed
screenshot layout) is untouched by this change.

## Context

- Supersedes invasion's half of
  [2026-08-24-loot-auction-design.md](2026-08-24-loot-auction-design.md) and the
  invasion entry in `layout-templates.ts` (measured 2026-08-26 against the old
  "Аукцион вторжения" screen, per its own comment).
- `tesseract.js` is already an installed-but-unused dependency (HANDOFF.md: "OCR и
  цена полностью выпилены" — an earlier local-OCR attempt was abandoned as
  unreliable). This is a different approach: a general-purpose vision model doing
  structured extraction over the whole screenshot at once, not per-character OCR on a
  cropped digit strip.

## Non-goals

- No boss name or rank/place extraction — confirmed with the user, only the reward
  lots themselves matter. The model is told to ignore that part of the screenshot.
- No change to feast's recognition path, `color-detect.ts`'s general-purpose pixel
  sampling code, or `layout-templates.ts`'s `feast` entry.
- No new npm dependency — one API call is a plain `fetch` (Node 20+ has it built in),
  not worth adding `@anthropic-ai/sdk` for.
- No caching/dedup of vision results across retries — a retried upload (the client
  already retries a failed file up to 3 times) just calls the API again. Cheap enough
  in practice; not worth the complexity of caching a response keyed on image bytes.
- No configurable model/prompt — hardcoded constants in `vision.ts`, changed by
  editing code if the extraction quality needs tuning later, not by an env var nobody
  would know to set.
- No client-side image-format change — the client already compresses to JPEG before
  upload (`eventDetail.ts`'s `compressForUpload`); the vision call reuses those same
  bytes as-sent, declared as `image/jpeg`.

## Architecture

### New module: `src/server/vision.ts`

```typescript
export interface VisionLotItem {
  x: number; y: number; w: number; h: number; // fractions of full image, top-left + size
  rarity: 'blue' | 'purple' | 'red';
  quantity: number; // positive integer, read from the icon's own ×N badge
}

export async function extractInvasionLoot(imageBuffer: Buffer, apiKey: string): Promise<VisionLotItem[]>
```

Calls Anthropic's Messages API (`POST https://api.anthropic.com/v1/messages`,
`x-api-key`/`anthropic-version: 2023-06-01` headers) with the image as a base64
`image/jpeg` content block plus a text block describing the "Трофеи" screen and
asking for every reward icon's box/rarity/quantity — **not** boss name or rank.
Structured output is enforced via a forced tool call (a single tool,
`tool_choice: {type: 'tool', name: 'extract_trophy_loot'}`, `input_schema` matching
`VisionLotItem[]` wrapped in `{items: [...]}`) rather than parsing free text — Claude
constrains its output to the schema, so parsing is just reading
`response.content.find(b => b.type === 'tool_use').input.items` with no free-text
JSON-extraction fragility.

Model: `claude-sonnet-5` (a top-level constant in `vision.ts`, see Non-goals on why
this isn't configurable). `max_tokens: 8000` — generous headroom, not a tight budget:
Sonnet 5 runs adaptive thinking by default when `thinking` is omitted (unlike older
models), and its tokenizer is denser than prior generations, so a tight budget sized
just for the item JSON risks truncating mid-array on a screenshot with many icons — an
error none of the tests can catch, since they all stub `fetch`. Paying for headroom
that goes unused costs nothing extra; only tokens actually generated are billed. The
response's `stop_reason` is checked and treated as an error if it's `'max_tokens'`,
so a truncation that somehow still happens fails loudly instead of silently returning
a partial item list.

Validates every returned item (`x/y/w/h` are finite numbers in `[0,1]` and `x+w`/`y+h`
each stay within `1` — a box the model places right at the image edge would otherwise
reach `cropBox` with a region that extends past the source image and throws a raw
sharp error instead of a clean validation message; `rarity` is one of the three
values; `quantity` is a positive integer) and throws a descriptive `Error` if the API
call fails (non-2xx), the response has no `tool_use` block, or any item fails
validation — the caller doesn't need to guess what went wrong from a generic parse
failure.

### Config & wiring

- `src/server/config.ts`: `Config.anthropicApiKey?: string`, read from
  `ANTHROPIC_API_KEY`. **Optional at load time** (feast-only deployments, and every
  existing test, don't need it) — `vision.ts` throws its own clear error
  (`"ANTHROPIC_API_KEY is not configured"`) if `extractInvasionLoot` is actually
  called without a key, rather than `loadConfig` failing hard for installs that only
  ever run feast events.
- `src/server/types.ts`: `AppDeps.anthropicApiKey?: string`, threaded through from
  `index.ts` the same way `botToken`/`dataDir` already are.
- `.env.example`: add `ANTHROPIC_API_KEY=sk-ant-...` (commented as invasion-only,
  paid per screenshot).

### `screenshots.ts`: per-template candidate extraction

Today, one loop over `fileBuffers` produces a flat `slicedRows[]` (`{screenshotId,
cellPath, imagePath}`) for both templates via the same grid-slice call, which the
code below it turns into lots by computing an icon signature per `imagePath`,
grouping identical icons (`groupBySignature`), and — critically — using **group
size** as the quantity (`group.length`, one row = one unit). Rarity is read
separately, from `cellPath`, via `detectColor`.

This design generalizes to both a "one row = one unit" world (feast) and a "each
icon already carries its own count" world (invasion) if quantity becomes a property
of each candidate instead of an implicit row count:

```typescript
interface LotCandidate {
  screenshotId: number;
  imagePath: string;         // cropped icon, used for both signature + display
  color: RarityColor;
  quantity: number;          // this candidate's own contribution to the eventual lot
}
```

Per uploaded file, branch on `template`:

- **`feast`** (unchanged behavior, just reshaped into `LotCandidate[]`): slice rows
  via `sliceImageToCells` as today, crop each row's `iconBox`, `detectColor` on the
  row strip. Each resulting candidate gets `quantity: 1` — one row is one unit,
  exactly matching today's `group.length` behavior once summed (see below).
- **`invasion`**: `extractInvasionLoot(fileBuffers[f], deps.anthropicApiKey)` once
  per file. For each returned `VisionLotItem`, `cropBox(originalPath, {x,y,w,h},
  outPath)` — the *same* existing utility `grid-slice.ts` already uses for
  `iconBox` cropping, since a `VisionLotItem`'s `{x,y,w,h}` is exactly a
  `layout-templates.ts` `Box` (fractions of the full image). Candidate's `color`
  is `item.rarity` directly (no `detectColor` call for invasion at all —
  `color-detect.ts` is now feast-only). Candidate's `quantity` is `item.quantity`
  as read by the model. If `deps.anthropicApiKey` is missing, fail the whole
  request with a 400 (`'ANTHROPIC_API_KEY is not configured for invasion
  screenshots'`) before touching any files — same "fail fast" spirit as the
  existing validation block.

The shared code after this point (signature computation, `groupBySignature`,
cross-upload pool-dedup against `existingPoolItems`, `lot_library` lookup, final
`INSERT INTO items`) changes in exactly one place: **quantity is summed across a
group's candidates**, not counted:

```typescript
const quantity = group.reduce((sum, c) => sum + c.quantity, 0);
```

replacing every current `group.length` (both the new-item insert and the
`bumpQuantity.run(group.length, existingMatch.item.id)` cross-upload merge — that
becomes `bumpQuantity.run(quantity, existingMatch.item.id)`). For feast this is
behaviorally identical (`quantity: 1` per candidate, so the sum equals the old
count). For invasion it correctly adds e.g. `×2 + ×1` if the same item drops from
two different boss rows on one screenshot.

`rows` (the admin-supplied row count) stops being read or validated for
`template === 'invasion'` — the model determines the layout itself. It stays
required for `feast`.

### `layout-templates.ts`

`LAYOUT_TEMPLATES` becomes `Partial<Record<Template, LayoutTemplate>>` with only a
`feast` entry — the `invasion` entry (and its 2026-08-26 pixel-calibration comment)
is deleted, since nothing calls `sliceImageToCells`/`detectColor` for invasion
anymore. `Template`/`isTemplate()` are unchanged — `'invasion'` is still a valid
`screenshots.template`/win-limit-rule value, it just no longer indexes into
`LAYOUT_TEMPLATES`.

### Admin upload UI (`web/views/eventDetail.ts`)

The "Строк на каждом скрине" (`rows`) input is only relevant for feast now. Add a
`change` listener on the template `<select>` that toggles the `rows` input's
`disabled`/`required` attributes (hidden via existing `style.display`, no new CSS) —
disabled+not-required when `invasion` is selected, so the browser doesn't block
submission on an empty field the server no longer reads. Note: the submit handler
builds its own `FormData` by hand rather than submitting the form natively (it always
reads `rows`'s `.value` and appends it), so `disabled` does *not* strip the field the
way it would on a native form submit — it's still sent (as an empty string, harmless,
since the server only validates/reads `rows` for `template === 'feast'`). Upload-flow
help text gets one added sentence noting invasion screenshots are read automatically,
no row count needed, and naming the actual screen to capture ("Трофеи").

## Error handling

- Missing `ANTHROPIC_API_KEY` at invasion-upload time: 400, fails before any file is
  processed (checked once at the top of the request handler, mirroring the existing
  `rows`/`template` validation block).
- Vision API network/HTTP failure, or a malformed/unparseable response: the specific
  file's upload attempt fails with a clear error message surfaced through the
  existing per-file error path in `eventDetail.ts` (already retries up to 3 times
  and reports which files failed) — no new retry logic needed.
- Zero items returned for a given screenshot (e.g. a screenshot of the wrong screen):
  not an error — that file just contributes zero items, same as if `slicedRows` were
  empty today.

## Testing

- `tests/server/vision.test.ts` (new): stubs `globalThis.fetch` (vitest
  `vi.stubGlobal`) to verify the request shape (model, forced `tool_choice`, image
  content block, prompt mentions ignoring boss name/rank) and response parsing —
  valid `tool_use` response parses to the expected array; non-2xx response throws;
  missing `tool_use` block throws; an item failing field validation (bad rarity
  string, non-integer quantity, out-of-range box) throws; missing `apiKey` throws
  without calling `fetch` at all.
- `tests/server/routes/screenshots.test.ts`: `vi.mock('../../../src/server/vision')`
  to stub `extractInvasionLoot` — no real network calls in the route-level tests.
  New cases: an invasion upload with a mocked multi-item response creates that many
  lots with the mocked rarity/quantity; two mocked items with icons that hash as
  the same signature (reuse a fixture image for both) merge into one lot with
  **summed** quantity; missing `ANTHROPIC_API_KEY` on an invasion upload 400s
  without calling the mocked `extractInvasionLoot` at all; a feast upload in the
  same test file is unaffected (still exercises the real local grid-slice path,
  confirming the branch didn't leak into feast).
- Existing feast tests need no behavior changes — the `LotCandidate`/summed-quantity
  refactor is designed to be a no-op for feast (see Architecture above); rerun them
  as regression coverage that the refactor didn't change feast's observable output.
