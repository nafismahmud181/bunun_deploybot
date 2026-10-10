# Bunun deploy bot

A Telegram bot for the Bunun apps on Coolify. It runs in a private chat and only answers the Telegram users listed in `ALLOWED_USER_IDS`.

| Command                                   | What it does                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `/deploy backend\|admin\|storefront\|all` | Pulls the latest `main` from GitHub, builds and starts it, then reports success or failure |
| `/restart <app>`                          | Restarts the running app without rebuilding                                                |
| `/status`                                 | Each app's state and last deploy, plus the API health check                                |
| `/logs <app>`                             | The latest 30 log lines (health checks left out)                                           |

- Leave out the app name to get buttons.
- `all` deploys the backend first. The admin and storefront follow only if the backend succeeds.
- A failed deploy shows the end of its build log.
- Commands sent while the bot was offline are ignored, so an old `/deploy` never fires by surprise.

## How it works

- One Node file and no dependencies.
- It long-polls Telegram for messages, so it needs no domain or open port.
- Port 3000 answers `ok`, only for Coolify's container check.
- It calls the Coolify API with its own token.

## Settings

See `.env.example`:

- `TELEGRAM_BOT_TOKEN`
- `ALLOWED_USER_IDS`
- `COOLIFY_URL`
- `COOLIFY_TOKEN`
- `APPS` and `HEALTH_URL` (optional)

`ALLOWED_USER_IDS` is required: get your ID from @userinfobot in Telegram. Anyone else who messages the bot gets no reply at all.

## Run and test

```sh
npm start   # needs a .env or real environment variables
npm test    # helper tests, no network
```

Run only one copy at a time. Telegram allows a single long-polling connection per bot, so stop the server copy before running it on your PC.
