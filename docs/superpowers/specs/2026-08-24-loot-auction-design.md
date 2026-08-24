# Loot Auction Mini App — Design

## Purpose

A Telegram Mini App for distributing in-game loot (event/boss drop screenshots)
among alliance members. Admins upload reward screenshots, members claim the
items they want, and admins resolve all claims for an event at once by
randomly picking one winner per item from its claimants.

## Context

- Source game: a mobile alliance strategy game with a 30-minute in-game
  auction window for event loot. This app runs a *separate*, informal
  claim-and-random-draw process among alliance members, ahead of / instead of
  bidding in the game's own auction.
- Reward screenshots from the game show a uniform grid of item icons (e.g. a
  "Предпросмотр наград" screen with a 2×5 grid of gear icons). Item names are
  not readable from the icon alone — an admin must type a name per item.

## Non-goals

- No push notifications to users (explicit decision — status is pull-only,
  visible when the user opens the app).
- No OCR / auto-detection of item names from icons — admin types them.
- No freehand crop editor — reward screenshots are always a uniform grid, so
  grid slicing (rows × cols) is the only cropping mechanism.
- No in-app bidding/currency — this is a claim + random draw, not an auction
  with bids.
- No auto-trigger of the draw by time — the countdown shown to users is
  informational only; an admin always presses "Разыграть всё" manually.

## Architecture

Single Node.js/TypeScript service:

- **Telegraf** bot — replies to `/start` with a button that opens the Mini
  App.
- **Fastify** (or Express) HTTP server in the same process — serves the
  built Mini App frontend (static files) and a small JSON API under
  `/api/*`.
- **SQLite** (single file, e.g. via `better-sqlite3`) — all persistent data.
- **Local disk** — uploaded screenshots and sliced item-icon images, served
  as static files under e.g. `/uploads/*`.
- **sharp** — server-side image slicing (grid crop) on upload.
- **Nginx** in front, terminating HTTPS via Let's Encrypt (required by
  Telegram for Mini Apps). Reverse-proxies to the Node process.
- Runs as a single systemd (or pm2) service on a small VPS. No Docker, no
  container orchestration, no separate DB server — one process, one SQLite
  file, one uploads folder. Backup = copy the DB file + uploads folder.

## Data model (SQLite)

```
users
  telegram_id      INTEGER PRIMARY KEY
  username         TEXT
  game_nickname    TEXT
  is_admin         INTEGER (0/1)   -- derived from a configured admin id list at startup, cached here for convenience
  created_at       TEXT

events
  id               INTEGER PRIMARY KEY
  title            TEXT
  deadline_at      TEXT            -- informational only, see below
  status           TEXT            -- 'open' | 'resolved'
  created_at       TEXT

screenshots
  id               INTEGER PRIMARY KEY
  event_id         INTEGER REFERENCES events(id)
  original_path    TEXT
  rows             INTEGER
  cols             INTEGER
  uploaded_by      INTEGER REFERENCES users(telegram_id)
  uploaded_at      TEXT

items
  id               INTEGER PRIMARY KEY
  event_id         INTEGER REFERENCES events(id)
  screenshot_id    INTEGER REFERENCES screenshots(id)
  name             TEXT
  image_path       TEXT            -- cropped cell image
  status           TEXT            -- 'pool' | 'auctioned' | 'removed'
  winner_telegram_id INTEGER NULL REFERENCES users(telegram_id)
  created_at       TEXT
  auctioned_at     TEXT NULL

claims
  id               INTEGER PRIMARY KEY
  item_id          INTEGER REFERENCES items(id)
  telegram_id      INTEGER REFERENCES users(telegram_id)
  created_at       TEXT
  UNIQUE(item_id, telegram_id)

settings
  id               INTEGER PRIMARY KEY CHECK (id = 1)  -- single row
  max_simultaneous_claims INTEGER NOT NULL DEFAULT 5
```

## Admin flow

1. Admin creates an event: title + a claim-window duration (e.g. 25 minutes)
   → `deadline_at = now + duration` is stored.
2. Admin uploads a screenshot for that event, enters `rows` and `cols` for
   the grid it contains. Backend slices the image into `rows * cols` equal
   cells with `sharp` and creates one `items` row per cell (default name
   empty).
3. Admin is shown the freshly sliced icons in a small list, each with a text
   input, and types a name per icon. Saving makes those items visible in the
   event's pool (`status = 'pool'`).
4. Steps 2–3 repeat for any further screenshots belonging to the same event.
5. All users see a live countdown ("Приём заявок до HH:MM") on the event's
   pool screen. It does not gate or auto-trigger anything — it exists so the
   admin and members know roughly how much time is left before the admin
   decides to resolve.
6. When ready, admin presses **"Разыграть всё"** on the event. Server-side,
   for every item in that event with `status = 'pool'`: pick one random
   `telegram_id` from its `claims` (if any), set `winner_telegram_id` and
   `status = 'auctioned'`. Items with zero claims are left as `pool`
   (nothing to resolve) — admin can still act on them individually. Event
   `status` is set to `'resolved'`.
7. Admin can mark any individual item `status = 'removed'` at any time,
   independent of the bulk draw (hides it from the user-facing pool).

## User flow

1. User opens the Mini App via the bot. Telegram supplies identity
   (`telegram_id`, `username`) through Mini App `initData` — no separate
   login.
2. First-time users are prompted once for their in-game nickname
   (`game_nickname`), editable later from a small profile screen.
3. Main screen shows the current/most recent event's pool: item icon + name
   + a claim button, plus the countdown banner.
4. Tapping "Хочу" creates a `claims` row, provided the user has fewer than
   `settings.max_simultaneous_claims` active claims across all `pool` items;
   otherwise show an inline error. Tapping "Отказаться" on an already-claimed
   item deletes the claim.
5. Once an item's `status = 'auctioned'`, its card shows "Разыграно:
   `<winner nickname>`" instead of the claim button, for everyone. No
   notification is sent to winners or losers.

## Auth / security

- Every API request from the Mini App carries Telegram's `initData`; the
  backend verifies its HMAC signature against the bot token before trusting
  the `telegram_id` in it. This is the only identity mechanism — never trust
  a client-supplied `telegram_id` without verifying `initData`.
- `is_admin` is derived from a fixed list of Telegram user IDs in an env var
  (e.g. `ADMIN_TELEGRAM_IDS=123,456`), checked server-side on every admin
  endpoint (upload, slice, name items, resolve event, remove item, change
  settings). No role/permission system beyond this boolean.

## Error handling

- Grid slicing with `rows`/`cols` that don't evenly divide the image
  dimensions: crop using `floor(width/cols)`, `floor(height/rows)` per cell
  (accept a few leftover pixels at the image edges rather than rejecting the
  upload).
- Resolving an event twice, or resolving an already-`resolved` event: no-op,
  return the existing result rather than erroring or re-rolling winners.
- Claiming an already-`auctioned` or `removed` item, or claiming past the
  per-user limit: rejected with a clear inline message, not a silent no-op.

## Testing

Hobby-scale, single/few-admin app — unit tests only, on the branching logic
that actually matters:

- Random winner selection picks only from that item's claimants and is a
  no-op when there are zero claimants.
- Claim-limit enforcement (at the limit, over the limit, after releasing a
  claim).
- Grid slicing produces `rows * cols` non-overlapping cells covering the
  source image.
- `initData` verification accepts a validly-signed payload and rejects a
  tampered one.

No e2e test suite for this scope.
