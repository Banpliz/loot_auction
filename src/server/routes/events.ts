import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';
import { publishChange } from '../pubsub';
import { shuffle } from '../random';

interface EventRow {
  id: number;
  title: string;
  deadline_at: string | null;
  starts_at: string | null;
  status: string;
}

const START_DELAY_MS = 10_000;

type ColorGroup = 'red' | 'blue';
// 'stone' is a legacy category value (pre-2026-09-09, when there was only one kind of
// camni) — categoryGroup() below folds it into 'stone_temper', the closer match (same
// cap of 3 the old shared 'stone' group had).
type CategoryGroup = 'item' | 'stone_temper' | 'stone_remelt';

// Fixed by design, not admin-configurable. Invasion caps blue at 2/event and red at
// 1/event. Purple used to share red's group (combined 1/event) but now has its own rule
// entirely — a daily, rank-based cap across every event, not a per-event one — see
// items.ts's getPurpleClaimedToday; this function is never consulted for purple anymore.
// Feast's alliance rule cuts across colors instead, grouped by admin-set item.category:
// gear capped at 2, tempering stones (closer, more plentiful) at 3, remelting stones
// (rarer, add properties) at 1. Gear is mutually exclusive with BOTH stone kinds — winning
// any gear rules out winning either kind of stone, and vice versa — but the two stone
// kinds are independent of each other (2026-09-09): winning a temper stone doesn't block
// winning a remelt stone too. Originally enforced once at the end-of-event draw; now
// enforced by items.ts's claim endpoint on every single claim attempt (2026-08-31), since
// there's no more draw step — see docs/superpowers/specs/2026-08-31-fcfs-reservation-design.md.
const COLOR_WIN_LIMITS: Record<ColorGroup, number> = { red: 1, blue: 2 };
const CATEGORY_WIN_LIMITS: Record<CategoryGroup, number> = { item: 2, stone_temper: 3, stone_remelt: 1 };

function colorGroup(color: string): ColorGroup {
  return color === 'blue' ? 'blue' : 'red';
}

function categoryGroup(category: string): CategoryGroup {
  if (category === 'stone_remelt') return 'stone_remelt';
  if (category === 'item') return 'item';
  return 'stone_temper';
}

// Returns a per-person counter key (namespaced so a color group and a category group
// can never collide), the cap that applies to it, and — for feast only — the other
// group key(s): an existing win in any of them makes a person ineligible for this one
// too. Exported for items.ts's claim endpoint. Never called with color 'purple' under
// template 'invasion' — items.ts intercepts that case before reaching this function.
export function winLimitGroup(template: string, color: string, category: string): { key: string; limit: number; exclusiveWith?: string[] } {
  if (template === 'feast') {
    const group = categoryGroup(category);
    const exclusiveWith = group === 'item' ? ['cat:stone_temper', 'cat:stone_remelt'] : ['cat:item'];
    return { key: `cat:${group}`, limit: CATEGORY_WIN_LIMITS[group], exclusiveWith };
  }
  const group = colorGroup(color);
  return { key: `color:${group}`, limit: COLOR_WIN_LIMITS[group] };
}

const ITEM_COLUMNS = `i.id, i.name, i.color, i.category, i.class, i.quantity, i.image_path as imagePath, i.status, s.template as template`;

// Rarest-looking first: red, then purple, then blue — matches the in-game rarity
// order, not insertion order.
const COLOR_ORDER_SQL = `CASE i.color WHEN 'red' THEN 0 WHEN 'purple' THEN 1 WHEN 'blue' THEN 2 ELSE 3 END`;

interface Winner {
  telegramId: number;
  nickname: string | null;
  quantity: number;
}

