import { Telegraf, Markup } from 'telegraf';

export function createBot(botToken: string, miniAppUrl: string) {
  const bot = new Telegraf(botToken);
  bot.start((ctx) =>
    ctx.reply('Открыть аукцион лута', Markup.inlineKeyboard([Markup.button.webApp('Открыть', miniAppUrl)]))
  );
  return bot;
}
