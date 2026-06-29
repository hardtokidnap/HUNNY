# Hunny

<img width="680" height="240" alt="Hunnybanner" src="documentation/Hunnybanner.png" />

A [honeypot](https://en.wikipedia.org/wiki/Honeypot_(computing)) bot that auto-bans anyone who posts in a designated channel. Built to catch compromised or token-stolen accounts that mass-spam every channel across public Discord communities.

![Node](https://img.shields.io/badge/node-%3E%3D20-green)
![discord.js](https://img.shields.io/badge/discord.js-v14-blue)
![Storage](https://img.shields.io/badge/storage-SQLite%20%7C%20Postgres-003B57)
![License](https://img.shields.io/badge/license-Apache--2.0%20with%20Commons%20Clause-lightgrey)
![Discord](https://img.shields.io/badge/hosted%20instance-discord%20verified-5865F2?logo=discord&logoColor=white)

[![Invite Hunny](https://img.shields.io/badge/Invite%20Hunny%20to%20your%20server-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.com/oauth2/authorize?client_id=1515012645315678348)
No hosting needed; see [Usage](#usage) for the 3-step setup.

You designate one honeypot channel. Any non-staff member who posts there is deleted and banned on the spot, with 7 days of their messages purged server-wide in one call. Hijacked accounts that spam every channel usually hit the trap first.

- Zero-config in code. Set up live via the `/setup` slash command.
- Per-guild. Works across many servers independently.
- Persistent. Config survives restarts (SQLite by default, or PostgreSQL).
- Flat memory. Idles around 80 to 150 MB even on large servers: members fetched on demand, caches bounded with sweepers, never loads the full member list.
- Cross-platform. Node 20+ or Docker on Linux, macOS, Windows, x86-64 and arm64 (including Raspberry Pi).
- Safe. Ignores staff (Administrator) and the pinned notice, never crashes on a failed ban.

## How it works

1. Run `/setup` (server owner and Administrators only) and pick a text channel. The bot replies privately with the permissions it needs and a role-hierarchy warning.
2. Post one message in that channel. The bot pins it as the permanent warning notice (the "anchor"), stores its ID, and the honeypot goes ACTIVE. The anchor is never deleted and never triggers a ban.
3. After that, anyone who posts there is deleted and banned, except bots, the server owner, anyone with Administrator, and the anchor message.

If a target outranks the bot (`member.bannable === false`), the ban is skipped and logged instead of crashing.

## Self-hosting

Just want the bot in your server? Use the invite button above and skip to [Usage](#usage). The invite adds the maintainer's hosted instance: a Discord-verified app running exactly this repo's code, requesting only the six permissions it needs, with a published [Terms of Service](./documentation/TERMS%20OF%20SERVICE.txt) and [Privacy Policy](./documentation/PRIVACY%20POLICY.txt).

The rest of this page is for hosting your own instance, which runs under your own Discord application; verified status applies only to the hosted instance, not to forks.

First, [create the Discord bot](./documentation/setup-bot.md) (token, intents, invite, role hierarchy). Then pick a hosting method:

| Method | Best for | Persistent config? |
| --- | --- | --- |
| [Docker / Compose](./documentation/setup-docker.md) | Anything: Linux, macOS, Windows, VPS, NAS, Raspberry Pi | Yes (volume) |
| [Raspberry Pi / Linux (systemd)](./documentation/setup-raspberry-pi.md) | Bare-metal Linux without Docker | Yes |
| [Heroku](./documentation/setup-heroku.md) | One-click cloud | Yes (Postgres add-on) |
| [Manual (Node)](./documentation/setup-manual.md) | Local dev and testing on any OS | Yes |

## Configuration

Environment variables only, never hardcoded. The backend is picked at startup, PostgreSQL when `DATABASE_URL` is set, otherwise the local SQLite file.

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | Yes | Your bot token from the Developer Portal. |
| `DATABASE_URL` | No | A PostgreSQL connection string. If set, the bot uses Postgres instead of SQLite. The Heroku Postgres add-on sets this for you. |
| `DATABASE_SSL` | No | Force TLS to Postgres `true` or `false`. Defaults to on for remote hosts and off for localhost. |
| `DATABASE_PATH` | No | Path to the SQLite file (ignored when `DATABASE_URL` is set). Defaults to `data/honeypot.db`. |
| `LOG_RETENTION_DAYS` | No | How many days of per-guild event history to keep. Defaults to 30. |
| `UPDATE_CHECK` | No | Set `false` to stop the daily check for a newer version on GitHub (an `[update]` log line, nothing else). Defaults to on. |

## Usage

1. Run `/setup` and pick the trap channel. Optionally add `log_channel` to post activation and ban notices in a channel of your choice (the bot needs Send Messages there).
2. Read the ephemeral reply (required permissions and role-hierarchy warning).
3. Post one message in that channel. The bot pins it and the honeypot goes live.

`/setup` is a global command, available in every server the bot joins, now or later.

## Logging

Every action and failure is logged to stdout with the server name and ID, what happened, and why it failed:

```
[ban] guild="My Server" (1234567890) banned Spammer#1234 (456), purged 7 days of messages
[ban] guild="My Server" (1234567890) FAIL banning Mod#5678 (789): Missing Permissions (code 50013)
```

No log files of its own; read the stream where your host collects it: `journalctl -u discord-honeypot -f` (systemd), `docker compose logs -f` (Docker), `heroku logs --tail` (Heroku).

A configured `log_channel` also gets human-readable notices (honeypot activated, member banned, ban failed and why), so staff see activity without backend access.

Every guild-scoped event is also written to an `events` table (timestamp, severity, type, description) for per-guild history. Entries expire after `LOG_RETENTION_DAYS` (default 30); pruning runs at startup and daily.

## Security and hardening

- The Docker image runs as non-root (`USER node`); namespaces isolate the process from the host.
- The systemd unit and `install-pi.sh` ship with strong sandboxing (`ProtectSystem=strict`, dropped capabilities, a syscall filter, read-only home except the data dir, and more), so a compromised process is heavily contained. Either Docker or the hardened unit is fine.
- The unit also includes a commented-out `IPAddressDeny` line that blocks private and LAN ranges, so a compromised process cannot pivot to other devices, while still allowing Discord on public IPs. Enable it only if your DNS resolver is on localhost (127.0.0.1); if your DNS is a LAN address (for example your router), that line blocks DNS and the bot cannot connect. See [`deploy/discord-honeypot.service`](./deploy/discord-honeypot.service).
- Keep `.env` at `chmod 600` (the installer does this) and regenerate the token if it leaks.

## Keeping `.env` out of AI coding assistants

AI coding tools (assistants, agents, CLIs) read file contents and often upload them to a model provider for context or indexing. Your `.env` holds `DISCORD_TOKEN`, so it can be swept up too. The protection that holds is the same as for git: never commit a real `.env` (commit `.env.example` instead) and keep it at `chmod 600`. On top of that, tell each assistant to skip it. Coverage differs by tool, so treat the table as defense in depth, not a guarantee.

| Tool | How to exclude `.env` | Notes |
| --- | --- | --- |
| Claude Code | Add a deny rule to `.claude/settings.json`: `"permissions": { "deny": ["Read(.env)", "Read(**/.env)"] }` | Enforced by the harness, not the model. A `.claudeignore` file is **not** officially supported and does not reliably block reads. |
| Cursor | `.cursorignore` in the repo root (gitignore syntax) | Blocks AI access, indexing, and `@`-mentions. `.cursorindexingignore` only skips indexing; the file stays readable. |
| JetBrains AI Assistant / Junie | `.aiignore` in the repo root; enable under Settings > Tools > AI Assistant | "Brave mode" bypasses it. Protects contents, not file names. |
| Gemini Code Assist | `.aiexclude` in the repo root (gitignore syntax) | Takes precedence over `.gitignore`. |
| Gemini CLI | `.geminiignore` in the repo root | Restart the CLI session after editing. |
| OpenAI Codex CLI | No reliable ignore file as of 2026 (`.codexignore` is not respected) | Make `.env` unreadable to the process at the OS level instead. |

A gitignored, `chmod 600`, never-committed `.env` protects the token. The per-tool entries reduce accidental indexing on top of that.

## Storage

Config is stored per guild: a local SQLite file by default (`data/honeypot.db`), or PostgreSQL when `DATABASE_URL` is set (for ephemeral-filesystem hosts like Heroku). Both backends use the same two tables. `guilds`:

| Column | Purpose |
| --- | --- |
| `guild_id` | The server (primary key). |
| `honeypot_channel_id` | The trap channel. |
| `setup_user_id` | Who ran `/setup`, used to validate the anchor author across restarts. |
| `anchor_message_id` | The pinned notice. `NULL` until posted. |
| `log_channel_id` | Where in-guild notices go. `NULL` when not configured. |

ACTIVE vs awaiting-anchor is derived from whether an anchor is set, not stored as a separate column.

`events` holds the per-guild action/failure history from [Logging](#logging) (`guild_id`, `created_at`, `level`, `tag`, `message`), auto-pruned after `LOG_RETENTION_DAYS` and deleted along with the config row when the bot leaves a server.

## Scope

Minimal by design: the bot process, the `/setup` flow, the ban handler, and the persistence layer (SQLite or Postgres). No web server, no dashboard, no extra commands.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Terms and privacy

- [Terms of Service](./documentation/TERMS%20OF%20SERVICE.txt)
- [Privacy Policy](./documentation/PRIVACY%20POLICY.txt)

## License

[Apache-2.0 with Commons Clause](./LICENSE). Fork it, modify it, self-host it, keep the attribution and change notices Apache requires, but you may not sell the software or charge for hosting, support, or any product whose value comes substantially from it.
