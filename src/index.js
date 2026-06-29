'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ComponentType,
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

const fs = require('node:fs');
const store = require('./store');
const { gInfo, gWarn, gError } = require('./log');
const { checkForUpdate } = require('./update-check');
const { postScoreboard, scheduleScoreboardUpdate } = require('./scoreboard');
const { handleTableflip, forgetGuild } = require('./tableflip');

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

// Touched only while the gateway is READY: a hung gateway leaves the process
// alive (restart:unless-stopped won't fire) but lets this go stale for the healthcheck.
const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE || '/data/heartbeat';
const HEARTBEAT_INTERVAL_MS = 30000;
function writeHeartbeat() {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, String(Date.now()));
  } catch {
    /* best-effort: a failed write just lets the timestamp age toward unhealthy */
  }
}

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
      .setRequired(true)
  )
  .addChannelOption((option) =>
    option
      .setName('log_channel')
      .setDescription('Channel where the bot posts activation and ban notices (optional).')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(false)
  );

const scoreboardCommand = new SlashCommandBuilder()
  .setName('scoreboard')
  .setDescription('Show or hide the honeypot snipe scoreboard in the trap channel.')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addBooleanOption((option) =>
    option
      .setName('enabled')
      .setDescription('true posts/keeps the scoreboard, false hides it.')
      .setRequired(true)
  );

const unflipsCommand = new SlashCommandBuilder()
  .setName('unflips')
  .setDescription('Toggle the tableflip easter egg (the bot unflips tables members flip).')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addBooleanOption((option) =>
    option
      .setName('enabled')
      .setDescription('true lets the bot unflip tables, false silences it.')
      .setRequired(true)
  );

