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

async function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS guilds (
      guild_id            TEXT PRIMARY KEY,
      honeypot_channel_id TEXT NOT NULL,
      setup_user_id       TEXT NOT NULL,
      anchor_message_id   TEXT
    );
  `);

  selectStmt = db.prepare(
    'SELECT guild_id, honeypot_channel_id, setup_user_id, anchor_message_id FROM guilds WHERE guild_id = ?',
  );

  // Re-designating a channel resets the anchor to NULL, which returns the guild
  // to the awaiting-anchor state.
  upsertHoneypotStmt = db.prepare(`
    INSERT INTO guilds (guild_id, honeypot_channel_id, setup_user_id, anchor_message_id)
    VALUES (@guildId, @channelId, @userId, NULL)
    ON CONFLICT(guild_id) DO UPDATE SET
      honeypot_channel_id = excluded.honeypot_channel_id,
      setup_user_id       = excluded.setup_user_id,
      anchor_message_id   = NULL
  `);

  setAnchorStmt = db.prepare('UPDATE guilds SET anchor_message_id = ? WHERE guild_id = ?');

  deleteGuildStmt = db.prepare('DELETE FROM guilds WHERE guild_id = ?');

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
    awaitingAnchor: anchorMessageId == null,
    active: anchorMessageId != null,
  };
}

async function setHoneypot(guildId, channelId, userId) {
  upsertHoneypotStmt.run({ guildId, channelId, userId });
}

async function setAnchor(guildId, messageId) {
  setAnchorStmt.run(messageId, guildId);
}

async function deleteGuild(guildId) {
  deleteGuildStmt.run(guildId);
}

async function close() {
  // Checkpoints the WAL and releases the file lock.
  db.close();
}

module.exports = { init, getGuild, setHoneypot, setAnchor, deleteGuild, close };
