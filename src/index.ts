// Boot. Catch site #3 of 3 (decision 10): top-level process handlers log + exit(1) so
// Docker restarts the process — uxie is stateless, so a clean restart loses nothing.
// SIGTERM/SIGINT (decision 16): destroy the gateway connection, then exit(0).
import { Events } from "discord.js";
import { parseEnv, paraRaidEnabled } from "./lib/env.ts";
import { assertGuildConfig, guildConfig } from "./config/guild.ts";
import { log, setLogSink } from "./lib/log.ts";
import { createDiscordLogSink, type LogSinkChannel } from "./lib/discord-log-sink.ts";
import { createDiscordClient } from "./bot/client.ts";
import { handleInteraction } from "./bot/interaction-router.ts";
import { buildScryptModule } from "./integrations/scrypt/index.ts";
import { buildCommandRegistry } from "./bot/command-registry.ts";
import { buildOnboardingModule } from "./integrations/onboarding/index.ts";
import { buildParaRaidModule, startParaRaidRuntime } from "./integrations/para-raid/index.ts";

// Active Discord log sink (set at ClientReady when guildConfig.logChannelId is configured). The
// crash handlers flush it best-effort before exit so the last warn/error reaches the channel.
let logSink: ReturnType<typeof createDiscordLogSink> | null = null;

function flushSinkThenExit(code: number): void {
  const done = logSink ? logSink.flush() : Promise.resolve();
  const cap = new Promise<void>((res) => setTimeout(res, 1000)); // never hang the crash path
  void Promise.race([done, cap]).finally(() => process.exit(code));
}

process.on("uncaughtException", (err) => {
  log.error("uncaughtException", { err });
  flushSinkThenExit(1);
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", { err: reason });
  flushSinkThenExit(1);
});

let env;
try {
  env = parseEnv();
  // Guild structure is not a secret, so it does not go through env.ts — validate it here,
  // right after parseEnv(), in the same fail-fast try/catch. assertGuildConfig() throws a
  // ConfigError naming the offending field (e.g. an unfilled placeholder snowflake).
  assertGuildConfig();
} catch (err) {
  // ConfigError names the offending field; exit 1 so the operator knows boot misconfig.
  log.error("config error — exiting", { err });
  process.exit(1);
}

// D5: message intents ride on the same flag that gates the whole para-raid module — v1
// deployments (env group unset) keep today's minimal intent set.
const relayEnabled = paraRaidEnabled(env);
const client = createDiscordClient(relayEnabled);
// Build the scrypt module ONCE and share it with the command registry, so the /ping command and
// its component (Refresh/Retry) handlers use the SAME ScryptRestClient. Building it twice would
// duplicate the clients and fragment live state (e.g. connectivity up/down tracking). Same
// reasoning for para-raid: build once, share with both the registry and the runtime below.
const scrypt = buildScryptModule(env);
const paraRaid = relayEnabled ? buildParaRaidModule(env) : undefined;
const allCommands = buildCommandRegistry(env, scrypt, paraRaid);
// Registers GuildMemberAdd (guest-role assignment) + the ready-time #welcome reconcile, and
// returns the two button handlers the router dispatches the onboard: namespace to.
const onboarding = buildOnboardingModule(env, client);
// A10: registers the MessageCreate relay now and starts the webhook receiver at ClientReady
// (ready-or-once, mirrors buildOnboardingModule above). No-op (paraRaidRuntime stays undefined)
// when the module is off.
const paraRaidRuntime = paraRaid ? startParaRaidRuntime(paraRaid, client, env) : undefined;

client.once(Events.ClientReady, async (c) => {
  log.info("uxie ready", { tag: c.user.tag, guild: env.DISCORD_DEV_GUILD_ID });

  // Attach the live log sink only if the operator pointed logChannelId at a real, sendable channel.
  // On any failure, log to stdout (sink not yet attached) and leave mirroring off — boot continues.
  if (guildConfig.logChannelId) {
    try {
      const ch = await c.channels.fetch(guildConfig.logChannelId);
      if (ch && ch.isTextBased() && ch.isSendable()) {
        logSink = createDiscordLogSink(ch as unknown as LogSinkChannel);
        setLogSink(logSink.onEntry);
        log.info("log sink attached", { channelId: guildConfig.logChannelId });
      } else {
        log.error("log sink channel not sendable", { channelId: guildConfig.logChannelId });
      }
    } catch (err) {
      log.error("log sink channel fetch failed", { channelId: guildConfig.logChannelId, err });
    }
  }
});

client.on(Events.InteractionCreate, async (i) => {
  await handleInteraction(i, allCommands, env.DISCORD_OWNER_ID, {
    components: scrypt.components,
    devGuildId: env.DISCORD_DEV_GUILD_ID,
    onboarding,
  });
});

// Stateless shutdown (decision 16): no caches/queues/scheduler to drain — just close the
// gateway and exit cleanly. A10: also stop the para-raid webhook receiver, if it was started.
async function shutdown(signal: string): Promise<void> {
  log.info("shutting down", { signal });
  paraRaidRuntime?.stop();
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
