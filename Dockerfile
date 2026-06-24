# Multi-arch friendly (works on x86-64 and arm64 / Raspberry Pi).
# Stays on the active LTS line; Current (odd/new majors) churns too fast for a bot.
FROM node:25-bookworm-slim

# better-sqlite3 ships prebuilt binaries for linux x64/arm64 (glibc), so no
# build toolchain is needed on these platforms.
WORKDIR /app

ENV NODE_ENV=production

# Install production deps first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY src ./src

# Persist the SQLite DB outside the image. Mount a volume here.
ENV DATABASE_PATH=/data/honeypot.db
VOLUME ["/data"]

# Drop root.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

# Liveness: the bot rewrites /data/heartbeat every 30s while the gateway is up.
# Stale > 2 min => unhealthy. Uses node (coreutils may be absent in slim) and
# start-period covers the boot window before the first heartbeat is seeded.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "const fs=require('fs');const f=process.env.HEARTBEAT_FILE||'/data/heartbeat';const t=+fs.readFileSync(f,'utf8');process.exit(Date.now()-t<120000?0:1)" || exit 1

CMD ["node", "src/index.js"]
