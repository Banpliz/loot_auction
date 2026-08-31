# FCFS Reservation — Design

Supersedes the claim-then-random-draw mechanic described in
[2026-08-24-loot-auction-design.md](2026-08-24-loot-auction-design.md). That
doc's Architecture, Stack, and DB-file/backup sections still apply unchanged;
this doc only covers what changes.

## Purpose

After live testing, the alliance voted to replace "claim now, admin
randomly draws a winner later" with **first-come-first-served reservation**:
clicking "Ставка" immediately reserves one unit of a lot, decrementing its
stock. Once a lot's stock hits zero it goes gray and stops accepting claims;
everyone can see who took it. No draw step exists anymore.

Two more changes ride along with this, both requested by the admin:
- Lots the admin is still uploading/editing must stay invisible to users
  until the admin explicitly starts the auction.
- The old random-draw code (`src/server/random.ts`) must not be deleted —
  keep it in the repo, unused, in case the raffle model is ever needed again.

## Non-goals

- No redesign of the visual style. Every UI change reuses existing CSS
  classes/components (`.status-pill`, `.badge`, `.winners`/`<details>`,
  `.qty-tag`, `.admin-item`, `.lot-row`) — see "UI" section below for the
  exact reuse. No new classes, no new visual language.
- No migration/deletion of the `item_winners` table. It stops being written
  to or read from, but stays in the schema untouched — the admin has already
  run live tests, so any past win records it holds are left alone rather than
  risking data loss for a cosmetic cleanup.
- No auto-transition of `events.status` on deadline expiry. Passing the
  deadline already blocks new claims/unclaims (existing `isPastDeadline`
  check); flipping the event to its final status is still a deliberate admin
  action ("Завершить аукцион"), same as the old "Разыграть всё" was.
- No minimum-lots-before-start guard, no "unstart" / back-to-draft action —
  not requested, adds a state transition nobody asked for.

## Event lifecycle

New three-state `events.status`: **`draft` → `open` → `resolved`**
(`resolved` is an existing string, reused for the new "finished" meaning
instead of "raffled").

```
draft   — admin is uploading/editing lots. deadline_at is NULL.
          Invisible to users (GET /events/current excludes it).
          Screenshot upload + item edit/merge/remove endpoints allowed.
  │  POST /events/:id/start { durationMinutes }  (admin)
  ▼
open    — deadline_at = now + durationMinutes. Visible to users.
          Editing endpoints now rejected (409) — lots are locked.
          Claim/unclaim allowed until deadline_at passes.
  │  POST /events/:id/finish  (admin, any time while open)
  ▼
resolved — deadline_at forced into the past if it wasn't already.
           Claim/unclaim now rejected by the existing deadline check.
           Terminal.
```

- `POST /events` now takes only `{ title }` and creates the row in `draft`
  with `deadline_at = NULL`. The `durationMinutes` field moves from the
  create-event form to the new start-auction action.
- `GET /events/current` adds `WHERE status != 'draft'` to its existing
  `ORDER BY id DESC LIMIT 1` — so a draft-in-progress event neither shows
  itself nor hides whatever event users were previously looking at.
- `POST /events/:id/start` — admin only, 404 if missing, 409 if
  `status != 'draft'`, 400 if `durationMinutes` isn't a positive number.
  Sets `deadline_at = now + durationMinutes*60000`, `status = 'open'`.
- `POST /events/:id/finish` — admin only, 404 if missing, 409 if
  `status != 'open'`. Sets `status = 'resolved'` and, only if
  `deadline_at` is null or still in the future, sets it to `now()` — this
  reuses the existing `isPastDeadline` check as the sole enforcement point
  for "no more claims," instead of adding a parallel status check to every
  claim/unclaim call site.
- `POST /events/:id/resolve` (the random draw) is deleted, along with its
  use of `pickRandom`/`shuffle` in `events.ts`. `src/server/random.ts`
  itself is left as-is — it has no other dependents, so it simply becomes
  unused rather than deleted, satisfying "keep it separately."
