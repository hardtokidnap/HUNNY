'use strict';

const { EmbedBuilder } = require('discord.js');
const store = require('./store');
const { gWarn } = require('./log');

const COALESCE_MS = 4000;
// guildId -> pending edit timer. In-memory: a restart just means the next ban
// schedules a fresh edit, and the DB count is already correct.
const pendingEdits = new Map();

function renderScoreboard(config) {
  const lastCatch = config.lastSnipeAt
    ? `<t:${Math.floor(Date.parse(config.lastSnipeAt) / 1000)}:f>`
    : 'None yet';
  return new EmbedBuilder()
    .setTitle('🍯 Honeypot scoreboard')
    .addFields(
      { name: 'Caught', value: String(config.snipeCount ?? 0), inline: true },
      { name: 'Last catch', value: lastCatch, inline: true }
    );
}

async function resolveChannel(guild, channelId) {
  return guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId));
}

async function postScoreboard(guild, config) {
  try {
    // Drop the previously tracked message first so re-setup never leaves a stale embed;
    // it may be in the old channel after a /setup move, so delete it where it was posted.
    if (config.statsMessageId) {
      try {
        const oldChannel = await resolveChannel(
          guild,
          config.statsChannelId ?? config.honeypotChannelId
        );
        const old = await oldChannel.messages.fetch(config.statsMessageId);
        await old.delete();
      } catch (_) {
        /* already gone */
      }
    }
    const channel = await resolveChannel(guild, config.honeypotChannelId);
    const message = await channel.send({ embeds: [renderScoreboard(config)] });
    await store.setStatsMessage(guild.id, message.id, channel.id);
    return message.id;
  } catch (err) {
    gWarn('scoreboard', guild, 'posting the scoreboard', err);
    return null;
  }
}

function scheduleScoreboardUpdate(guild) {
  if (pendingEdits.has(guild.id)) return;
  // in-memory per-guild map. Revisit only for sub-second freshness or multi-process.
  const timer = setTimeout(async () => {
    pendingEdits.delete(guild.id);
    try {
      const config = await store.getGuild(guild.id);
      if (!config || !config.scoreboardEnabled || !config.statsMessageId) return;
      const channel = await resolveChannel(
        guild,
        config.statsChannelId ?? config.honeypotChannelId
      );
      const message = await channel.messages.fetch(config.statsMessageId);
      await message.edit({ embeds: [renderScoreboard(config)] });
    } catch (err) {
      gWarn('scoreboard', guild, 'updating the scoreboard', err);
      // Only forget the id when the message/channel is truly gone (Unknown Message /
      // Unknown Channel); transient errors keep it so the next update retries.
      if (err.code === 10008 || err.code === 10003) {
        try {
          await store.setStatsMessage(guild.id, null, null);
        } catch (_) {
          /* best-effort */
        }
      }
    }
  }, COALESCE_MS);
  timer.unref?.();
  pendingEdits.set(guild.id, timer);
}

module.exports = { renderScoreboard, postScoreboard, scheduleScoreboardUpdate };
