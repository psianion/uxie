// Standalone command registration: `bun run deploy`. PUTs the guild command set to the
// dev guild. Uses the same buildScryptModule the bot uses, so the deployed definitions
// can never drift from what the router dispatches. Env is read only via parseEnv (decision 11).
import { REST, Routes, type SlashCommandBuilder } from "discord.js";
import { parseEnv } from "../lib/env.ts";
import { buildScryptModule } from "../integrations/scrypt/index.ts";
import { log } from "../lib/log.ts";

const env = parseEnv();
const scrypt = buildScryptModule(env);

const body = Array.from(scrypt.commands.values()).map((c) =>
  typeof (c.data as SlashCommandBuilder).toJSON === "function"
    ? (c.data as SlashCommandBuilder).toJSON()
    : c.data,
);

const rest = new REST({ version: "10" }).setToken(env.DISCORD_BOT_TOKEN);

log.info("deploying commands", { count: body.length, guild: env.DISCORD_DEV_GUILD_ID });
await rest.put(Routes.applicationGuildCommands(env.DISCORD_APP_ID, env.DISCORD_DEV_GUILD_ID), {
  body,
});
log.info("deploy ok");
