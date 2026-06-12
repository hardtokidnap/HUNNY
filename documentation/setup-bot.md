# Create the Discord bot

Required once, before any hosting method. You end up with a bot token and the
bot invited to your server.

## 1. Create the application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications),
   choose New Application, open the Bot tab, and copy the token.
2. Under Bot, then Privileged Gateway Intents, enable Server Members Intent and
   Message Content Intent.

## 2. Invite the bot

Use the Installation tab (this replaced the manual OAuth2 URL Generator
flow):

1. Under Installation Contexts, check **Guild Install** only. Leave User
   Install unchecked; the bot only works installed to a server.
2. Under Default Install Settings, Guild Install, set scopes
   `applications.commands` and `bot`, and permissions **Ban Members**,
   **Manage Messages**, **View Channel**, **Read Message History**, and
   **Send Messages** (Send Messages is only used for the optional
   `/setup log_channel` notices; you can drop it and grant it per-channel
   instead).
3. Copy the Install Link and open it to add the bot to your server. The same
   link is your permanent, shareable invite.


## 3. Role hierarchy

In Server Settings, then Roles, drag the bot's role above the roles of anyone
it should be able to ban. Bans against higher-or-equal roles silently fail,
which is the most common reason people think the bot is not working.

## 4. Protect the token

Treat the token as a password. Keep it only in the `DISCORD_TOKEN` environment
variable (via `.env` or your host's secret store), never in code or version
control. If it ever leaks, regenerate it in the Developer Portal immediately.

## Next step

Pick a hosting method:

- [Docker / Compose](./setup-docker.md) (recommended)
- [Raspberry Pi / Linux with systemd](./setup-raspberry-pi.md)
- [Heroku](./setup-heroku.md)
- [Manual with Node](./setup-manual.md)
