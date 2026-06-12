'use strict';

const store = require('./store');

// One grep-able shape per line: [tag] guild="Name" (id) [FAIL] message[: reason].
// No stdout timestamps (hosts stamp lines); events table gets one for querying.

function guildLabel(guild) {
  if (!guild) return 'guild="unknown" (unknown)';
  const name = guild.name || 'unknown';
  const id = guild.id || 'unknown';
  return `guild="${name}" (${id})`;
}

// discord.js API errors carry a numeric code (50013 Missing Permissions etc.);
// plain Errors only have a message. Render whichever exists.
function errDetail(err) {
  if (!err) return '';
  const msg = err.message || String(err);
  return err.code != null ? `: ${msg} (code ${err.code})` : `: ${msg}`;
}

// Fire-and-forget: a database hiccup must never delay or break the ban flow,
// and reporting it via gError would recurse right back here.
function persist(guild, level, tag, body) {
  if (!guild?.id) return;
  Promise.resolve()
    .then(() => store.logEvent(guild.id, level, tag, body))
    .catch((err) => {
      console.error(`[store] FAIL persisting log event: ${err.message || err}`);
    });
}

function gInfo(tag, guild, message) {
  console.log(`[${tag}] ${guildLabel(guild)} ${message}`);
  persist(guild, 'info', tag, message);
}

function gWarn(tag, guild, message, err) {
  const body = `${message}${errDetail(err)}`;
  console.warn(`[${tag}] ${guildLabel(guild)} FAIL ${body}`);
  persist(guild, 'warn', tag, body);
}

function gError(tag, guild, message, err) {
  const body = `${message}${errDetail(err)}`;
  console.error(`[${tag}] ${guildLabel(guild)} FAIL ${body}`);
  persist(guild, 'error', tag, body);
}

module.exports = { gInfo, gWarn, gError };
