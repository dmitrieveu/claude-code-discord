Explain how to control the bot process (start, stop, restart, check status).

IMPORTANT: The bot may be running active Claude sessions, shell commands, or other tasks for Discord users. Stopping or restarting the bot will interrupt all in-progress work. NEVER stop or restart the bot on your own initiative without confirming with the user first. Only proceed if the user explicitly asked to stop/restart.

Include the following information:

## Commands

All commands go through `bot.sh`, which manages the bot as a background process with PID tracking.

### Via deno tasks

- `deno task start` — start the bot in the background
- `deno task stop` — gracefully stop the bot (SIGTERM, falls back to SIGKILL after 10s)
- `deno task restart` — stop then start
- `deno task status` — check if the bot is running
- `deno task dev` — run in foreground with hot reload (for development only)

### Via bot.sh directly

- `./bot.sh start [args]` — start with optional extra args (e.g. `--category`, `--user-id`)
- `./bot.sh stop` — stop the bot
- `./bot.sh restart [args]` — restart, forwarding extra args
- `./bot.sh status` — check status

## Details

- PID is stored at `.bot-data/bot.pid`
- Logs are appended to `.bot-data/bot.log`
- `bot.sh` detects already-running bot processes even without a PID file (via pgrep fallback), so it works regardless of how the bot was originally started
- The bot handles SIGTERM gracefully via `core/signal-handler.ts`
- To pick up code changes, use `restart` — it does a clean stop + start
