'use strict';

const { Pool } = require('pg');

// Heroku Postgres and most managed providers require TLS, and they terminate it
// with certificates the client can't always verify against a local CA bundle.
// Local servers usually don't use TLS at all. So: TLS on by default (accepting
// the provider cert) but off for localhost, with DATABASE_SSL as an override.
function sslConfig() {
  if (/^(false|0|disable)$/i.test(process.env.DATABASE_SSL || '')) return false;
  const url = process.env.DATABASE_URL || '';
  if (/@(localhost|127\.0\.0\.1)[:/]/.test(url)) return false;
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig(),
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guilds (
      guild_id            text PRIMARY KEY,
      honeypot_channel_id text NOT NULL,
      setup_user_id       text NOT NULL,
      anchor_message_id   text,
      log_channel_id      text,
      snipe_count         integer NOT NULL DEFAULT 0,
      last_snipe_at       text,
      stats_message_id    text,
      stats_channel_id    text,
      scoreboard_enabled  integer NOT NULL DEFAULT 1,
      tableflip_enabled   integer NOT NULL DEFAULT 1
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      guild_id   text NOT NULL,
      created_at text NOT NULL,
      level      text NOT NULL,
      tag        text NOT NULL,
      message    text NOT NULL
    );
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_events_guild_time ON events (guild_id, created_at)'
  );

  // Idempotent column adds so databases created by older versions migrate on start.
  await pool.query('ALTER TABLE guilds ADD COLUMN IF NOT EXISTS log_channel_id text');

  // Absent snipe_count means a pre-scoreboard database, so seed from history once
  // after adding the columns (events already exists above for the backfill to read).
  const { rows: hasSnipe } = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'guilds' AND column_name = 'snipe_count'"
  );
  await pool.query(
    'ALTER TABLE guilds ADD COLUMN IF NOT EXISTS snipe_count integer NOT NULL DEFAULT 0'
  );
  await pool.query('ALTER TABLE guilds ADD COLUMN IF NOT EXISTS last_snipe_at text');
  await pool.query('ALTER TABLE guilds ADD COLUMN IF NOT EXISTS stats_message_id text');
  await pool.query('ALTER TABLE guilds ADD COLUMN IF NOT EXISTS stats_channel_id text');
  await pool.query(
    'ALTER TABLE guilds ADD COLUMN IF NOT EXISTS scoreboard_enabled integer NOT NULL DEFAULT 1'
  );
  await pool.query(
    'ALTER TABLE guilds ADD COLUMN IF NOT EXISTS tableflip_enabled integer NOT NULL DEFAULT 1'
  );
  if (hasSnipe.length === 0) {
    await pool.query(`
      UPDATE guilds SET
        snipe_count = (SELECT COUNT(*) FROM events e
                       WHERE e.guild_id = guilds.guild_id AND e.tag = 'ban' AND e.level = 'info'),
        last_snipe_at = (SELECT MAX(e.created_at) FROM events e
                         WHERE e.guild_id = guilds.guild_id AND e.tag = 'ban' AND e.level = 'info')
    `);
  }

  console.log('[store] Using PostgreSQL via DATABASE_URL');
}

async function getGuild(guildId) {
  const { rows } = await pool.query(
    'SELECT guild_id, honeypot_channel_id, setup_user_id, anchor_message_id, log_channel_id, ' +
      'snipe_count, last_snipe_at, stats_message_id, stats_channel_id, scoreboard_enabled, ' +
      'tableflip_enabled FROM guilds WHERE guild_id = $1',
    [guildId]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
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
  // Re-designating a channel resets the anchor to NULL, which returns the guild
  // to the awaiting-anchor state.
  await pool.query(
    `INSERT INTO guilds (guild_id, honeypot_channel_id, setup_user_id, anchor_message_id, log_channel_id)
     VALUES ($1, $2, $3, NULL, $4)
     ON CONFLICT (guild_id) DO UPDATE SET
       honeypot_channel_id = EXCLUDED.honeypot_channel_id,
       setup_user_id       = EXCLUDED.setup_user_id,
       anchor_message_id   = NULL,
       log_channel_id      = EXCLUDED.log_channel_id`,
    [guildId, channelId, userId, logChannelId]
  );
}

async function setAnchor(guildId, messageId) {
  await pool.query('UPDATE guilds SET anchor_message_id = $1 WHERE guild_id = $2', [
    messageId,
    guildId,
  ]);
}

async function recordSnipe(guildId) {
  await pool.query(
    'UPDATE guilds SET snipe_count = snipe_count + 1, last_snipe_at = $1 WHERE guild_id = $2',
    [new Date().toISOString(), guildId]
  );
}

async function setScoreboardEnabled(guildId, enabled) {
  await pool.query('UPDATE guilds SET scoreboard_enabled = $1 WHERE guild_id = $2', [
    enabled ? 1 : 0,
    guildId,
  ]);
}

async function setStatsMessage(guildId, messageId, channelId = null) {
  await pool.query(
    'UPDATE guilds SET stats_message_id = $1, stats_channel_id = $2 WHERE guild_id = $3',
    [messageId, channelId, guildId]
  );
}

async function setTableflipEnabled(guildId, enabled) {
  await pool.query('UPDATE guilds SET tableflip_enabled = $1 WHERE guild_id = $2', [
    enabled ? 1 : 0,
    guildId,
  ]);
}

async function deleteGuild(guildId) {
  // Events go with the config row: the privacy policy promises a kicked bot
  // leaves nothing behind for that server.
  await pool.query('DELETE FROM events WHERE guild_id = $1', [guildId]);
  await pool.query('DELETE FROM guilds WHERE guild_id = $1', [guildId]);
}

async function logEvent(guildId, level, tag, message) {
  await pool.query(
    'INSERT INTO events (guild_id, created_at, level, tag, message) VALUES ($1, $2, $3, $4, $5)',
    [guildId, new Date().toISOString(), level, tag, message]
  );
}

async function pruneEvents(retentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  const { rowCount } = await pool.query('DELETE FROM events WHERE created_at < $1', [cutoff]);
  return rowCount;
}

async function close() {
  await pool.end();
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
