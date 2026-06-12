# Contributing to Hunny

Thanks for your interest in contributing. This is a hobby project so response
times may vary, but all contributions are welcome.

## Getting Started

### Prerequisites

- Node.js 20+
- A Discord bot application for testing (see
  [documentation/setup-bot.md](documentation/setup-bot.md))

### Setup

```bash
git clone https://github.com/hardtokidnap/HUNNY.git
cd HUNNY
npm install
cp .env.example .env        # paste your test bot's token
```

### Development

```bash
node --env-file=.env src/index.js    # run against your test server
node --check src/index.js            # quick syntax check
```

There is no build step. What you write is what runs.

## Project Layout

```
src/
  index.js              # Entry: client, /setup command, anchor flow, ban handler
  log.js                # Guild-aware logging helpers (gInfo/gWarn/gError)
  store.js              # Storage backend selector (Postgres if DATABASE_URL, else SQLite)
  stores/
    sqlite.js           # better-sqlite3 backend
    postgres.js         # pg backend (same interface as sqlite.js)
deploy/
  install-pi.sh         # One-shot Raspberry Pi / Linux systemd installer
  discord-honeypot.service  # Hardened systemd unit
documentation/          # Setup guides, Terms of Service, Privacy Policy
```

## How to Contribute

### Reporting Bugs

Open an issue with:

- What you did
- What you expected
- What happened instead
- Relevant log lines (the bot logs every action and failure to stdout with
  guild, action, and reason)

### Submitting Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `node --check` on every file you touched
4. Test against a real Discord server with a throwaway bot application
5. Open a PR against `main`

### Conventions

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/),
  `feat:`, `fix:`, `chore:`, `docs:`, etc. Keep messages short.
- **Comments:** Explain *why*, not *what*. The code should be readable on its
  own.
- **JavaScript:** Plain CommonJS, `'use strict'`, no TypeScript, no
  transpiler, no framework. async/await over promise chains.
- **Error handling:** Event handlers must never throw to the process. Wrap
  Discord API calls in try/catch when a failure must not kill the handler,
  log it, and continue.
- **Storage:** `src/stores/sqlite.js` and `src/stores/postgres.js` expose the
  same interface. Any schema or method change lands in both files in the same
  PR. Parameterized queries only.

### What's Useful

- Bug reports with reproduction steps
- Edge cases in the ban flow (permissions, role hierarchy, partials)
- Memory and reliability improvements for small hardware (Raspberry Pi)
- Documentation fixes and setup guides for other hosts

### AI-Assisted / Vibe Coding

AI-assisted contributions are welcome; how you write the code is your
business. But you're responsible for what you submit. Every PR is reviewed
the same way regardless of how it was written. If the code is clean, correct,
and well-structured, it gets in. If it's not, it doesn't.

If you're using AI tools, treat their output as a first draft, not a finished
product. Read every line, test every path, and be ready to explain any
decision in your code. If you can't explain why something is there, remove it.

We won't accept:

- Code that degrades the bot's reliability or memory footprint
- Unreviewed AI output dumped into a PR
- Changes outside the scope of this bot (it is a honeypot moderation bot, not
  a full moderation suite)

### Please Don't

- Add dependencies without discussion first (the entire tree is discord.js,
  better-sqlite3, and pg, and it stays minimal. RAM footprint must **NOT** exceed 200mb when running idle)
- Refactor working code without a clear reason
- Add features without opening an issue to discuss scope
- Submit code you haven't tested or don't understand

## Architecture Notes

- **One process, no inbound ports:** the bot is a pure outbound gateway
  client. No web server, no dashboard.
- **Memory stays flat by design:** bounded caches plus sweepers, members
  fetched on demand. Don't introduce anything that bulk-loads members or
  caches message history.
- **State is derived, not stored:** ACTIVE vs awaiting-anchor comes from
  whether `anchor_message_id` is set. Store only what must persist.
- **Logging:** guild-scoped events go through `src/log.js` so every line
  carries the guild name, ID, and failure reason. Process-level events use
  plain `console.*` with a `[tag]` prefix.

## License

By contributing, you agree that your contributions will be licensed under the
project license: [Apache-2.0 with Commons Clause](LICENSE).
