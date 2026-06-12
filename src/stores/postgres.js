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
      anchor_message_id   text
    );
  `);
  console.log('[store] Using PostgreSQL via DATABASE_URL');
}

async function getGuild(guildId) {
  const { rows } = await pool.query(
    'SELECT guild_id, honeypot_channel_id, setup_user_id, anchor_message_id FROM guilds WHERE guild_id = $1',
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
    awaitingAnchor: anchorMessageId == null,
    active: anchorMessageId != null,
  };
}

async function setHoneypot(guildId, channelId, userId) {
  // Re-designating a channel resets the anchor to NULL, which returns the guild
  // to the awaiting-anchor state.
  await pool.query(
    `INSERT INTO guilds (guild_id, honeypot_channel_id, setup_user_id, anchor_message_id)
     VALUES ($1, $2, $3, NULL)
     ON CONFLICT (guild_id) DO UPDATE SET
       honeypot_channel_id = EXCLUDED.honeypot_channel_id,
       setup_user_id       = EXCLUDED.setup_user_id,
       anchor_message_id   = NULL`,
    [guildId, channelId, userId],
  );
}

async function setAnchor(guildId, messageId) {
  await pool.query('UPDATE guilds SET anchor_message_id = $1 WHERE guild_id = $2', [messageId, guildId]);
}

async function deleteGuild(guildId) {
  await pool.query('DELETE FROM guilds WHERE guild_id = $1', [guildId]);
}

async function close() {
  await pool.end();
}

module.exports = { init, getGuild, setHoneypot, setAnchor, deleteGuild, close };
