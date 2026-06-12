'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// DATABASE_PATH lets the file point at a Docker volume or a mounted disk;
// otherwise it lives next to the repo so a plain checkout just works.
const DB_FILE = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, '..', '..', 'data', 'honeypot.db');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new Database(DB_FILE);
// WAL keeps reads non-blocking and survives crashes; NORMAL synchronous is safe
// under WAL and cuts SD-card wear on a Raspberry Pi.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

let selectStmt;
let upsertHoneypotStmt;
let setAnchorStmt;
let deleteGuildStmt;
let insertEventStmt;
let deleteGuildEventsStmt;
let pruneEventsStmt;

async function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS guilds (
      guild_id            TEXT PRIMARY KEY,
      honeypot_channel_id TEXT NOT NULL,
      setup_user_id       TEXT NOT NULL,
      anchor_message_id   TEXT,
      log_channel_id      TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY,
      guild_id   TEXT NOT NULL,
      created_at TEXT NOT NULL,
      level      TEXT NOT NULL,
      tag        TEXT NOT NULL,
      message    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_guild_time ON events (guild_id, created_at);
  `);

  // Idempotent column add for databases created before in-guild logging existed.
  try {
    db.exec('ALTER TABLE guilds ADD COLUMN log_channel_id TEXT');
  } catch (err) {
    if (!/duplicate column/i.test(err.message || '')) throw err;
  }

  selectStmt = db.prepare(
    'SELECT guild_id, honeypot_channel_id, setup_user_id, anchor_message_id, log_channel_id FROM guilds WHERE guild_id = ?',
  );

  // Re-designating a channel resets the anchor to NULL, which returns the guild
  // to the awaiting-anchor state.
  upsertHoneypotStmt = db.prepare(`
    INSERT INTO guilds (guild_id, honeypot_channel_id, setup_user_id, anchor_message_id, log_channel_id)
    VALUES (@guildId, @channelId, @userId, NULL, @logChannelId)
    ON CONFLICT(guild_id) DO UPDATE SET
      honeypot_channel_id = excluded.honeypot_channel_id,
      setup_user_id       = excluded.setup_user_id,
      anchor_message_id   = NULL,
      log_channel_id      = excluded.log_channel_id
  `);

  setAnchorStmt = db.prepare('UPDATE guilds SET anchor_message_id = ? WHERE guild_id = ?');

  deleteGuildStmt = db.prepare('DELETE FROM guilds WHERE guild_id = ?');

  insertEventStmt = db.prepare(
    'INSERT INTO events (guild_id, created_at, level, tag, message) VALUES (?, ?, ?, ?, ?)',
  );
  deleteGuildEventsStmt = db.prepare('DELETE FROM events WHERE guild_id = ?');
  pruneEventsStmt = db.prepare('DELETE FROM events WHERE created_at < ?');

  console.log(`[store] Using SQLite at ${DB_FILE}`);
}

async function getGuild(guildId) {
  const row = selectStmt.get(guildId);
  if (!row) return null;
  const anchorMessageId = row.anchor_message_id;
  return {
    guildId: row.guild_id,
    honeypotChannelId: row.honeypot_channel_id,
    setupUserId: row.setup_user_id,
    anchorMessageId,
    logChannelId: row.log_channel_id,
    awaitingAnchor: anchorMessageId == null,
    active: anchorMessageId != null,
  };
}

async function setHoneypot(guildId, channelId, userId, logChannelId = null) {
  upsertHoneypotStmt.run({ guildId, channelId, userId, logChannelId });
}

async function setAnchor(guildId, messageId) {
  setAnchorStmt.run(messageId, guildId);
}

async function deleteGuild(guildId) {
  // Events go with the config row: the privacy policy promises a kicked bot
  // leaves nothing behind for that server.
  deleteGuildEventsStmt.run(guildId);
  deleteGuildStmt.run(guildId);
}

async function logEvent(guildId, level, tag, message) {
  insertEventStmt.run(guildId, new Date().toISOString(), level, tag, message);
}

async function pruneEvents(retentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  const { changes } = pruneEventsStmt.run(cutoff);
  return changes;
}

async function close() {
  // Checkpoints the WAL and releases the file lock.
  db.close();
}

module.exports = { init, getGuild, setHoneypot, setAnchor, deleteGuild, logEvent, pruneEvents, close };
