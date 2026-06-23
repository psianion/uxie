// Boot. Catch site #3 of 3 (decision 10): top-level process handlers log + exit(1) so
// Docker restarts the process — uxie is stateless, so a clean restart loses nothing.
// SIGTERM/SIGINT (decision 16): destroy the gateway connection, then exit(0).
import { Events } from "discord.js";
import { parseEnv } from "./lib/env.ts";
import { log } from "./lib/log.ts";
import { createDiscordClient } from "./bot/client.ts";
import { handleInteraction } from "./bot/interaction-router.ts";
import { buildScryptModule } from "./integrations/scrypt/index.ts";

process.on("uncaughtException", (err) => {
  log.error("uncaughtException", { err });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", { err: reason });
  process.exit(1);
});

let env;
try {
  env = parseEnv();
} catch (err) {
  // ConfigError names the offending field; exit 1 so the operator knows boot misconfig.
  log.error("config error — exiting", { err });
  process.exit(1);
}

const client = createDiscordClient();
const scrypt = buildScryptModule(env);

client.once(Events.ClientReady, (c) => {
  log.info("uxie ready", { tag: c.user.tag, guild: env.DISCORD_DEV_GUILD_ID });
});

client.on(Events.InteractionCreate, async (i) => {
  await handleInteraction(i, scrypt.commands, env.DISCORD_OWNER_ID, {
    components: scrypt.components,
    devGuildId: env.DISCORD_DEV_GUILD_ID,
  });
});

// Stateless shutdown (decision 16): no caches/queues/scheduler to drain — just close the
// gateway and exit cleanly.
async function shutdown(signal: string): Promise<void> {
  log.info("shutting down", { signal });
  await client.destroy();
  process.exit(0);
}
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

await client.login(env.DISCORD_BOT_TOKEN);
