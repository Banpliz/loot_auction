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
      image_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pool',
      winner_telegram_id INTEGER REFERENCES users(telegram_id),
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
  `);
}
