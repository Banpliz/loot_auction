// web/api.ts
import { getTelegramWebApp } from './telegram';

export async function apiFetch(path: string, options: RequestInit = {}) {
  const webApp = getTelegramWebApp();
  const headers = new Headers(options.headers);
  headers.set('x-telegram-init-data', webApp.initData);

  const res = await fetch(`/api${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}
