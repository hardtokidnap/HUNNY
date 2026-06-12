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
      log_channel_id      text
    );
  `);
  // Idempotent column add for databases created before in-guild logging existed.
  await pool.query('ALTER TABLE guilds ADD COLUMN IF NOT EXISTS log_channel_id text');

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
  await pool.query('CREATE INDEX IF NOT EXISTS idx_events_guild_time ON events (guild_id, created_at)');

  console.log('[store] Using PostgreSQL via DATABASE_URL');
}

async function getGuild(guildId) {
  const { rows } = await pool.query(
    'SELECT guild_id, honeypot_channel_id, setup_user_id, anchor_message_id, log_channel_id FROM guilds WHERE guild_id = $1',
    [guildId],
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
    [guildId, channelId, userId, logChannelId],
  );
}

async function setAnchor(guildId, messageId) {
  await pool.query('UPDATE guilds SET anchor_message_id = $1 WHERE guild_id = $2', [messageId, guildId]);
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
    [guildId, new Date().toISOString(), level, tag, message],
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

module.exports = { init, getGuild, setHoneypot, setAnchor, deleteGuild, logEvent, pruneEvents, close };
