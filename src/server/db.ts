import Database from 'better-sqlite3';

export type Db = Database.Database;

export function openDb(filePath: string): Db {
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
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
      cols INTEGER NOT NULL,
      uploaded_by INTEGER NOT NULL REFERENCES users(telegram_id),
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY,
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
      id INTEGER PRIMARY KEY,
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
