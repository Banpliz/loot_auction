import Database from 'better-sqlite3';

export type Db = Database.Database;

export function openDb(filePath: string): Db {
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(db: Db) {
  // ponytail: catalog_items-based schema is incompatible (items.catalog_item_id was required,
  // items had no price/color-as-strings, no screenshots.template). No real production data yet,
  // so reset lots/screenshots instead of a column-by-column rebuild migration. Events/users untouched.
  const existingItemColumns = db.prepare('PRAGMA table_info(items)').all() as { name: string }[];
  if (existingItemColumns.some((c) => c.name === 'catalog_item_id')) {
    db.exec(`
      DROP TABLE IF EXISTS claims;
      DROP TABLE IF EXISTS items;
      DROP TABLE IF EXISTS screenshots;
      DROP TABLE IF EXISTS catalog_items;
      DROP TABLE IF EXISTS settings;
      DROP TABLE IF EXISTS price_tiers;
    `);
  }
  // Same reasoning: items.winner_telegram_id (single winner) can't represent a lot with
  // quantity > 1 (several winners drawn from the same claimant pool) — replaced by the
  // item_winners table below. Still no real production data, so reset again rather than
  // migrate the column.
  if (existingItemColumns.some((c) => c.name === 'winner_telegram_id')) {
    db.exec(`
      DROP TABLE IF EXISTS item_winners;
      DROP TABLE IF EXISTS claims;
      DROP TABLE IF EXISTS items;
      DROP TABLE IF EXISTS screenshots;
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT,
      game_nickname TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      deadline_at TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS screenshots (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id),
      original_path TEXT NOT NULL,
      rows INTEGER NOT NULL,
      template TEXT NOT NULL DEFAULT 'feast',
      uploaded_by INTEGER NOT NULL REFERENCES users(telegram_id),
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id),
      screenshot_id INTEGER NOT NULL REFERENCES screenshots(id),
      name TEXT NOT NULL DEFAULT '',
      price TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT 'blue',
      category TEXT NOT NULL DEFAULT 'item',
      quantity INTEGER NOT NULL DEFAULT 1,
      image_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pool',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      auctioned_at TEXT
    );

    CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES items(id),
      telegram_id INTEGER NOT NULL REFERENCES users(telegram_id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(item_id, telegram_id)
    );

    -- A lot with quantity > 1 draws that many distinct winners from its claimants
    -- (still one bid per person per item, enforced by claims' own UNIQUE) instead
    -- of the single winner_telegram_id this replaced.
    CREATE TABLE IF NOT EXISTS item_winners (
      id INTEGER PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES items(id),
      telegram_id INTEGER NOT NULL REFERENCES users(telegram_id),
      UNIQUE(item_id, telegram_id)
    );
  `);

  // Additive column (feast's per-category win limit, see events.ts) — a plain ALTER
  // instead of the drop+recreate above, since this one doesn't change any existing
  // column's meaning and there's no reason to lose real lots over it. Runs after the
  // CREATE TABLEs above so a fresh items table (already created with `category` in
  // its schema) is never re-altered.
  const itemColumns = db.prepare('PRAGMA table_info(items)').all() as { name: string }[];
  if (!itemColumns.some((c) => c.name === 'category')) {
    db.exec(`ALTER TABLE items ADD COLUMN category TEXT NOT NULL DEFAULT 'item'`);
  }
}