// Every permission the /setup flow depends on, with live ok/missing state.
function checkSetupPermissions(guild, channel, logChannel) {
  const me = guild.members.me;
  const has = (ch, flag) => ch.permissionsFor(me)?.has(flag) ?? false;
  const checks = [
    {
      label: `Server: Ban Members`,
      ok: me?.permissions.has(PermissionFlagsBits.BanMembers) ?? false,
    },
    { label: `<#${channel.id}>: View Channel`, ok: has(channel, PermissionFlagsBits.ViewChannel) },
    {
      label: `<#${channel.id}>: Manage Messages (deletes trigger messages)`,
      ok: has(channel, PermissionFlagsBits.ManageMessages),
    },
    {
      // Discord split pinning out of Manage Messages; either grants it today.
      label: `<#${channel.id}>: Pin Messages (pins the warning notice)`,
      ok:
        has(channel, PermissionFlagsBits.PinMessages) ||
        has(channel, PermissionFlagsBits.ManageMessages),
    },
    {
      label: `<#${channel.id}>: Read Message History`,
      ok: has(channel, PermissionFlagsBits.ReadMessageHistory),
    },
  ];
  if (logChannel) {
    checks.push(
      {
        label: `<#${logChannel.id}>: View Channel`,
        ok: has(logChannel, PermissionFlagsBits.ViewChannel),
      },
      {
        label: `<#${logChannel.id}>: Send Messages`,
        ok: has(logChannel, PermissionFlagsBits.SendMessages),
      }
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
      await interaction.editReply(
        `${baseContent}\n\n**Permission check**\n${formatChecks(checks)}\n\n${status}`
      );
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

// Latest /setup reply per guild, so activation can update the ephemeral. Tokens
// die after 15 min; later edits fail quietly and the log channel carries the news.
const pendingSetupReplies = new Map();

// Single activation point for both anchor paths (fresh post, existing pin).
async function activateHoneypot(guild, config, messageId, how) {
  await store.setAnchor(guild.id, messageId);
  gInfo('anchor', guild, `honeypot ACTIVE, anchor ${messageId} (${how})`);
  await sendGuildLog(
    guild,
    config,
    `Honeypot is now **ACTIVE** in <#${config.honeypotChannelId}>. Anyone who posts there (except users with the Administrator role) will be banned.`
  );

  if (config.scoreboardEnabled !== false) {
    const fresh = await store.getGuild(guild.id);
    if (fresh) await postScoreboard(guild, fresh);
  }

  const pending = pendingSetupReplies.get(guild.id);
  if (!pending) return;
  pendingSetupReplies.delete(guild.id);
  activePermPolls.get(guild.id)?.cancel();
  const checks = checkSetupPermissions(guild, pending.channel, pending.logChannel);
  try {
    await pending.interaction.editReply(
      `${pending.baseContent}\n\n**Permission check**\n${formatChecks(checks)}\n\n` +
        `:white_check_mark: **Honeypot is ACTIVE** in <#${config.honeypotChannelId}>. Setup complete.`
    );
  } catch (err) {
    gWarn('setup', guild, 'updating the setup reply with the active status', err);
  }
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

async function handleScoreboardCommand(interaction) {
  try {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'This command can only be used inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const isOwner = interaction.guild?.ownerId === interaction.user.id;
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
    if (!isOwner && !isAdmin) {
      await interaction.reply({
        content: 'Only the server owner or an Administrator can run /scoreboard.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const config = await store.getGuild(interaction.guildId);
    if (!config || !config.honeypotChannelId) {
      await interaction.reply({
        content: 'No honeypot configured yet. Run /setup first.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Posting/fetching/deleting can exceed the 3s ack window, so defer first.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const enabled = interaction.options.getBoolean('enabled');
    if (enabled) {
      await store.setScoreboardEnabled(interaction.guildId, true);
      const fresh = await store.getGuild(interaction.guildId);
      const id = await postScoreboard(interaction.guild, fresh);
      gInfo('scoreboard', interaction.guild, `enabled by ${interaction.user.tag}`);
      await interaction.editReply({
        content: id
          ? `Scoreboard is ON in <#${config.honeypotChannelId}>.`
          : 'Scoreboard enabled, but I could not post it (check my permissions in the channel).',
      });
    } else {
      await store.setScoreboardEnabled(interaction.guildId, false);
      if (config.statsMessageId) {
        const oldChannelId = config.statsChannelId ?? config.honeypotChannelId;
        try {
          const channel =
            interaction.guild.channels.cache.get(oldChannelId) ??
            (await interaction.guild.channels.fetch(oldChannelId));
          const message = await channel.messages.fetch(config.statsMessageId);
          await message.delete();
          // Forget the id only after the delete lands, so a failed delete retries later.
          await store.setStatsMessage(interaction.guildId, null, null);
        } catch (err) {
          gWarn('scoreboard', interaction.guild, 'deleting the scoreboard message', err);
        }
      }
      gInfo('scoreboard', interaction.guild, `disabled by ${interaction.user.tag}`);
      await interaction.editReply({
        content: 'Scoreboard is OFF. The counter keeps running; re-enable any time.',
      });
    }
  } catch (err) {
    gError('scoreboard', interaction.guild, 'handling /scoreboard', err);
    try {
      const content = 'Something went wrong. Check the bot logs.';
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content });
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } catch (_) {
      /* swallow */
    }
  }
}

async function handleUnflipsCommand(interaction) {
  try {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'This command can only be used inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const isOwner = interaction.guild?.ownerId === interaction.user.id;
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
    if (!isOwner && !isAdmin) {
      await interaction.reply({
        content: 'Only the server owner or an Administrator can run /unflips.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const config = await store.getGuild(interaction.guildId);
    if (!config || !config.honeypotChannelId) {
      await interaction.reply({
        content: 'No honeypot configured yet. Run /setup first.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const enabled = interaction.options.getBoolean('enabled');
    await store.setTableflipEnabled(interaction.guildId, enabled);
    gInfo(
      'tableflip',
      interaction.guild,
      `${enabled ? 'enabled' : 'disabled'} by ${interaction.user.tag}`
    );
    await interaction.reply({
      content: enabled
        ? 'Tableflip easter egg is ON. Profanity stays in NSFW channels only.'
        : 'Tableflip easter egg is OFF.',
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    gError('tableflip', interaction.guild, 'handling /unflips', err);
    try {
      const content = 'Something went wrong. Check the bot logs.';
      if (interaction.deferred || interaction.replied)
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } catch (_) {
      /* swallow */
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

client.once(Events.ClientReady, async (c) => {
  console.log(`[ready] Logged in as ${c.user.tag}`);
  writeHeartbeat(); // seed immediately so the healthcheck passes from the first ready tick
  // Global registration: one call covers every current and future guild, and
  // the App Directory's "uses slash commands" check only sees global commands.
  try {
    await c.application.commands.set([
      setupCommand.toJSON(),
      scoreboardCommand.toJSON(),
      unflipsCommand.toJSON(),
    ]);
    console.log('[commands] Registered /setup and /scoreboard globally');
  } catch (err) {
    console.error('[commands] Failed to register /setup globally:', err);
  }
  // Clear guild-scoped copies left by versions that registered per guild, so
  // the command picker doesn't offer /setup twice.
  for (const guild of c.guilds.cache.values()) {
    try {
      await guild.commands.set([]);
    } catch (err) {
      gWarn('commands', guild, 'clearing legacy guild commands', err);
    }
  }
});

// Privacy: drop the guild's config the moment the bot is kicked or the guild is
// deleted, so the database only ever holds servers the bot is actually in.
client.on(Events.GuildDelete, async (guild) => {
  try {
    activePermPolls.get(guild.id)?.cancel();
    pendingSetupReplies.delete(guild.id);
    forgetGuild(guild.id);
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
  if (interaction.commandName === 'scoreboard') {
    await handleScoreboardCommand(interaction);
    return;
  }
  if (interaction.commandName === 'unflips') {
    await handleUnflipsCommand(interaction);
    return;
  }
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

    // Re-running /setup wipes the anchor and any previous channel choice, so an
    // existing config gets a Yes/No confirmation before anything is touched.
    const existing = await store.getGuild(interaction.guildId);
    let respond = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

    if (existing) {
      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('setup_confirm')
          .setLabel('Yes, reset it')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('setup_cancel')
          .setLabel('No, keep it')
          .setStyle(ButtonStyle.Secondary)
      );
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        components: [buttons],
        content:
          `This server already has a honeypot in <#${existing.honeypotChannelId}> ` +
          `(${existing.active ? 'ACTIVE' : 'awaiting anchor'}). Re-running /setup **resets it**: ` +
          'the current configuration is replaced and the honeypot stays inactive until a new ' +
          'warning notice is pinned or posted. Continue?',
      });

      const warningMessage = await interaction.fetchReply();
      let click;
      try {
        click = await warningMessage.awaitMessageComponent({
          componentType: ComponentType.Button,
          time: 60000,
        });
      } catch (_) {
        await interaction.editReply({
          content: 'No answer within a minute. Kept the existing configuration; nothing changed.',
          components: [],
        });
        return;
      }

      if (click.customId === 'setup_cancel') {
        await click.update({
          content: 'Kept the existing configuration. Nothing changed.',
          components: [],
        });
        gInfo(
          'setup',
          interaction.guild,
          `re-run cancelled by ${interaction.user.tag} (${interaction.user.id})`
        );
        return;
      }

      respond = (content) => click.update({ content, components: [] });
    }

    await store.setHoneypot(
      interaction.guildId,
      channel.id,
      interaction.user.id,
      logChannel?.id ?? null
    );

    gInfo(
      'setup',
      interaction.guild,
      `honeypot designated: channel ${channel.id} by ${interaction.user.tag} (${interaction.user.id})` +
        (logChannel ? `, log channel ${logChannel.id}` : '') +
        ', awaiting anchor'
    );

    const baseContent = [
      `Honeypot channel set to <#${channel.id}>.`,
      logChannel ? `Activity notices will be posted in <#${logChannel.id}>.` : null,
      '',
      "**Important:** the bot's role must sit **ABOVE** the roles of anyone it " +
        'should be able to ban. If a target outranks the bot, the ban silently fails.',
      '',
      `**Final step:** go to <#${channel.id}> and either **pin an existing message** ` +
        '(if you set up the channel before inviting the bot), or **post one new message** ' +
        'that the bot will pin. That message becomes the permanent warning notice and sets ' +
        'the honeypot to **ACTIVE**. It is never deleted and never triggers a ban.',
    ]
      .filter((line) => line !== null)
      .join('\n');

    const checks = checkSetupPermissions(interaction.guild, channel, logChannel);
    const allOk = checks.every((c) => c.ok);
    const status = allOk
      ? ':white_check_mark: **All permissions in place.**'
      : ':x: **Missing permissions found.** I will re-check every minute for 5 minutes and update this message.';

    await respond(`${baseContent}\n\n**Permission check**\n${formatChecks(checks)}\n\n${status}`);

    pendingSetupReplies.set(interaction.guildId, { interaction, baseContent, channel, logChannel });
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

// Alternate anchor path: staff pin an existing message (channel was set up
// before the bot was invited). Only staff can pin, so Discord itself gates this.
client.on(Events.ChannelPinsUpdate, async (channel) => {
  try {
    if (!channel.guildId) return;
    const config = await store.getGuild(channel.guildId);
    if (!config?.awaitingAnchor) return;
    if (channel.id !== config.honeypotChannelId) return;

    let pins;
    try {
      pins = await channel.messages.fetchPins();
    } catch (err) {
      gWarn('anchor', channel.guild, 'fetching pins to adopt an anchor', err);
      return;
    }
    if (!pins.items.length) return;

    const newest = pins.items.reduce((a, b) => (b.pinnedTimestamp > a.pinnedTimestamp ? b : a));
    await activateHoneypot(channel.guild, config, newest.message.id, 'existing pin adopted');
  } catch (err) {
    gError('pins', channel.guild ?? null, 'unexpected handler error', err);
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
    // System messages (pin notices, boosts, joins) carry a member as author but
    // are posted by Discord: never an anchor candidate, never a ban trigger.
    if (message.system) return;
    // DMs carry no per-guild honeypot config.
    if (!message.guildId) return;

    const config = await store.getGuild(message.guildId);
    if (!config || !config.honeypotChannelId) return;

    if (message.channelId !== config.honeypotChannelId) return;

    if (config.awaitingAnchor) {
      // Gating on the setup user stops a random member from planting the anchor
      // and thereby choosing a message that can never be banned.
      if (message.author.id !== config.setupUserId) return;

      // Activate before pinning: our own pin fires ChannelPinsUpdate, and the
      // adoption handler must already see the anchor as set.
      await activateHoneypot(message.guild, config, message.id, 'posted by setup user');

      const perms = message.channel.permissionsFor(message.guild.members.me);
      const canPin =
        (perms?.has(PermissionFlagsBits.PinMessages) ?? false) ||
        (perms?.has(PermissionFlagsBits.ManageMessages) ?? false);
      if (!canPin) {
        gWarn(
          'anchor',
          message.guild,
          `pinning anchor message ${message.id}`,
          new Error('missing Pin Messages permission, did not attempt')
        );
        await sendGuildLog(
          message.guild,
          config,
          `:warning: Could not pin the anchor message in <#${config.honeypotChannelId}> ` +
            '(needs **Pin Messages** there). The honeypot still works, but the warning notice is not pinned.'
        );
        return;
      }

      try {
        await message.pin();
      } catch (err) {
        gWarn('anchor', message.guild, `pinning anchor message ${message.id}`, err);
        await sendGuildLog(
          message.guild,
          config,
          `:warning: Could not pin the anchor message in <#${config.honeypotChannelId}>. ` +
            'The honeypot still works, but the warning notice is not pinned.'
        );
      }
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
        new Error('not bannable: target outranks bot or member could not be resolved')
      );
      await sendGuildLog(
        guild,
        config,
        `:warning: Honeypot triggered by **${message.author.tag}** (${message.author.id}) but the ban was ` +
          'skipped: the target outranks the bot, or the member could not be resolved. Check the role hierarchy.'
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
          'Their messages from the last 7 days were purged.'
      );
      // Counter is the source of truth and must update even if the scoreboard is
      // off or its message is gone; the edit is coalesced and best-effort.
      try {
        await store.recordSnipe(guild.id);
        scheduleScoreboardUpdate(guild);
      } catch (err) {
        gWarn('scoreboard', guild, 'recording the snipe', err);
      }
    } catch (err) {
      gError('ban', guild, `banning ${who}`, err);
      await sendGuildLog(
        guild,
        config,
        `:warning: Honeypot triggered by **${message.author.tag}** (${message.author.id}) but the ban failed: ` +
          `${err.message || err}. Check the bot's permissions and role position.`
      );
    }
  } catch (err) {
    // Never let a message handler crash the process.
    gError('messageCreate', message.guild, 'unexpected handler error', err);
  }
});

// Separate listener: the honeypot handler above returns for any non-trap channel,
// but the tableflip easter egg fires server-wide.
client.on(Events.MessageCreate, async (message) => {
  try {
    await handleTableflip(message, store);
  } catch (err) {
    gError('tableflip', message.guild, 'unexpected handler error', err);
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
    if (removed > 0)
      console.log(`[store] Pruned ${removed} event(s) older than ${LOG_RETENTION_DAYS} days`);
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
  await checkForUpdate();
  // unref() so a pending timer never holds the process open during shutdown.
  setInterval(pruneOldEvents, PRUNE_INTERVAL_MS).unref();
  setInterval(checkForUpdate, PRUNE_INTERVAL_MS).unref();
  setInterval(() => {
    if (client.isReady()) writeHeartbeat();
  }, HEARTBEAT_INTERVAL_MS).unref();
  try {
    await client.login(TOKEN);
  } catch (err) {
    console.error('[fatal] Failed to log in to Discord (check DISCORD_TOKEN and network):', err);
    process.exit(1);
  }
})();
