# Loot Auction Mini App

## Local development

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `BOT_TOKEN` (from @BotFather), `ADMIN_TELEGRAM_IDS`, and `MINI_APP_URL`.
3. `npm run dev:server` in one terminal, `npm run dev:web` in another.
4. `npm test` runs the backend unit tests.

## Deploying to a VPS

1. Provision a small VPS with a domain pointed at it.
2. Install Node.js 20+, then `git clone` this repo into `/opt/loot-auction`.
3. `npm install`, `npm run build:web`.
4. Copy `.env.example` to `/opt/loot-auction/.env` and fill in real values, with `MINI_APP_URL` set to `https://your-domain.example`.
5. `certbot --nginx -d your-domain.example` to obtain a TLS certificate.
6. Copy `deploy/nginx.conf.example` to `/etc/nginx/sites-available/loot-auction`, adjust `server_name` and cert paths, symlink into `sites-enabled`, `nginx -t && systemctl reload nginx`.
7. Copy `deploy/loot-auction.service.example` to `/etc/systemd/system/loot-auction.service`, adjust paths/user, then:
   ```bash
   systemctl daemon-reload
   systemctl enable --now loot-auction
   ```
8. In @BotFather, set the bot's Mini App / Menu Button URL to `https://your-domain.example`.
9. Open the bot in Telegram, send `/start`, tap the button — confirms the full stack end to end.
