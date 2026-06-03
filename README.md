# uxie

Single-user Discord bot hosting outward-facing modules (scrypt in v1).

## Discord prerequisites

1. Create an application at https://discord.com/developers/applications
2. Create a bot user; copy the token → `.env` `DISCORD_BOT_TOKEN`
3. Copy the application id → `DISCORD_APP_ID`
4. **Enable the `MessageContent` privileged intent** on the Bot page. Without this, `#inbox` capture will not see message bodies.
5. Invite the bot to a test guild with scopes `bot` + `applications.commands`
6. Copy the guild id → `DISCORD_DEV_GUILD_ID`
7. Create a channel named `#inbox`; copy its id → `INBOX_CHANNEL_ID`
8. Copy your own user id → `DISCORD_OWNER_ID`

## Scrypt prerequisites

- Scrypt running and reachable at `SCRYPT_SERVER_URL` / `SCRYPT_MCP_URL`
- A valid `SCRYPT_AUTH` bearer token

## Run

```
cp .env.example .env   # fill in values
bun install
bun run deploy         # register slash commands to the dev guild
docker compose up uxie
```
