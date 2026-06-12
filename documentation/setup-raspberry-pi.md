# Raspberry Pi / Linux (systemd) setup

The bot is featherweight and runs comfortably on a Raspberry Pi 4 B, or even a
Zero 2, while pointed at large servers. It does not load the full member list
into memory; members are fetched on demand only when someone posts in the
honeypot, and caches are bounded with sweepers so memory stays flat over long
uptimes.

Prerequisite: [create the Discord bot](./setup-bot.md) first.

On a Pi, [Docker](./setup-docker.md) is the recommended setup. The
instructions below are for running bare-metal under systemd.

## One-shot installer

Installs Node 20 if missing, dependencies, `.env`, and a hardened systemd
service that starts on boot and restarts on failure:

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

## Manual systemd setup (if you prefer)

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

## Surviving reboots and crashes

Both paths above already cover this: the unit ships `Restart=on-failure` with
a 5 second backoff, and `systemctl enable --now` (run by the installer, and by
you in the manual path) starts the service on every boot. Verify with:

```bash
systemctl is-enabled discord-honeypot   # "enabled" = starts on boot
```

## Hardening notes

The provided unit ships with strong sandboxing already applied
(`ProtectSystem=strict`, dropped capabilities, a syscall filter, read-only
home except the data dir). It also includes a commented-out `IPAddressDeny`
line that blocks the bot from reaching private and LAN address ranges. Enable
it only if your DNS resolver is on localhost (127.0.0.1); if your DNS is a LAN
address (for example your router), that line would block DNS and the bot could
not connect. See the comments in
[`deploy/discord-honeypot.service`](../deploy/discord-honeypot.service).
