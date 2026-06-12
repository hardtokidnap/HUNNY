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

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('[fatal] DISCORD_TOKEN env var is not set. Refusing to start.');
  process.exit(1);
}

const BAN_REASON = 'Honeypot triggered - compromised/spam account';
const DELETE_MESSAGE_SECONDS = 604800; // 7 days, purges spam server-wide

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
  );

async function registerCommandsForGuild(guild) {
  try {
    await guild.commands.set([setupCommand.toJSON()]);
    console.log(`[commands] Registered /setup in guild ${guild.id} (${guild.name})`);
  } catch (err) {
    console.error(`[commands] Failed to register in guild ${guild.id}:`, err);
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
    await store.deleteGuild(guild.id);
    console.log(`[cleanup] Removed config for departed guild ${guild.id}`);
  } catch (err) {
    console.error(`[cleanup] Failed to remove config for guild ${guild.id}:`, err);
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

    await store.setHoneypot(interaction.guildId, channel.id, interaction.user.id);

    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: [
        `Honeypot channel set to <#${channel.id}>.`,
        '',
        '**Permissions this bot needs:**',
        '- Ban Members',
        '- Manage Messages',
        '- View Channel',
        '- Read Message History',
        '',
        '**Important:** the bot\'s role must sit **ABOVE** the roles of anyone it ' +
          'should be able to ban. If a target outranks the bot, the ban silently fails.',
        '',
        `**Final step:** go to <#${channel.id}> and post **one** message now. ` +
          'The bot will pin it as the permanent warning notice and flip the honeypot to ' +
          '**ACTIVE**. That anchor message is never deleted and never triggers a ban.',
      ].join('\n'),
    });
  } catch (err) {
    console.error('[setup] Handler error:', err);
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
        console.warn(`[anchor] Failed to pin anchor message in guild ${message.guildId}:`, err);
      }

      await store.setAnchor(message.guildId, message.id);

      console.log(`[anchor] Honeypot ACTIVE in guild ${message.guildId}, anchor ${message.id}`);
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
    let member = message.member;
    if (!member) {
      try {
        member = await guild.members.fetch(message.author.id);
      } catch (err) {
        console.warn(`[ban] Could not fetch member ${message.author.id}:`, err);
      }
    }

    if (member?.permissions?.has(PermissionFlagsBits.Administrator)) return;

    // Banning someone who outranks the bot throws; skipping keeps the process
    // alive and surfaces the misconfiguration in the logs instead of crashing.
    if (!member || !member.bannable) {
      console.warn(
        `[ban] Skipping ${message.author.tag} (${message.author.id}) in guild ${message.guildId}: ` +
          'not bannable (outranks bot or unresolved member).',
      );
      return;
    }

    // Delete first so the spam is gone even if the ban call later fails.
    try {
      await message.delete();
    } catch (err) {
      console.warn(`[ban] Failed to delete trigger message ${message.id}:`, err);
    }

    // deleteMessageSeconds purges 7 days of their messages across every channel
    // in the same call, so one ban cleans up an entire mass-spam run.
    try {
      await member.ban({
        deleteMessageSeconds: DELETE_MESSAGE_SECONDS,
        reason: BAN_REASON,
      });
      console.log(
        `[ban] Banned ${message.author.tag} (${message.author.id}) in guild ${message.guildId}.`,
      );
    } catch (err) {
      console.error(
        `[ban] Failed to ban ${message.author.tag} (${message.author.id}) in guild ${message.guildId}:`,
        err,
      );
    }
  } catch (err) {
    // Never let a message handler crash the process.
    console.error('[messageCreate] Unexpected error:', err);
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
(async () => {
  try {
    await store.init();
  } catch (err) {
    console.error('[fatal] Failed to initialize storage:', err);
    process.exit(1);
  }
  try {
    await client.login(TOKEN);
  } catch (err) {
    console.error('[fatal] Failed to log in to Discord (check DISCORD_TOKEN and network):', err);
    process.exit(1);
  }
})();
