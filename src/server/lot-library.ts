// src/server/lot-library.ts
import type { Db } from './db';
import { isSameIcon, type IconSignature } from './dedup';

export interface LotLibraryEntry {
  name: string;
  category: string;
}

interface LibraryRow {
  id: number;
  iconSignature: Buffer;
  name: string;
  category: string;
}

function allEntries(db: Db): LibraryRow[] {
  return db
    .prepare('SELECT id, icon_signature as iconSignature, name, category FROM lot_library')
    .all() as LibraryRow[];
}

// Looks up a previously-tagged lot by icon so a newly-uploaded row can be pre-filled
// with its name/category instead of the admin re-tagging the same recurring item
// on every event.
export function findInLibrary(db: Db, signature: IconSignature): LotLibraryEntry | undefined {
  const match = allEntries(db).find((row) => isSameIcon(row.iconSignature, signature));
  return match ? { name: match.name, category: match.category } : undefined;
}

// Remembers (or updates) what this icon is, keyed by icon signature rather than event —
// a real item's icon looks the same wherever it drops.
export function rememberLot(db: Db, signature: IconSignature, name: string, category: string): void {
  const match = allEntries(db).find((row) => isSameIcon(row.iconSignature, signature));
  if (match) {
    db.prepare("UPDATE lot_library SET name = ?, category = ?, updated_at = datetime('now') WHERE id = ?").run(
      name,
      category,
      match.id
    );
  } else {
    db.prepare('INSERT INTO lot_library (icon_signature, name, category) VALUES (?, ?, ?)').run(
      signature,
      name,
      category
    );
  }
}
