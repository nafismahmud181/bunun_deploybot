# Bunun deploy bot

A Telegram bot for the Bunun apps on Coolify, used from a private chat.

## Signing in

Send `/start`. The bot asks for your admin email, then your password, then your authenticator code.

- The password message is deleted from the chat straight after it is read.
- The store API checks all three like the admin sign-in, with the same 15-minute lock after wrong tries.
- **Only the owner** can sign in.
- You stay signed in until `/logout`. You are also signed out when the account is disabled or isn't the owner any more, or when its password or two-factor setup changes. The API checks this before every command.
- Deploys and restarts are recorded in the admin audit log (`telegram.deploy`, `telegram.restart`).
- `ALLOWED_USER_IDS` is optional: when set, only those Telegram accounts get any reply at all.

| Command                                   | What it does                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `/deploy backend\|admin\|storefront\|all` | Pulls the latest `main` from GitHub, builds and starts it, then reports success or failure |
| `/restart <app>`                          | Restarts the running app without rebuilding                                                |
| `/status`                                 | Each app's state and last deploy, plus the API health check                                |
| `/logs <app>`                             | The latest 30 log lines (health checks left out)                                           |
| `/logout`                                 | Signs this Telegram account out                                                            |

- Leave out the app name to get buttons.
- `all` deploys the backend first. The admin and storefront follow only if the backend succeeds.
- A failed deploy shows the end of its build log.
- Commands sent while the bot was offline are ignored, so an old `/deploy` never fires by surprise.

## How it works

- One Node file and no dependencies.
- It long-polls Telegram for messages, so it needs no domain or open port.
- Port 3000 answers `ok`, only for Coolify's container check.
- It calls the Coolify API with its own token.
- It asks the store API (`/api/v1/bot/*`, with `BOT_API_SECRET`) who is signed in.

## Settings

See `.env.example`:

- `TELEGRAM_BOT_TOKEN`
- `BOT_API_SECRET`: the same value as on the backend
- `COOLIFY_URL`
- `COOLIFY_TOKEN`
- `ALLOWED_USER_IDS`, `API_URL` and `APPS` (optional)

## Run and test

```sh
npm start   # needs a .env or real environment variables
npm test    # helper tests, no network
```

Run only one copy at a time. Telegram allows a single long-polling connection per bot, so stop the server copy before running it on your PC.
