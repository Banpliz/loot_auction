// web/telegram.ts
interface TelegramWebApp {
  initData: string;
  ready(): void;
  expand(): void;
}

export function getTelegramWebApp(): TelegramWebApp {
  const webApp = (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
  if (!webApp) throw new Error('Открой это приложение через кнопку в Telegram-боте');
  webApp.ready();
  webApp.expand();
  return webApp;
}
