'use strict';

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
  Options,
  InteractionContextType,
} = require('discord.js');

const store = require('./store');
const { gInfo, gWarn, gError } = require('./log');

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('[fatal] DISCORD_TOKEN env var is not set. Refusing to start.');
  process.exit(1);
}

const BAN_REASON = 'Honeypot triggered - compromised/spam account';
const DELETE_MESSAGE_SECONDS = 604800; // 7 days, purges spam server-wide
// Days of per-guild event history kept in the database for backend review.
const LOG_RETENTION_DAYS = Math.max(1, Number(process.env.LOG_RETENTION_DAYS) || 30);
const PRUNE_INTERVAL_MS = 86400000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  // Allow handling messages from uncached channels/messages defensively.
  partials: [Partials.Channel, Partials.Message],
  // Keep memory flat over long uptimes on small hardware (e.g. a Raspberry Pi),
  // even on very large servers. We act on the live event payload, never on
  // cached history, so these caches can be tiny:
  //  - We never read message history -> a near-empty message cache is fine.
  //  - Members are fetched on demand in the ban handler, so cached entries are
  //    disposable; sweeping them just means a re-fetch next time.
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 10,
    PresenceManager: 0,
  }),
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: { interval: 3600, lifetime: 1800 },
    members: {
      interval: 3600,
      // Keep our own user so client.user stays populated; everyone else is
      // re-fetchable on demand, so dropping them only reclaims memory.
      filter: () => (member) => member.id !== client.user?.id,
    },
  },
});

// ---------------------------------------------------------------------------
// Slash command definition + registration
// ---------------------------------------------------------------------------

const setupCommand = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Designate a honeypot trap channel that auto-bans anyone who posts in it.')
  .setContexts(InteractionContextType.Guild)
  // Restrict visibility/use to members with Administrator (server owner always
  // qualifies). We re-check in the handler as a defence in depth.
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addChannelOption((option) =>
    option
      .setName('channel')
      .setDescription('The text channel to turn into the honeypot.')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true),
  )
  .addChannelOption((option) =>
    option
      .setName('log_channel')
      .setDescription('Channel where the bot posts activation and ban notices (optional).')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(false),
  );

// Every permission the /setup flow depends on, with live ok/missing state.
function checkSetupPermissions(guild, channel, logChannel) {
  const me = guild.members.me;
  const has = (ch, flag) => ch.permissionsFor(me)?.has(flag) ?? false;
  const checks = [
    { label: `Server: Ban Members`, ok: me?.permissions.has(PermissionFlagsBits.BanMembers) ?? false },
    { label: `<#${channel.id}>: View Channel`, ok: has(channel, PermissionFlagsBits.ViewChannel) },
    {
      label: `<#${channel.id}>: Manage Messages (pins the notice, deletes trigger messages)`,
      ok: has(channel, PermissionFlagsBits.ManageMessages),
    },
    { label: `<#${channel.id}>: Read Message History`, ok: has(channel, PermissionFlagsBits.ReadMessageHistory) },
  ];
  if (logChannel) {
    checks.push(
      { label: `<#${logChannel.id}>: View Channel`, ok: has(logChannel, PermissionFlagsBits.ViewChannel) },
      { label: `<#${logChannel.id}>: Send Messages`, ok: has(logChannel, PermissionFlagsBits.SendMessages) },
    );
  }
  return checks;
}

const formatChecks = (checks) =>
  checks.map((c) => `${c.ok ? ':white_check_mark:' : ':x:'} ${c.label}`).join('\n');

// One poll loop per guild; a /setup re-run replaces the previous loop.
const activePermPolls = new Map();
const PERM_POLL_INTERVAL_MS = 60000;
// 5 polls = ~5 minutes; the ephemeral reply stops being editable at 15.
const PERM_POLL_LIMIT = 5;

function startPermissionPoll(interaction, channel, logChannel, baseContent) {
  const guildId = interaction.guildId;
  activePermPolls.get(guildId)?.cancel();

  let polls = 0;
  let timer = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    activePermPolls.delete(guildId);
  };
  activePermPolls.set(guildId, { cancel });

  const tick = async () => {
    polls += 1;
    const checks = checkSetupPermissions(interaction.guild, channel, logChannel);
    const allOk = checks.every((c) => c.ok);
    const status = allOk
      ? ':white_check_mark: **All permissions in place.** Post the anchor message when ready.'
      : polls >= PERM_POLL_LIMIT
        ? ':x: **Still missing permissions.** Stopped checking; fix them and re-run /setup to verify.'
        : `Re-checking every minute (${polls}/${PERM_POLL_LIMIT})...`;
    try {
      await interaction.editReply(`${baseContent}\n\n**Permission check**\n${formatChecks(checks)}\n\n${status}`);
    } catch (err) {
      gWarn('setup', interaction.guild, 'updating the permission checklist', err);
      cancel();
      return;
    }
    if (allOk || polls >= PERM_POLL_LIMIT) {
      if (allOk) gInfo('setup', interaction.guild, 'permission checklist all green');
      cancel();
      return;
    }
    timer = setTimeout(tick, PERM_POLL_INTERVAL_MS);
    timer.unref?.();
  };

  timer = setTimeout(tick, PERM_POLL_INTERVAL_MS);
  timer.unref?.();
}

