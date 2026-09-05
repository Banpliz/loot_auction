import { createHmac } from 'node:crypto';
import type { Db } from '../src/server/db';

// Non-admin test personas hit the access-approval gate (see auth.ts) just like a real
// user would — most route tests care about the behavior *past* that gate, not about it,
// so they pre-approve their personas with this instead of re-deriving the gate everywhere.
export function approveTestUser(db: Db, telegramId: number): void {
  db.prepare(
    `INSERT INTO users (telegram_id, status) VALUES (?, 'approved')
     ON CONFLICT(telegram_id) DO UPDATE SET status = 'approved'`
  ).run(telegramId);
}

export function signInitData(params: Record<string, string>, botToken: string): string {
  const usp = new URLSearchParams(params);
  const dataCheckString = [...usp.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  usp.set('hash', hash);
  return usp.toString();
}

export function signUserInitData(telegramId: number, username: string, botToken: string): string {
  return signInitData({ user: JSON.stringify({ id: telegramId, username }), auth_date: '1700000000' }, botToken);
}
