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
let recordSnipeStmt;
let setScoreboardEnabledStmt;
let setStatsMessageStmt;
let setTableflipEnabledStmt;

async function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS guilds (
      guild_id            TEXT PRIMARY KEY,
      honeypot_channel_id TEXT NOT NULL,
      setup_user_id       TEXT NOT NULL,
      anchor_message_id   TEXT,
      log_channel_id      TEXT,
      snipe_count         INTEGER NOT NULL DEFAULT 0,
      last_snipe_at       TEXT,
      stats_message_id    TEXT,
      stats_channel_id    TEXT,
      scoreboard_enabled  INTEGER NOT NULL DEFAULT 1,
      tableflip_enabled   INTEGER NOT NULL DEFAULT 1
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

  // Idempotent column adds so databases created by older versions migrate on start.
  const addColumn = (sql) => {
    try {
      db.exec(sql);
      return true;
    } catch (err) {
      if (/duplicate column/i.test(err.message || '')) return false;
      throw err;
    }
  };
  addColumn('ALTER TABLE guilds ADD COLUMN log_channel_id TEXT');
  const snipeColumnAdded = addColumn(
    'ALTER TABLE guilds ADD COLUMN snipe_count INTEGER NOT NULL DEFAULT 0'
  );
  addColumn('ALTER TABLE guilds ADD COLUMN last_snipe_at TEXT');
  addColumn('ALTER TABLE guilds ADD COLUMN stats_message_id TEXT');
  addColumn('ALTER TABLE guilds ADD COLUMN stats_channel_id TEXT');
  addColumn('ALTER TABLE guilds ADD COLUMN scoreboard_enabled INTEGER NOT NULL DEFAULT 1');
  addColumn('ALTER TABLE guilds ADD COLUMN tableflip_enabled INTEGER NOT NULL DEFAULT 1');

  // ban/info is exactly the ban-success log path; seed lifetime counts from it
  // once, riding the snipe_count add so it never re-runs over live counters.
  if (snipeColumnAdded) {
    db.exec(`
      UPDATE guilds SET
        snipe_count = (SELECT COUNT(*) FROM events e
                       WHERE e.guild_id = guilds.guild_id AND e.tag = 'ban' AND e.level = 'info'),
        last_snipe_at = (SELECT MAX(e.created_at) FROM events e
                         WHERE e.guild_id = guilds.guild_id AND e.tag = 'ban' AND e.level = 'info')
    `);
  }

  selectStmt = db.prepare(
    'SELECT guild_id, honeypot_channel_id, setup_user_id, anchor_message_id, log_channel_id, ' +
      'snipe_count, last_snipe_at, stats_message_id, stats_channel_id, scoreboard_enabled, ' +
      'tableflip_enabled FROM guilds WHERE guild_id = ?'
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
    'INSERT INTO events (guild_id, created_at, level, tag, message) VALUES (?, ?, ?, ?, ?)'
  );
  deleteGuildEventsStmt = db.prepare('DELETE FROM events WHERE guild_id = ?');
  pruneEventsStmt = db.prepare('DELETE FROM events WHERE created_at < ?');

  recordSnipeStmt = db.prepare(
    'UPDATE guilds SET snipe_count = snipe_count + 1, last_snipe_at = ? WHERE guild_id = ?'
  );
  setScoreboardEnabledStmt = db.prepare(
    'UPDATE guilds SET scoreboard_enabled = ? WHERE guild_id = ?'
  );
  setStatsMessageStmt = db.prepare(
    'UPDATE guilds SET stats_message_id = ?, stats_channel_id = ? WHERE guild_id = ?'
  );
  setTableflipEnabledStmt = db.prepare(
    'UPDATE guilds SET tableflip_enabled = ? WHERE guild_id = ?'
  );

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
    snipeCount: row.snipe_count,
    lastSnipeAt: row.last_snipe_at,
    statsMessageId: row.stats_message_id,
    statsChannelId: row.stats_channel_id,
    scoreboardEnabled: row.scoreboard_enabled !== 0,
    tableflipEnabled: row.tableflip_enabled !== 0,
  };
}

async function setHoneypot(guildId, channelId, userId, logChannelId = null) {
  upsertHoneypotStmt.run({ guildId, channelId, userId, logChannelId });
}

async function setAnchor(guildId, messageId) {
  setAnchorStmt.run(messageId, guildId);
}

async function recordSnipe(guildId) {
  recordSnipeStmt.run(new Date().toISOString(), guildId);
}

async function setScoreboardEnabled(guildId, enabled) {
  setScoreboardEnabledStmt.run(enabled ? 1 : 0, guildId);
}

async function setStatsMessage(guildId, messageId, channelId = null) {
  setStatsMessageStmt.run(messageId, channelId, guildId);
}

async function setTableflipEnabled(guildId, enabled) {
  setTableflipEnabledStmt.run(enabled ? 1 : 0, guildId);
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

module.exports = {
  init,
  getGuild,
  setHoneypot,
  setAnchor,
  recordSnipe,
  setScoreboardEnabled,
  setStatsMessage,
  setTableflipEnabled,
  deleteGuild,
  logEvent,
  pruneEvents,
  close,
};