- Draft-only edit lock: `PUT /items/:id`, `DELETE /items/:id`,
  `POST /items/:id/merge`, and `POST /events/:id/screenshots` each start
  rejecting with 409 (`"event is not in draft"`) once the owning event's
  `status != 'draft'`. A small shared helper (e.g. `requireDraftEvent(deps,
  eventId)` in `items.ts`, imported by `screenshots.ts`) looks up the
  event's status for this check.

## Reservation mechanic

`items.quantity` becomes the live remaining-stock counter (previously it was
a fixed total consumed only at draw time). `items.status` keeps its existing
three values, with `auctioned` reinterpreted as "sold out" instead of "won by
a draw":

- **`pool`** — still has stock (`quantity > 0`), claimable.
- **`auctioned`** — `quantity` hit 0, no longer claimable, shown gray.
- **`removed`** — unchanged, admin-removed lot.

### `POST /items/:id/claim` (rewritten, runs in one `db.transaction`)

1. Load the item (status, `event_id`, `quantity`, `color`, `category`) via a
   join to `screenshots` for `template`. 404 if missing.
2. 409 `"item is not claimable"` if `status != 'pool'`.
3. Load the event's `status`/`deadline_at`. 409 `"auction is not open"` if
   `status != 'open'`; 409 `"bidding has ended"` if past deadline (existing
   `isPastDeadline` helper, now also called here — same message/behavior as
   today, just reached from one more branch).
4. 409 `"already claimed"` if a `claims` row for `(item_id, telegram_id)`
   already exists (replaces today's silent `INSERT OR IGNORE`, which no
   longer makes sense once a claim also mutates stock).
5. Compute this user's current per-group counts for the event: join
   `claims → items → screenshots` for `(event_id, telegram_id)`, and for
   each row run it through the *same* `winLimitGroup(template, color,
   category)` used by the old draw loop, tallying by `key`. This is the same
   rule, just evaluated live per attempt instead of once at draw time over
   the whole claimant pool.
6. 409 `"win limit reached"` if `counts[key] >= limit`; 409 `"already won in
   the other category"` if `exclusiveWith` is set and
   `counts[exclusiveWith] > 0`. (Feast's item/stone mutual exclusivity from
   commit `a66415c`, carried over unchanged.)
7. Insert the `claims` row. `UPDATE items SET quantity = quantity - 1,
   status = CASE WHEN quantity - 1 <= 0 THEN 'auctioned' ELSE 'pool' END
   WHERE id = ?`.

