# Hunny

A trap channel that auto-bans anyone who posts in it, built to catch compromised
or token-stolen accounts that mass-spam every channel.

![Node](https://img.shields.io/badge/node-%3E%3D18-green)
![discord.js](https://img.shields.io/badge/discord.js-v14-blue)
![Storage](https://img.shields.io/badge/storage-SQLite%20%7C%20Postgres-003B57)
![License](https://img.shields.io/badge/license-Apache--2.0%20with%20Commons%20Clause-lightgrey)

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
and a warning is logged instead of crashing.

## Just want the bot in your server?

Use the invite link (coming soon) and skip straight to [Usage](#usage). The
rest of this page is for people hosting their own instance.

## Setup

First, [create the Discord bot](./documentation/setup-bot.md) (token, intents,
invite, role hierarchy). Then pick a hosting method:

| Method | Best for | Persistent config? |
| --- | --- | --- |
| [Docker / Compose](./documentation/setup-docker.md) | Anything: Linux, macOS, Windows, VPS, NAS, Raspberry Pi | Yes (volume) |
| [Raspberry Pi / Linux (systemd)](./documentation/setup-raspberry-pi.md) | Bare-metal Linux without Docker | Yes |
| [Heroku](./documentation/setup-heroku.md) | One-click cloud | Yes (Postgres add-on) |
| [Manual (Node)](./documentation/setup-manual.md) | Local dev and testing on any OS | Yes |

## Configuration

Environment variables only, never hardcoded:

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | Yes | Your bot token from the Developer Portal. |
| `DATABASE_URL` | No | A PostgreSQL connection string. If set, the bot uses Postgres instead of SQLite. The Heroku Postgres add-on sets this for you. |
| `DATABASE_SSL` | No | Force TLS to Postgres `true` or `false`. Defaults to on for remote hosts and off for localhost. |
| `DATABASE_PATH` | No | Path to the SQLite file (ignored when `DATABASE_URL` is set). Defaults to `data/honeypot.db`. |
| `LOG_RETENTION_DAYS` | No | How many days of per-guild event history to keep in the database. Defaults to 30. |
| `UPDATE_CHECK` | No | Set `false` to stop the daily check for a newer version on GitHub (an `[update]` log line, nothing else). Defaults to on. |

The bot picks its storage backend at startup: PostgreSQL when `DATABASE_URL` is
present, otherwise the local SQLite file.

## Usage

1. Run `/setup` and pick the channel you want to use as the trap. Optionally
   add `log_channel` to get activation and ban notices posted in a channel of
   your choice (the bot needs Send Messages there).
2. Read the ephemeral reply (required permissions and role-hierarchy warning).
3. Post one message in that channel. The bot pins it and the honeypot goes live.

`/setup` is registered as a guild command on `ready` and on `guildCreate`, so it
appears instantly in every server the bot joins.

## Logging

Every action and failure is logged to standard output with the server's name
and ID, what happened, and why it failed when it did:

```
[ban] guild="My Server" (1234567890) banned Spammer#1234 (456), purged 7 days of messages
[ban] guild="My Server" (1234567890) FAIL banning Mod#5678 (789): Missing Permissions (code 50013)
```

The bot has no log files of its own; read the stream wherever your host
collects it: `journalctl -u discord-honeypot -f` for systemd,
`docker compose logs -f` for Docker, or `heroku logs --tail` for Heroku.

If you set a `log_channel` during `/setup`, the bot also posts human-readable
notices (honeypot activated, member banned, ban failed and why) in that
channel, so server staff see activity without backend access.

Every guild-scoped event is also written to an `events` table in the database
(timestamp, severity, event type, description), so the operator can query
history per guild instead of parsing text logs. Entries expire after
`LOG_RETENTION_DAYS` (default 30); pruning runs at startup and daily.

## Best practices for running the bot

A short checklist for running this (or any) Discord bot safely and reliably.

1. Treat the token as a password. Keep it only in `DISCORD_TOKEN` (via `.env` or
   your host's secret store), never in code or version control. `.env` is
   gitignored and dockerignored here. If it ever leaks, regenerate it in the
   Developer Portal immediately.
2. Request only the intents and permissions you need. This bot uses exactly four
   intents and four permissions (plus Send Messages in the log channel, only if
   you configure one), nothing more.
3. Keep the bot's role above the roles it must ban, or bans silently fail.
4. Run it as a non-root user. The Docker image and the systemd unit both drop
   privileges by default.
5. Run it under a supervisor that restarts on failure (systemd or
   `docker compose` with `restart: unless-stopped`, both provided here) so a
   transient crash does not take the bot offline.
6. Keep dependencies patched. Run `npm audit` periodically and rebuild. The bot
   checks GitHub daily and logs an `[update]` line when a newer version exists
   (it never updates itself); update with `git pull && docker compose up -d
   --build`.
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
ephemeral filesystem, such as Heroku). Both backends use the same two tables
and store only what must persist. `guilds`:

| Column | Purpose |
| --- | --- |
| `guild_id` | The server (primary key). |
| `honeypot_channel_id` | The trap channel. |
| `setup_user_id` | Who ran `/setup`, used to validate the anchor author across restarts. |
| `anchor_message_id` | The pinned notice. `NULL` until posted. |
| `log_channel_id` | Where in-guild notices go. `NULL` when not configured. |

The ACTIVE and awaiting-anchor states are derived from whether an anchor is set,
rather than stored as a separate column, so nothing redundant takes up space.

`events` holds the per-guild action/failure history described in
[Logging](#logging) (`guild_id`, `created_at`, `level`, `tag`, `message`),
auto-pruned after `LOG_RETENTION_DAYS` and deleted along with the config row
when the bot leaves a server.

## Scope

Minimal by design: just the bot process, the `/setup` flow, the ban handler, and
the persistence layer (SQLite or Postgres). No web server, no dashboard, no extra
commands.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Terms and privacy

- [Terms of Service](./documentation/TERMS%20OF%20SERVICE.txt)
- [Privacy Policy](./documentation/PRIVACY%20POLICY.txt)

## License

[Apache-2.0 with Commons Clause](./LICENSE). In short: fork it, modify it,
self-host it, keep the attribution and change notices Apache requires, but you
may not sell the software or charge for hosting, support, or any product whose
value comes substantially from it.
