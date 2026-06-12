#!/usr/bin/env bash
#
# One-shot installer for running the Discord honeypot bot on a Raspberry Pi
# (or any Debian/Ubuntu Linux) as a systemd service.
#
# It will:
#   1. Install Node 20 LTS (via NodeSource) if node is missing or too old.
#   2. Install production dependencies.
#   3. Create a .env from .env.example if needed and prompt for your token.
#   4. Render + install a systemd unit with the correct user/paths/node binary.
#   5. Enable + start the service.
#
# Usage:
#   cd discord-honeypot
#   ./deploy/install-pi.sh
#
set -euo pipefail

# --- locate the repo (this script lives in deploy/) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_DIR}"

RUN_USER="${SUDO_USER:-$USER}"
SERVICE_NAME="discord-honeypot"

echo "==> Repo:    ${REPO_DIR}"
echo "==> Service will run as user: ${RUN_USER}"

# --- 1. Node 20 LTS ---
need_node=false
if ! command -v node >/dev/null 2>&1; then
  need_node=true
else
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "${major}" -lt 20 ]; then need_node=true; fi
fi

if [ "${need_node}" = true ]; then
  echo "==> Installing Node 20 LTS via NodeSource..."
  # This pipes a NodeSource script into a root shell. It's the official install
  # method, but if you'd rather not curl|bash as root, install Node 20+ yourself
  # beforehand and this step is skipped.
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "==> Node $(node -v) already present, skipping install."
fi

NODE_BIN="$(command -v node)"
echo "==> Using node at ${NODE_BIN}"

# --- 2. Dependencies ---
echo "==> Installing production dependencies..."
npm ci --omit=dev || npm install --omit=dev

# --- 3. .env / token ---
if [ ! -f .env ]; then
  ( umask 077; cp .env.example .env )   # create 0600 BEFORE any secret is written
  echo
  read -rsp "==> Paste your Discord bot token (DISCORD_TOKEN): " token
  echo
  if [ -n "${token}" ]; then
    # Rewrite the token line verbatim. printf %s avoids the sed/shell
    # metacharacter pitfalls of interpolating arbitrary input; umask 077 keeps
    # the temp file private during the swap.
    ( umask 077
      grep -v '^DISCORD_TOKEN=' .env > .env.tmp || true
      printf 'DISCORD_TOKEN=%s\n' "${token}" >> .env.tmp
      mv .env.tmp .env )
    echo "==> Wrote token to .env"
  else
    echo "!! No token entered. Edit ${REPO_DIR}/.env before starting the service."
  fi
else
  echo "==> .env already exists, leaving it untouched."
fi
chmod 600 .env 2>/dev/null || true

# --- 4. Render + install the systemd unit ---
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
echo "==> Installing systemd unit at ${UNIT_PATH}"
sudo tee "${UNIT_PATH}" >/dev/null <<UNIT
[Unit]
Description=Discord honeypot moderation bot
Documentation=https://github.com/hardtokidnap/HUNNY
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${REPO_DIR}
EnvironmentFile=${REPO_DIR}/.env
ExecStart=${NODE_BIN} src/index.js
Restart=on-failure
RestartSec=5

# --- Sandboxing: contain blast radius if the bot were ever compromised ---
# The bot only needs outbound network + write access to its data dir.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${REPO_DIR}/data
ProtectHome=read-only
ProtectProc=invisible
ProtectControlGroups=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
SystemCallFilter=@system-service
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK

# OPTIONAL: block the bot from reaching your home LAN, so a compromised process
# can't pivot to other devices. Discord lives on public IPs, so it keeps working.
# Leave commented if your DNS resolver is on the LAN (e.g. a Pi-hole on another
# box or your router) -- this would block DNS. Safe to enable if DNS is on
# localhost (127.0.0.1). See the README "Security and hardening" section.
#IPAddressDeny=10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 fc00::/7 fe80::/10

[Install]
WantedBy=multi-user.target
UNIT

# --- 5. Enable + start ---
echo "==> Enabling and starting the service..."
sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}"

echo
echo "==> Done. Useful commands:"
echo "      systemctl status ${SERVICE_NAME}"
echo "      journalctl -u ${SERVICE_NAME} -f"
