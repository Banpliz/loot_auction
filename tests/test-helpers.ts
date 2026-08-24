import { createHmac } from 'node:crypto';

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
