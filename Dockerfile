# Multi-arch friendly (works on x86-64 and arm64 / Raspberry Pi).
# Stays on the active LTS line; Current (odd/new majors) churns too fast for a bot.
FROM node:24-bookworm-slim

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

CMD ["node", "src/index.js"]
