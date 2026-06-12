# Docker / Compose setup

The easiest persistent option, and the recommended way to run the bot on a
Raspberry Pi 4. The image works on x86-64 and arm64, so the exact same setup
runs on Linux, macOS, and Windows (Docker Desktop), a VPS, a NAS, or the Pi.

Prerequisite: [create the Discord bot](./setup-bot.md) first.

## Install and run

```bash
git clone https://github.com/hardtokidnap/HUNNY.git
cd HUNNY
cp .env.example .env        # then edit .env and paste your token
                            # (on Windows: copy .env.example .env)

sudo usermod -aG docker $USER # If you are not logged in as root
newgrp docker                 # To not have to relog after running command above

docker compose up -d        # build and run in the background
docker compose logs -f      # follow logs
```

## Persistence

The SQLite database lives in a named Docker volume (`honeypot-data`), so it
survives restarts and rebuilds. Back up that volume if losing your `/setup`
config would be annoying.

## Surviving reboots and crashes

The compose file sets `restart: unless-stopped`, so Docker restarts the bot
automatically after a crash and brings it back up when the host reboots. The
one prerequisite is that Docker itself starts on boot:

```bash
# Linux / Raspberry Pi (once):
sudo systemctl enable docker
```

On Docker Desktop (Windows/macOS), enable "Start Docker Desktop when you sign
in" in its settings instead.

The `unless-stopped` policy means the bot keeps coming back until you stop it
yourself; `docker compose stop` keeps it down (also across reboots) until the
next `docker compose up -d` or `docker compose start`.

## Updating

```bash
git pull && docker compose up -d --build
```

## Notes

- The image runs as a non-root user (`USER node`).
- Configuration is environment variables only; see the
  [configuration table](../README.md#configuration).