// Attaches a `winners` array to each item. Invasion still reserves instantly on claim
// (see items.ts), so "claimed a unit" and "has a unit" are the same thing there — read
// straight from `claims`. Feast went back to a raffle: a claim there is just an entry,
// and the actual winners are whoever the draw in POST /events/:id/finish wrote to
// `item_winners` (always exactly one unit each, per that table's UNIQUE(item_id,
// telegram_id) — a raffle never hands one person two units of the same lot).
function attachWinners<T extends { id: number }>(deps: AppDeps, items: T[]): (T & { winners: Winner[] })[] {
  if (items.length === 0) return [];
  const placeholders = items.map(() => '?').join(',');
  const ids = items.map((i) => i.id);

  const invasionRows = deps.db
    .prepare(
      `SELECT c.item_id as itemId, u.telegram_id as telegramId, u.game_nickname as nickname, c.quantity as quantity
       FROM claims c
       JOIN items i ON i.id = c.item_id
       JOIN screenshots s ON s.id = i.screenshot_id
       LEFT JOIN users u ON u.telegram_id = c.telegram_id
       WHERE c.item_id IN (${placeholders}) AND s.template = 'invasion'`
    )
    .all(...ids) as { itemId: number; telegramId: number; nickname: string | null; quantity: number }[];

  const drawnRows = deps.db
    .prepare(
      `SELECT w.item_id as itemId, u.telegram_id as telegramId, u.game_nickname as nickname
       FROM item_winners w
       JOIN items i ON i.id = w.item_id
       JOIN screenshots s ON s.id = i.screenshot_id
       LEFT JOIN users u ON u.telegram_id = w.telegram_id
       WHERE w.item_id IN (${placeholders}) AND s.template != 'invasion'`
    )
    .all(...ids) as { itemId: number; telegramId: number; nickname: string | null }[];

  const winnersByItem = new Map<number, Winner[]>();
  for (const row of invasionRows) {
    const list = winnersByItem.get(row.itemId) ?? [];
    list.push({ telegramId: row.telegramId, nickname: row.nickname, quantity: row.quantity });
    winnersByItem.set(row.itemId, list);
  }
  for (const row of drawnRows) {
    const list = winnersByItem.get(row.itemId) ?? [];
    list.push({ telegramId: row.telegramId, nickname: row.nickname, quantity: 1 });
    winnersByItem.set(row.itemId, list);
  }
  return items.map((item) => ({ ...item, winners: winnersByItem.get(item.id) ?? [] }));
}

