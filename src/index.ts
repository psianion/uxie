// Placeholder boot — verifies env parsing in dev. The full src/index.ts (client
// construction, top-level process.on("uncaughtException"/"unhandledRejection")
// registrations, SIGTERM/SIGINT, and integration wiring) lands in a later wave
// (ratified decisions 10 + 16).
import { parseEnv } from "./lib/env.ts";
import { log } from "./lib/log.ts";

try {
  const env = parseEnv();
  log.info("uxie boot — env valid", { guild: env.DISCORD_DEV_GUILD_ID });
  process.exit(0);
} catch (err) {
  log.error("boot failed", { err });
  process.exit(1);
}
