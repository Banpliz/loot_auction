import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/server/db';

describe('openDb', () => {
  it('creates all six tables', () => {
    const db = openDb(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row: any) => row.name);
    expect(tables).toEqual(['claims', 'events', 'items', 'screenshots', 'settings', 'users']);
  });

  it('seeds a single settings row with a default claim limit', () => {
    const db = openDb(':memory:');
    const row = db.prepare('SELECT max_simultaneous_claims FROM settings WHERE id = 1').get() as any;
    expect(row.max_simultaneous_claims).toBe(5);
  });
});