// In-guild activity feed for server staff. Best-effort by design: a missing
// channel or missing Send Messages permission must never affect the ban flow.
async function sendGuildLog(guild, config, text) {
  if (!config?.logChannelId) return;
  try {
    const channel =
      guild.channels.cache.get(config.logChannelId) ??
      (await guild.channels.fetch(config.logChannelId));
    await channel.send(text);
  } catch (err) {
    gWarn('guildlog', guild, `posting to log channel ${config.logChannelId}`, err);
  }
}

async function registerCommandsForGuild(guild) {
  try {
    await guild.commands.set([setupCommand.toJSON()]);
    gInfo('commands', guild, 'registered /setup');
  } catch (err) {
    gError('commands', guild, 'registering /setup', err);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

client.once(Events.ClientReady, async (c) => {
  console.log(`[ready] Logged in as ${c.user.tag}`);
  // Register as guild commands everywhere for instant availability.
  for (const guild of c.guilds.cache.values()) {
    await registerCommandsForGuild(guild);
  }
});

client.on(Events.GuildCreate, async (guild) => {
  await registerCommandsForGuild(guild);
});

// Privacy: drop the guild's config the moment the bot is kicked or the guild is
// deleted, so the database only ever holds servers the bot is actually in.
client.on(Events.GuildDelete, async (guild) => {
  try {
    activePermPolls.get(guild.id)?.cancel();
    await store.deleteGuild(guild.id);
    gInfo('cleanup', guild, 'removed config for departed guild');
  } catch (err) {
    gError('cleanup', guild, 'removing config for departed guild', err);
  }
});

// ---------------------------------------------------------------------------
// /setup handler
// ---------------------------------------------------------------------------

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'setup') return;

  try {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'This command can only be used inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Defence in depth: server owner OR Administrator only.
    const isOwner = interaction.guild?.ownerId === interaction.user.id;
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
    if (!isOwner && !isAdmin) {
      await interaction.reply({
        content: 'Only the server owner or an Administrator can run /setup.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const channel = interaction.options.getChannel('channel');
    const logChannel = interaction.options.getChannel('log_channel');

    await store.setHoneypot(interaction.guildId, channel.id, interaction.user.id, logChannel?.id ?? null);

    gInfo(
      'setup',
      interaction.guild,
      `honeypot designated: channel ${channel.id} by ${interaction.user.tag} (${interaction.user.id})` +
        (logChannel ? `, log channel ${logChannel.id}` : '') +
        ', awaiting anchor',
    );

    const baseContent = [
      `Honeypot channel set to <#${channel.id}>.`,
      logChannel ? `Activity notices will be posted in <#${logChannel.id}>.` : null,
      '',
      '**Important:** the bot\'s role must sit **ABOVE** the roles of anyone it ' +
        'should be able to ban. If a target outranks the bot, the ban silently fails.',
      '',
      `**Final step:** go to <#${channel.id}> and post **one** message now. ` +
        'The bot will pin it as the permanent warning notice and flip the honeypot to ' +
        '**ACTIVE**. That anchor message is never deleted and never triggers a ban.',
    ].filter((line) => line !== null).join('\n');

    const checks = checkSetupPermissions(interaction.guild, channel, logChannel);
    const allOk = checks.every((c) => c.ok);
    const status = allOk
      ? ':white_check_mark: **All permissions in place.**'
      : ':x: **Missing permissions found.** I will re-check every minute for 5 minutes and update this message.';

    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: `${baseContent}\n\n**Permission check**\n${formatChecks(checks)}\n\n${status}`,
    });

    if (!allOk) startPermissionPoll(interaction, channel, logChannel, baseContent);
  } catch (err) {
    gError('setup', interaction.guild, 'handling /setup', err);
    // Best-effort error reply.
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: 'Something went wrong during setup. Check the bot logs.',
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: 'Something went wrong during setup. Check the bot logs.',
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (_) {
      /* swallow */
    }
  }
});

// ---------------------------------------------------------------------------
// Message handler: anchor capture + ban logic
// ---------------------------------------------------------------------------

