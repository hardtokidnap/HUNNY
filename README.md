# discord-honeypot

A trap channel that auto-bans anyone who posts in it, built to catch compromised
or token-stolen accounts that mass-spam every channel.

![Node](https://img.shields.io/badge/node-%3E%3D18-green)
![discord.js](https://img.shields.io/badge/discord.js-v14-blue)
![Storage](https://img.shields.io/badge/storage-SQLite%20%7C%20Postgres-003B57)
![License](https://img.shields.io/badge/license-Apache--2.0-lightgrey)

You designate one honeypot channel. Any non-staff member who posts in it is
deleted and banned on the spot, with 7 days of their messages purged
server-wide in a single call. Hijacked accounts that blast every channel usually
hit the trap first, so this stops them before they finish.

- Zero-config in code. Everything is set up live via a `/setup` slash command.
- Per-guild, so it works across many servers independently.
- Persistent. Config survives restarts (SQLite by default, or PostgreSQL).
- Tiny RAM footprint. Idles around 80 to 150 MB and stays flat even on very
  large servers, because members are fetched on demand and caches are bounded
  with sweepers (it never loads the full member list).
- Cross-platform. Runs anywhere Node 18+ or Docker runs: Linux, macOS, and
  Windows, on x86-64 and arm64 (including a Raspberry Pi).
- Safe. Ignores staff and the pinned notice, and never crashes on a failed ban.

## How it works

1. Run `/setup` (server owner and Administrators only) and pick a text channel.
   The bot replies privately with the exact permissions it needs and a
   role-hierarchy warning.
2. You post one message in that channel. The bot pins it as the permanent warning
   notice (the "anchor"), stores its ID, and flips the honeypot to ACTIVE. The
   anchor is never deleted and never triggers a ban.
3. From then on, anyone who posts there is deleted and banned, except for bots,
   the server owner, anyone with Administrator, and the pinned anchor message.

If a target outranks the bot (`member.bannable === false`), the ban is skipped
and a warning is logged instead of crashing. The bot logs everything to standard
output and standard error (it has no log files of its own), so you read them
wherever your host collects them: `journalctl -u discord-honeypot -f` for
systemd, `docker compose logs -f` for Docker, or `heroku logs --tail` for Heroku.

## 1. Create the Discord bot (required for every deploy method)

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications),
   choose New Application, open the Bot tab, and copy the token.
2. Under Bot then Privileged Gateway Intents, enable Server Members Intent and
   Message Content Intent.
3. Invite the bot using OAuth2 then URL Generator: scope `bot` plus
   `applications.commands`, with permissions Ban Members, Manage Messages, View
   Channel, and Read Message History.
4. In Server Settings then Roles, drag the bot's role above the roles of anyone
   it should be able to ban. Bans against higher-or-equal roles silently fail,
   which is the most common reason people think the bot is not working.

## 2. Deploy

| Method | Best for | Persistent config? |
| --- | --- | --- |
| [Docker / Compose](#docker-recommended) | Anything: Linux, macOS, Windows, VPS, NAS, Raspberry Pi | Yes (volume) |
| [Raspberry Pi / Linux (systemd)](#raspberry-pi--linux-systemd) | Bare-metal Linux without Docker | Yes |
| [Heroku](#heroku) | One-click cloud | Yes (Postgres add-on) |
| [Manual (Node)](#manual-node) | Local dev and testing on any OS | Yes |

Configuration is via environment variables, never hardcoded:

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | Yes | Your bot token from the Developer Portal. |
| `DATABASE_URL` | No | A PostgreSQL connection string. If set, the bot uses Postgres instead of SQLite. The Heroku Postgres add-on sets this for you. |
| `DATABASE_SSL` | No | Force TLS to Postgres `true` or `false`. Defaults to on for remote hosts and off for localhost. |
| `DATABASE_PATH` | No | Path to the SQLite file (ignored when `DATABASE_URL` is set). Defaults to `data/honeypot.db`. |

The bot picks its storage backend at startup: PostgreSQL when `DATABASE_URL` is
present, otherwise the local SQLite file.

### Docker (recommended)

The easiest persistent option, and the recommended way to run the bot on a
Raspberry Pi 4. The image works on x86-64 and arm64, so the exact same setup
runs on Linux, macOS, and Windows (Docker Desktop), a VPS, a NAS, or the Pi.

```bash
git clone https://github.com/hardtokidnap/HUNNY.git
cd HUNNY
cp .env.example .env        # then edit .env and paste your token
                            # (on Windows: copy .env.example .env)

docker compose up -d        # build and run in the background
docker compose logs -f      # follow logs
```

The SQLite database lives in a named Docker volume (`honeypot-data`), so it
survives restarts and rebuilds. To update:

```bash
git pull && docker compose up -d --build
```

### Raspberry Pi / Linux (systemd)

This bot is featherweight and runs comfortably on a Raspberry Pi 4 B, or even a
Zero 2, while pointed at large servers. It does not load the full member list
into memory; members are fetched on demand only when someone posts in the
honeypot, and caches are bounded with sweepers so memory stays flat over long
uptimes.

On a Pi, [Docker](#docker-recommended) is the recommended setup. If you would
rather run bare-metal under systemd, there is a one-shot installer (installs
Node 20 if missing, dependencies, `.env`, and a hardened systemd service that
starts on boot and restarts on failure):

```bash
git clone https://github.com/hardtokidnap/HUNNY.git
cd HUNNY
./deploy/install-pi.sh      # prompts for your token
```

Then:

```bash
systemctl status discord-honeypot
journalctl -u discord-honeypot -f
```

<details>
<summary>Manual systemd setup (if you prefer)</summary>

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

npm ci --omit=dev
cp .env.example .env        # edit and paste your token

# Edit deploy/discord-honeypot.service so User=, WorkingDirectory=,
# EnvironmentFile=, ReadWritePaths= and ExecStart= (check `which node`) match
# your setup.
sudo cp deploy/discord-honeypot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now discord-honeypot
```
</details>

### Heroku

[![Deploy](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/hardtokidnap/HUNNY)

Click the button, set `DISCORD_TOKEN`, and deploy. The included `app.json`
provisions a single worker dyno (no web dyno, since this is a bot rather than a
website) and a Heroku Postgres add-on for persistence, so after deploy make sure
the worker is on:

```bash
heroku ps:scale worker=1 -a <your-app>
```

Persistence: Heroku's filesystem is ephemeral and is wiped on every dyno restart,
so SQLite would not survive there. The `app.json` therefore attaches a Heroku
Postgres add-on, which sets `DATABASE_URL`, and the bot automatically uses
Postgres when that variable is present. Your `/setup` config persists across
restarts and redeploys. Heroku has no free tier, so the add-on uses the cheapest
paid plan (`essential-0`); change it in `app.json` if you prefer another. If you
would rather host for free with persistence, use Docker, a Raspberry Pi, or any
VPS.

If you deploy manually instead of with the button, provision Postgres yourself:

```bash
heroku addons:create heroku-postgresql:essential-0 -a <your-app>
```

### Manual (Node)

Requires Node 18+ (Node 20+ recommended). Works the same on Linux, macOS, and
Windows; `better-sqlite3` ships prebuilt binaries for all three, so no build
toolchain is needed.

```bash
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

`/setup` is registered as a guild command on `ready` and on `guildCreate`, so it
appears instantly in every server the bot joins.

## 3. Usage

1. Run `/setup` and pick the channel you want to use as the trap.
2. Read the ephemeral reply (required permissions and role-hierarchy warning).
3. Post one message in that channel. The bot pins it and the honeypot goes live.

## Best practices for running the bot

A short checklist for running this (or any) Discord bot safely and reliably.

1. Treat the token as a password. Keep it only in `DISCORD_TOKEN` (via `.env` or
   your host's secret store), never in code or version control. `.env` is
   gitignored and dockerignored here. If it ever leaks, regenerate it in the
   Developer Portal immediately.
2. Request only the intents and permissions you need. This bot uses exactly four
   intents and four permissions, nothing more.
3. Keep the bot's role above the roles it must ban, or bans silently fail.
4. Run it as a non-root user. The Docker image and the systemd unit both drop
   privileges by default.
5. Run it under a supervisor that restarts on failure (systemd or
   `docker compose` with `restart: unless-stopped`, both provided here) so a
   transient crash does not take the bot offline.
6. Keep dependencies patched. Run `npm audit` periodically and rebuild.
7. Watch the logs (`journalctl -u discord-honeypot -f` or `docker compose logs
   -f`) so failed bans (for example, a target outranking the bot) are visible.
8. Back up the small SQLite database if losing your `/setup` config would be
   annoying. On Docker it is the `honeypot-data` volume; otherwise it is
   `data/honeypot.db`.

## Security and hardening

This bot opens no inbound ports. It is a pure outbound client: it dials Discord's
gateway over an outbound WebSocket and never listens on the network, so nothing
on the internet can connect to it. The things to protect are the bot token and
the host it runs on.

- The Docker image runs as a non-root user (`USER node`), and Docker's
  namespaces isolate the process from the host by default.
- The provided systemd unit and `install-pi.sh` ship with strong sandboxing
  already applied (`ProtectSystem=strict`, dropped capabilities, a syscall
  filter, read-only home except the data dir, and more), so a compromised
  process is heavily contained. Either Docker or the hardened unit is fine for
  an outbound-only bot.
- The unit also includes a commented-out `IPAddressDeny` line that blocks the
  bot from reaching private and LAN address ranges, so a compromised process
  cannot pivot to other devices on your network, while still allowing Discord
  on public IPs. Enable it only if your DNS resolver is on localhost
  (127.0.0.1); if your DNS is a LAN address (for example your router), that
  line would block DNS and the bot could not connect. See the comments in
  [`deploy/discord-honeypot.service`](./deploy/discord-honeypot.service).
- Protect the token: keep `.env` at `chmod 600` (the installer does this) and
  regenerate the token in the Developer Portal immediately if it ever leaks.

## Storage

Config is stored per guild. The bot uses a local SQLite file by default
(`data/honeypot.db`), or PostgreSQL when `DATABASE_URL` is set (for hosts with an
ephemeral filesystem, such as Heroku). Both backends use the same single table
and store only what must persist:

| Column | Purpose |
| --- | --- |
| `guild_id` | The server (primary key). |
| `honeypot_channel_id` | The trap channel. |
| `setup_user_id` | Who ran `/setup`, used to validate the anchor author across restarts. |
| `anchor_message_id` | The pinned notice. `NULL` until posted. |

The ACTIVE and awaiting-anchor states are derived from whether an anchor is set,
rather than stored as a separate column, so nothing redundant takes up space.

## Scope

Minimal by design: just the bot process, the `/setup` flow, the ban handler, and
the persistence layer (SQLite or Postgres). No web server, no dashboard, no extra
commands.

## License

[Apache-2.0](./LICENSE)
