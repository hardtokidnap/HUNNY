# Heroku setup

Prerequisite: [create the Discord bot](./setup-bot.md) first.

## Deploy button

[![Deploy](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/hardtokidnap/HUNNY)

Click the button, set `DISCORD_TOKEN`, and deploy. The included `app.json`
provisions a single worker dyno (no web dyno, since this is a bot rather than a
website) and a Heroku Postgres add-on for persistence, so after deploy make sure
the worker is on:

```bash
heroku ps:scale worker=1 -a <your-app>
```

## Why Postgres

Heroku's filesystem is ephemeral and is wiped on every dyno restart, so SQLite
would not survive there. The `app.json` therefore attaches a Heroku Postgres
add-on, which sets `DATABASE_URL`, and the bot automatically uses Postgres when
that variable is present. Your `/setup` config persists across restarts and
redeploys.

Heroku has no free tier, so the add-on uses the cheapest paid plan
(`essential-0`); change it in `app.json` if you prefer another. If you would
rather host for free with persistence, use [Docker](./setup-docker.md), a
[Raspberry Pi](./setup-raspberry-pi.md), or any VPS.

## Manual deploy

If you deploy manually instead of with the button, provision Postgres yourself:

```bash
heroku addons:create heroku-postgresql:essential-0 -a <your-app>
```

## Surviving restarts and crashes

Nothing to configure: Heroku restarts crashed dynos automatically and cycles
every dyno at least once a day, and the worker comes back on its own each
time. Config survives because it lives in Heroku Postgres, not on the dyno.
The bot only stays down if you scale the worker to 0 yourself.

## Logs

```bash
heroku logs --tail
```
