// Standalone command registration: `bun run deploy`. PUTs the guild command set to the
// dev guild. Uses the same buildCommandRegistry the bot uses (scrypt + server, merged), so
// the deployed definitions can never drift from what the router dispatches. Registers
// /ping, /create-category, /create-channel. Env is read only via parseEnv (decision 11).
import { REST, Routes, type SlashCommandBuilder } from "discord.js";
import { parseEnv } from "../lib/env.ts";
import { buildCommandRegistry, buildMessageCommandRegistry } from "./command-registry.ts";
import { log } from "../lib/log.ts";

const env = parseEnv();
const commands = buildCommandRegistry(env);
const messageCommands = buildMessageCommandRegistry(env);

const body = [
  ...Array.from(commands.values()).map((c) =>
    typeof (c.data as SlashCommandBuilder).toJSON === "function"
      ? (c.data as SlashCommandBuilder).toJSON()
      : c.data,
  ),
  // Context-menu commands share the same PUT — Discord distinguishes them by `type`.
  ...Array.from(messageCommands.values()).map((c) => c.data.toJSON()),
];

const rest = new REST({ version: "10" }).setToken(env.DISCORD_BOT_TOKEN);

log.info("deploying commands", { count: body.length, guild: env.DISCORD_DEV_GUILD_ID });
await rest.put(Routes.applicationGuildCommands(env.DISCORD_APP_ID, env.DISCORD_DEV_GUILD_ID), {
  body,
});
log.info("deploy ok");