client.on(Events.MessageCreate, async (message) => {
  try {
    // Compromised accounts post as users, never bots; skipping bots also stops
    // the handler from reacting to our own anchor pin.
    if (message.author?.bot) return;
    // DMs carry no per-guild honeypot config.
    if (!message.guildId) return;

    const config = await store.getGuild(message.guildId);
    if (!config || !config.honeypotChannelId) return;

    if (message.channelId !== config.honeypotChannelId) return;

    if (config.awaitingAnchor) {
      // Gating on the setup user stops a random member from planting the anchor
      // and thereby choosing a message that can never be banned.
      if (message.author.id !== config.setupUserId) return;

      try {
        await message.pin();
      } catch (err) {
        gWarn('anchor', message.guild, `pinning anchor message ${message.id}`, err);
        await sendGuildLog(
          message.guild,
          config,
          `:warning: Could not pin the anchor message in <#${config.honeypotChannelId}> ` +
            '(needs **Manage Messages** there). The honeypot still works, but the warning notice is not pinned.',
        );
      }

      await store.setAnchor(message.guildId, message.id);

      gInfo('anchor', message.guild, `honeypot ACTIVE, anchor ${message.id}`);
      await sendGuildLog(
        message.guild,
        config,
        `Honeypot is now **ACTIVE** in <#${config.honeypotChannelId}>. Anyone who posts there (except staff) will be banned.`,
      );
      return;
    }

    if (!config.active) return;

    // The anchor is the permanent warning notice, so it must never be banned.
    if (message.id === config.anchorMessageId) return;

    const guild = message.guild;

    // Staff are exempt: the owner and Administrators can post freely.
    if (message.author.id === guild.ownerId) return;

    // message.member can be absent for uncached authors, but the Administrator
    // and bannable checks below both depend on having it.
    const who = `${message.author.tag} (${message.author.id})`;

    let member = message.member;
    if (!member) {
      try {
        member = await guild.members.fetch(message.author.id);
      } catch (err) {
        gWarn('ban', guild, `fetching member ${who}`, err);
      }
    }

    if (member?.permissions?.has(PermissionFlagsBits.Administrator)) return;

    gInfo('detect', guild, `honeypot triggered by ${who}, message ${message.id}`);

    // Banning someone who outranks the bot throws; skipping keeps the process
    // alive and surfaces the misconfiguration in the logs instead of crashing.
    if (!member || !member.bannable) {
      gWarn(
        'ban',
        guild,
        `banning ${who}`,
        new Error('not bannable: target outranks bot or member could not be resolved'),
      );
      await sendGuildLog(
        guild,
        config,
        `:warning: Honeypot triggered by **${message.author.tag}** (${message.author.id}) but the ban was ` +
          'skipped: the target outranks the bot, or the member could not be resolved. Check the role hierarchy.',
      );
      return;
    }

    // Delete first so the spam is gone even if the ban call later fails.
    try {
      await message.delete();
      gInfo('detect', guild, `deleted trigger message ${message.id} from ${who}`);
    } catch (err) {
      gWarn('detect', guild, `deleting trigger message ${message.id} from ${who}`, err);
    }

    // deleteMessageSeconds purges 7 days of their messages across every channel
    // in the same call, so one ban cleans up an entire mass-spam run.
    try {
      await member.ban({
        deleteMessageSeconds: DELETE_MESSAGE_SECONDS,
        reason: BAN_REASON,
      });
      gInfo('ban', guild, `banned ${who}, purged 7 days of messages`);
      await sendGuildLog(
        guild,
        config,
        `:hammer: Banned **${message.author.tag}** (${message.author.id}) for posting in the honeypot. ` +
          'Their messages from the last 7 days were purged.',
      );
    } catch (err) {
      gError('ban', guild, `banning ${who}`, err);
      await sendGuildLog(
        guild,
        config,
        `:warning: Honeypot triggered by **${message.author.tag}** (${message.author.id}) but the ban failed: ` +
          `${err.message || err}. Check the bot's permissions and role position.`,
      );
    }
  } catch (err) {
    // Never let a message handler crash the process.
    gError('messageCreate', message.guild, 'unexpected handler error', err);
  }
});

// ---------------------------------------------------------------------------
// Safety nets
// ---------------------------------------------------------------------------

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

// Graceful shutdown: close the gateway session and flush/close storage so
// `docker stop`, systemd stop, and Ctrl+C all exit cleanly.
async function shutdown(signal) {
  console.log(`[shutdown] Received ${signal}, shutting down...`);
  try {
    await client.destroy();
  } catch (err) {
    console.error('[shutdown] Error while closing Discord client:', err);
  }
  try {
    await store.close();
  } catch (err) {
    console.error('[shutdown] Error while closing storage:', err);
  }
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// Prepare storage (create tables, open the connection) before connecting to
// Discord, so the first message can't race an uninitialized store.
async function pruneOldEvents() {
  try {
    const removed = await store.pruneEvents(LOG_RETENTION_DAYS);
    if (removed > 0) console.log(`[store] Pruned ${removed} event(s) older than ${LOG_RETENTION_DAYS} days`);
  } catch (err) {
    console.error('[store] Failed to prune old events:', err);
  }
}

(async () => {
  try {
    await store.init();
  } catch (err) {
    console.error('[fatal] Failed to initialize storage:', err);
    process.exit(1);
  }
  await pruneOldEvents();
  // unref() so a pending timer never holds the process open during shutdown.
  setInterval(pruneOldEvents, PRUNE_INTERVAL_MS).unref();
  try {
    await client.login(TOKEN);
  } catch (err) {
    console.error('[fatal] Failed to log in to Discord (check DISCORD_TOKEN and network):', err);
    process.exit(1);
  }
})();