Steps 1–7 run inside one `better-sqlite3` transaction (synchronous, so no
separate row-locking is needed for the decrement to be race-safe — matches
the existing pattern in `events.ts`'s old `resolveAll`).

### `DELETE /items/:id/claim` (unclaim)

Same guards as claim (event must be `open`, before deadline). If a `claims`
row existed and was deleted, `UPDATE items SET quantity = quantity + 1,
status = 'pool' WHERE id = ?` unconditionally — a successful delete always
means the item was previously decremented for this exact claim, so giving
the unit back always returns it to `pool` (even if it had reached
`auctioned`).

### Winners display

`attachWinners` in `events.ts` currently joins `item_winners`. It switches to
joining `claims → users` instead — under FCFS, "who has this lot" and "who
claimed this lot" are the same set by construction, so a separate
winners-ledger table is redundant. The shape it returns
(`{ itemId, telegramId, nickname }[]`) is unchanged, so `pool.ts` and
`eventDetail.ts` need no data-shape changes, only the label described below.

`item_winners` inserts are removed entirely (there is no more draw step to
populate it from). The table stays in the schema — see Non-goals — and
`DELETE /events/:id` keeps its existing `DELETE FROM item_winners WHERE
item_id IN (...)` cleanup line, since `better-sqlite3` runs with
`PRAGMA foreign_keys = 1` and any pre-existing `item_winners` rows from
before this change would otherwise break that delete with a FK violation
(this exact failure mode is what commit `ad5f8fd`'s predecessor already
fixed once for `item_winners`).

## UI changes (existing style/components only)

**`web/views/admin.ts`** (event list + create form):
- Create form drops the `durationMinutes` field — title only.
- `STATUS_LABEL` gains `draft: 'Черновик'`; `resolved` label text changes
  from `'Разыгран'` to `'Завершён'` (same `.event-card-meta`/`.status-pill`
  markup, just accurate wording for a mechanic that no longer draws).

**`web/views/eventDetail.ts`** (admin event detail) — branches on
`event.status`, reusing the same section/card markup in all three cases,
no new CSS:
- `draft`: unchanged from today — upload form + editable `.admin-item` grid
  (name/color/category/quantity inputs, save/remove/merge buttons). The
  "Разыграть всё" button/section is replaced by a "Начать аукцион" button
  with a duration-minutes `<input>` next to it (the same `<label>`+`<input
  type="number" min="1" value="25">` markup that's being removed from
  `admin.ts`'s create form, moved here), wired to
  `POST /events/:id/start`.
- `open`: upload form section is hidden entirely. The `.admin-item` cards
  render read-only — the same card container, but `name`/`color`/`category`
  inputs become plain text and the quantity input becomes a plain number,
  with save/remove/merge buttons omitted. A "Завершить аукцион" button
  (same `.btn-block` styling the old "Разыграть всё" used) replaces it,
  wired to `POST /events/:id/finish`, with the same `confirm(...)` guard
  pattern already used before resolving.
- `resolved`: same read-only card rendering as `open`, no action button.

**`web/views/pool.ts`** (user-facing lot list):
- `renderItem`'s border-left color becomes conditional:
  `item.status === 'auctioned' ? 'var(--border)' : colorHex(item.color)` —
  this is the "grays out" behavior, done with the existing inline-style
  mechanism and an existing CSS token, no new class.
- The `<details class="winners">` block's `<summary>` text changes from
  `Победители (N)` to `Забрали (N)` — same component, same CSS classes,
  wording only (it's no longer describing a draw's winners).
- The existing `×${item.quantity}` `.qty-tag` needs no change — since
  `quantity` is now live remaining stock, the same tag already reads as
  "N left" once some units are claimed, with zero markup changes.
- Claim/unclaim button logic (`item.status === 'auctioned'` → show the
  winners/"Забрали" block instead of a button; `biddingClosed` → "Приём
  заявок окончен" badge; otherwise claim/unclaim button) is already
  structured this way today and needs no restructuring — only the label
  swap above.

## Testing

- `tests/server/routes/events.test.ts`: replace resolve-endpoint tests with
  `start`/`finish` tests (draft→open deadline math, wrong-state 409s,
  `GET /events/current` excluding drafts). `attachWinners`-via-`claims`
  covered implicitly by claim tests below (an item with two claimants shows
  both once sold out).
- `tests/server/routes/items.test.ts`: claim now needs cases for — stock
  decrement to `auctioned` at zero, reject over win-limit-group cap, reject
  the feast item/stone mutual-exclusivity case, reject when event isn't
  `open` or is past deadline, reject double-claim; unclaim needs — stock
  increment and status back to `pool` from `auctioned`, guarded by the same
  open/deadline checks. Edit-lock tests (`PUT`/`DELETE`/`merge`/screenshot
  upload all 409 once `status != 'draft'`).
- `tests/server/db.test.ts`: no schema change, so no new migration test is
  needed (see Non-goals — `item_winners` isn't touched).
- `src/server/random.ts` and `tests/server/random.test.ts` are left
  untouched — nothing about this change modifies random.ts, it just loses
  its one caller in `events.ts`.
