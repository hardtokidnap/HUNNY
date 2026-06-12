# Manual (Node) setup

For local dev and testing on any OS. Requires Node 18+ (Node 20+ recommended).
Works the same on Linux, macOS, and Windows; `better-sqlite3` ships prebuilt
binaries for all three, so no build toolchain is needed.

Prerequisite: [create the Discord bot](./setup-bot.md) first.

## Install and run

```bash
git clone https://github.com/hardtokidnap/HUNNY.git
cd HUNNY
npm install
cp .env.example .env        # edit and paste your token
                            # (on Windows: copy .env.example .env)

# Load the token from .env (Node 20+, works on every OS):
node --env-file=.env src/index.js
```

Or set the variable in the shell instead of `.env`:

```bash
# Linux / macOS:
export DISCORD_TOKEN="your-bot-token" && npm start

# Windows (PowerShell):
$env:DISCORD_TOKEN = "your-bot-token"; npm start
```

## Persistence

Config is stored in `data/honeypot.db` (override with `DATABASE_PATH`). Back
it up if losing your `/setup` config would be annoying.

## Production note

For anything long-running, use a supervisor that restarts on failure:
[Docker](./setup-docker.md) or [systemd](./setup-raspberry-pi.md), both
provided in this repo.