// The random draw a feast lot gets at POST /events/:id/finish (see below). Shuffles both
// the order lots are resolved in and their claimants, then hands out exactly `quantity`
// distinct winners per lot — respecting the item/stone category cap and mutual exclusion
// (see winLimitGroup) — same spirit as the pre-FCFS raffle this restores, generalized to
// lots with more than one unit. Invasion lots are never in this list: they're excluded by
// the 'pool' + non-invasion filter in the caller, since invasion still resolves instantly
// on claim and has nothing left to draw for.
function drawWinners(deps: AppDeps, eventId: number): void {
  const poolItems = deps.db
    .prepare(
      `SELECT i.id, i.color, i.category, i.quantity, s.template
       FROM items i JOIN screenshots s ON s.id = i.screenshot_id
       WHERE i.event_id = ? AND i.status = 'pool' AND s.template != 'invasion'`
    )
    .all(eventId) as { id: number; color: string; category: string; quantity: number; template: string }[];
  const gearItems = poolItems.filter((i) => categoryGroup(i.category) === 'item');
  const stoneItems = poolItems.filter((i) => categoryGroup(i.category) !== 'item');
  const temperItems = stoneItems.filter((i) => categoryGroup(i.category) === 'stone_temper');

  const groupCounts = new Map<number, Map<string, number>>();
  const remainingByItem = new Map<number, number>(poolItems.map((i) => [i.id, i.quantity]));
  const wonItemsByPerson = new Map<number, Set<number>>();
  const insertWinner = deps.db.prepare('INSERT INTO item_winners (item_id, telegram_id) VALUES (?, ?)');

  const claimantsCache = new Map<number, { telegram_id: number }[]>();
  const claimantsFor = (itemId: number) => {
    if (!claimantsCache.has(itemId)) {
      claimantsCache.set(itemId, deps.db.prepare('SELECT telegram_id FROM claims WHERE item_id = ?').all(itemId) as { telegram_id: number }[]);
    }
    return claimantsCache.get(itemId)!;
  };

  function award(itemId: number, telegramId: number, key: string): void {
    insertWinner.run(itemId, telegramId);
    remainingByItem.set(itemId, remainingByItem.get(itemId)! - 1);
    const counts = groupCounts.get(telegramId) ?? new Map<string, number>();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    groupCounts.set(telegramId, counts);
    const won = wonItemsByPerson.get(telegramId) ?? new Set<number>();
    won.add(itemId);
    wonItemsByPerson.set(telegramId, won);
  }

  // Reward bundle (alliance rule, 2026-09-09): winning a remelt stone comes packaged with
  // up to 2 temper stones in the real game, but only for someone who was actually after
  // both — i.e. who placed a claim on at least one temper lot too, not just the remelt
  // one. Runs as a SEPARATE pass after every lot's own fair random draw below has already
  // finished (not inline as each remelt winner is picked) — someone who only bid on a
  // temper lot, never on remelt, still gets an equal random shot at it there, same as
  // anyone else. The bundle only ever mops up whatever's left over on temper lots THIS
  // PERSON claimed once that fair draw is done (never any lot they didn't personally
  // claim) — and by construction, stock only survives the fair draw on a lot someone
  // claimed if that person had already hit their own temper cap (otherwise the fair draw
  // would have simply given it to them). So this deliberately does NOT re-check the
  // per-person temper cap: gating the bonus by the same cap that created the leftover
  // would make it a no-op in practice. It never takes a unit that would otherwise have
  // gone to a different, still-eligible claimant — only true leftovers.
  function grantTemperBundle(telegramId: number): void {
    const claimedTemperItems = temperItems.filter((t) => claimantsFor(t.id).some((c) => c.telegram_id === telegramId));
    if (claimedTemperItems.length === 0) return;

    const temperKey = 'cat:stone_temper';
    let toGrant = 2;
    const won = wonItemsByPerson.get(telegramId) ?? new Set<number>();
    const eligible = shuffle(claimedTemperItems.filter((t) => remainingByItem.get(t.id)! > 0 && !won.has(t.id)));
    for (const t of eligible) {
      if (toGrant <= 0) break;
      award(t.id, telegramId, temperKey);
      toGrant -= 1;
    }
  }

  // Draws one category's lots in random order with random claimant order per lot —
  // shared by both phases below. `onWin` lets the gear/stone split above still track
  // which people won a remelt lot without a third pass over everything.
  const remeltWinners: number[] = [];
  function drawGroup(items: typeof poolItems, onWin?: (itemId: number, telegramId: number, category: string) => void): void {
    for (const item of shuffle(items)) {
      const { key, limit, exclusiveWith } = winLimitGroup(item.template, item.color, item.category);

      for (const claimant of shuffle(claimantsFor(item.id))) {
        if (remainingByItem.get(item.id)! <= 0) break;
        const counts = groupCounts.get(claimant.telegram_id) ?? new Map<string, number>();
        if ((counts.get(key) ?? 0) >= limit) continue;
        if (exclusiveWith?.some((other) => (counts.get(other) ?? 0) > 0)) continue;

        award(item.id, claimant.telegram_id, key);
        onWin?.(item.id, claimant.telegram_id, item.category);
      }
    }
  }

  // Gear first (alliance request, 2026-09-10): with gear and stones mutually exclusive,
  // whichever category got drawn first used to decide who was locked out of the other —
  // a person could lose a gear piece they wanted just because one of their stone lots
  // happened to shuffle earlier. Resolving every gear lot completely before touching any
  // stone lot means a person is only ever excluded from stones by a gear win they
  // actually got, never the other way around.
  drawGroup(gearItems);
  drawGroup(stoneItems, (_itemId, telegramId, category) => {
    if (categoryGroup(category) === 'stone_remelt') remeltWinners.push(telegramId);
  });

  for (const telegramId of remeltWinners) {
    grantTemperBundle(telegramId);
  }

  grantEmptyHandedGuarantee();

  // Last resort (alliance request, 2026-09-10): stone lots that stayed free after
  // everything above — nobody eligible left to claim them, or nobody claimed them at all
  // — go to whoever walked away with literally nothing (no gear, no stone, not even the
  // bundle) despite having claimed on *some* stone lot themselves, so real stock doesn't
  // sit unused while someone gets nothing. Round-robins 1 unit at a time across every
  // still-empty-handed person (not just from lots they personally claimed — this is a
  // pool-wide backstop, unlike the remelt bundle above) up to 3 each, capped by whatever
  // stock genuinely remains. Deliberately not gated by the normal per-category caps —
  // same reasoning as the bundle: those caps don't apply to a backstop for people the
  // normal caps and draws already left with zero.
  function grantEmptyHandedGuarantee(): void {
    const stoneClaimants = new Set<number>();
    for (const item of stoneItems) {
      for (const c of claimantsFor(item.id)) stoneClaimants.add(c.telegram_id);
    }
    const eligible = shuffle([...stoneClaimants].filter((id) => !wonItemsByPerson.has(id)));
    if (eligible.length === 0) return;

    const availableStoneItems = shuffle(stoneItems);
    const GUARANTEE_CAP = 3;
    const grantedSoFar = new Map<number, number>(eligible.map((id) => [id, 0]));

    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const telegramId of eligible) {
        if (grantedSoFar.get(telegramId)! >= GUARANTEE_CAP) continue;
        const won = wonItemsByPerson.get(telegramId) ?? new Set<number>();
        const pick = availableStoneItems.find((it) => remainingByItem.get(it.id)! > 0 && !won.has(it.id));
        if (!pick) continue;
        award(pick.id, telegramId, categoryGroup(pick.category) === 'stone_temper' ? 'cat:stone_temper' : 'cat:stone_remelt');
        grantedSoFar.set(telegramId, grantedSoFar.get(telegramId)! + 1);
        progressed = true;
      }
    }
  }
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
    // A viewer's device clock can drift from the server's by more than the pre-start
    // countdown window itself (see /start's starts_at) — sent on every response so the
    // client can correct for it instead of comparing starts_at/deadlineAt against its own
    // possibly-wrong Date.now().
    const serverNow = new Date().toISOString();
    if (!event) return { event: null, items: [], serverNow };

    const userId = request.telegramUser!.telegramId;
    const items = deps.db
      .prepare(
        `SELECT ${ITEM_COLUMNS},
                EXISTS(SELECT 1 FROM claims c WHERE c.item_id = i.id AND c.telegram_id = ?) as claimedByMe
         FROM items i
         JOIN screenshots s ON s.id = i.screenshot_id
         WHERE i.event_id = ? AND i.status != 'removed'
         ORDER BY ${COLOR_ORDER_SQL}, i.id`
      )
      .all(userId, event.id) as { id: number }[];

    return {
      event: { id: event.id, title: event.title, deadlineAt: event.deadline_at, startsAt: event.starts_at, status: event.status },
      items: attachWinners(deps, items),
      serverNow,
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
         JOIN screenshots s ON s.id = i.screenshot_id
         WHERE i.event_id = ? AND i.status != 'removed'
         ORDER BY ${COLOR_ORDER_SQL}, i.id`
      )
      .all(eventId) as { id: number }[];

    return {
      event: { id: event.id, title: event.title, deadlineAt: event.deadline_at, startsAt: event.starts_at, status: event.status },
      items: attachWinners(deps, items),
    };
  });

  // Per-person view of the same data attachWinners already exposes per-item — everyone
  // who entered this event at all (whether or not they ended up winning anything),
  // alphabetically by nickname, with whatever they won attached. Invasion claims are wins
  // by construction (see attachWinners); feast claims are just entries, so a person shows
  // up here with an empty `won` list until the draw in POST /events/:id/finish actually
  // hands them something.
  app.get<{ Params: { id: string } }>('/events/:id/results', async (request, reply) => {
    const eventId = Number(request.params.id);
    const event = deps.db.prepare('SELECT id FROM events WHERE id = ?').get(eventId);
    if (!event) {
      reply.code(404).send({ error: 'event not found' });
      return;
    }

    const participants = deps.db
      .prepare(
        `SELECT DISTINCT u.telegram_id as telegramId, u.game_nickname as nickname
         FROM claims c
         JOIN items i ON i.id = c.item_id
         JOIN users u ON u.telegram_id = c.telegram_id
         WHERE i.event_id = ?`
      )
      .all(eventId) as { telegramId: number; nickname: string | null }[];

    const invasionWon = deps.db
      .prepare(
        `SELECT c.telegram_id as telegramId, i.name as name, i.color as color, i.image_path as imagePath, c.quantity as quantity
         FROM claims c
         JOIN items i ON i.id = c.item_id
         JOIN screenshots s ON s.id = i.screenshot_id
         WHERE i.event_id = ? AND s.template = 'invasion'`
      )
      .all(eventId) as { telegramId: number; name: string; color: string; imagePath: string; quantity: number }[];

    const feastWon = deps.db
      .prepare(
        `SELECT w.telegram_id as telegramId, i.name as name, i.color as color, i.image_path as imagePath
         FROM item_winners w
         JOIN items i ON i.id = w.item_id
         JOIN screenshots s ON s.id = i.screenshot_id
         WHERE i.event_id = ? AND s.template != 'invasion'`
      )
      .all(eventId) as { telegramId: number; name: string; color: string; imagePath: string }[];

    interface Won {
      name: string;
      color: string;
      imagePath: string;
      quantity: number;
    }
    const wonByPerson = new Map<number, Won[]>();
    for (const row of invasionWon) {
      const list = wonByPerson.get(row.telegramId) ?? [];
      list.push({ name: row.name, color: row.color, imagePath: row.imagePath, quantity: row.quantity });
      wonByPerson.set(row.telegramId, list);
    }
    for (const row of feastWon) {
      const list = wonByPerson.get(row.telegramId) ?? [];
      list.push({ name: row.name, color: row.color, imagePath: row.imagePath, quantity: 1 });
      wonByPerson.set(row.telegramId, list);
    }

    // Shuffled rather than alphabetical (2026-09-10, by request) — a fresh random order
    // on every fetch, not just once per draw, so nobody's position here is meaningful.
    const results = shuffle(participants.map((p) => ({ telegramId: p.telegramId, nickname: p.nickname, won: wonByPerson.get(p.telegramId) ?? [] })));

    return { results };
  });

  app.post<{ Params: { id: string }; Body: { durationMinutes?: number } }>(
    '/events/:id/start',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const eventId = Number(request.params.id);
      const event = deps.db.prepare('SELECT status FROM events WHERE id = ?').get(eventId) as { status: string } | undefined;
      if (!event) {
        reply.code(404).send({ error: 'event not found' });
        return;
      }

      const durationMinutes = request.body?.durationMinutes;
      if (!Number.isFinite(durationMinutes) || (durationMinutes as number) <= 0) {
        reply.code(400).send({ error: 'durationMinutes must be a positive number' });
        return;
      }
      if (event.status !== 'draft') {
        reply.code(409).send({ error: 'event has already started' });
        return;
      }

      // A short synchronized countdown before bidding actually opens — every participant
      // sees the same "starts in N..." and the lot list reveals for everyone at once,
      // instead of whoever happened to refresh first getting a head start on claiming.
      // The announced duration counts from starts_at, not from this click, so it isn't
      // quietly shortened by the countdown.
      const startsAt = new Date(Date.now() + START_DELAY_MS).toISOString();
      const deadlineAt = new Date(Date.parse(startsAt) + (durationMinutes as number) * 60_000).toISOString();
      deps.db.prepare("UPDATE events SET status = 'open', starts_at = ?, deadline_at = ? WHERE id = ?").run(startsAt, deadlineAt, eventId);
      publishChange();
      return { ok: true, startsAt, deadlineAt };
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
      deps.db.transaction(() => {
        drawWinners(deps, eventId);
        deps.db.prepare("UPDATE events SET status = 'resolved', deadline_at = ? WHERE id = ?").run(deadlineAt, eventId);
      })();
      publishChange();
      return { ok: true };
    }
  );
}
