import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/server/db';

describe('openDb', () => {
  it('creates five tables (no settings/catalog tables)', () => {
    const db = openDb(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row: any) => row.name);
    expect(tables).toEqual(['claims', 'events', 'items', 'screenshots', 'users']);
  });

  it('defaults items.color to blue and items.price to empty string', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO events (title, status) VALUES ('E', 'open')").run();
    db.prepare("INSERT INTO users (telegram_id, username) VALUES (1, 'u')").run();
    const screenshotId = db
      .prepare("INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (1, 'p', 1, 1)")
      .run().lastInsertRowid;
    const itemId = db
      .prepare('INSERT INTO items (event_id, screenshot_id, image_path) VALUES (1, ?, ?)')
      .run(screenshotId, 'items/a.png').lastInsertRowid;
    const row = db.prepare('SELECT color, price FROM items WHERE id = ?').get(itemId) as any;
    expect(row.color).toBe('blue');
    expect(row.price).toBe('');
  });

  it('defaults screenshots.template to feast', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO events (title, status) VALUES ('E', 'open')").run();
    db.prepare("INSERT INTO users (telegram_id, username) VALUES (1, 'u')").run();
    const screenshotId = db
      .prepare('INSERT INTO screenshots (event_id, original_path, rows, uploaded_by) VALUES (1, ?, 1, 1)')
      .run('p').lastInsertRowid;
    const row = db.prepare('SELECT template FROM screenshots WHERE id = ?').get(screenshotId) as any;
    expect(row.template).toBe('feast');
  });

  describe('pre-screenshot-list schema reset', () => {
    let dbPath: string;

    afterEach(() => {
      fs.rmSync(dbPath, { force: true });
    });

    it('resets items/claims/screenshots when it finds the old catalog_item_id-based schema, keeping events', () => {
      dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'db-migrate-')), 'app.db');

      const db = openDb(dbPath);
      db.exec('DROP TABLE items;');
      db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, catalog_item_id INTEGER NOT NULL);');
      db.prepare("INSERT INTO events (title) VALUES ('Старый ивент')").run();
      db.close();

      const reopened = openDb(dbPath);
      const columns = reopened.prepare('PRAGMA table_info(items)').all() as { name: string }[];
      expect(columns.some((c) => c.name === 'price')).toBe(true);
      expect(columns.some((c) => c.name === 'catalog_item_id')).toBe(false);

      const event = reopened.prepare('SELECT title FROM events').get() as any;
      expect(event.title).toBe('Старый ивент');
      reopened.close();
    });
  });
});
