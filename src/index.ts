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
import { buildCommandRegistry, buildMessageCommandRegistry } from "./bot/command-registry.ts";
import { buildOnboardingModule } from "./integrations/onboarding/index.ts";
import { buildParaRaidModule, startParaRaidRuntime } from "./integrations/para-raid/index.ts";
import { startWatchdog } from "./integrations/sup/watchdog.ts";
import { startJournalMirror } from "./integrations/journal/capture.ts";
import { startJournalRituals } from "./integrations/journal/rituals.ts";

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

// D5: message intents are needed by the para-raid relay AND the journal mirror — on iff either
// feature is; deployments with both off keep today's minimal intent set.
const relayEnabled = paraRaidEnabled(env);
const journalMirrorOn = Boolean(guildConfig.journalChannelId);
const client = createDiscordClient(relayEnabled || journalMirrorOn);
// Build the scrypt module ONCE and share it with the command registry, so the /ping command and
// its component (Refresh/Retry) handlers use the SAME ScryptRestClient. Building it twice would
// duplicate the clients and fragment live state (e.g. connectivity up/down tracking). Same
// reasoning for para-raid: build once, share with both the registry and the runtime below.
const scrypt = buildScryptModule(env);
const paraRaid = relayEnabled ? buildParaRaidModule(env) : undefined;
const allCommands = buildCommandRegistry(env, scrypt, paraRaid);
// Message context-menu commands (triage) — empty Collection when para-raid is off or no
// triage channel is configured, so the router path is inert rather than conditional.
const messageCommands = buildMessageCommandRegistry(env, paraRaid);
// Registers GuildMemberAdd (guest-role assignment) + the ready-time #welcome reconcile, and
// returns the two button handlers the router dispatches the onboard: namespace to.
const onboarding = buildOnboardingModule(env, client);
// A10: registers the MessageCreate relay now and starts the webhook receiver at ClientReady
// (ready-or-once, mirrors buildOnboardingModule above). No-op (paraRaidRuntime stays undefined)
// when the module is off.
const paraRaidRuntime = paraRaid ? startParaRaidRuntime(paraRaid, client, env) : undefined;
// Journal mirror listeners register at boot (like the relay); rituals start at ready below
// (they need the channel fetched).
const journalMirror = journalMirrorOn
  ? startJournalMirror(client, scrypt.rest, {
      channelId: guildConfig.journalChannelId,
      ownerId: env.DISCORD_OWNER_ID,
    })
  : undefined;
let journalRituals: ReturnType<typeof startJournalRituals> | null = null;

// SUP watchdog: probes scrypt/para-raid every 5 min and logs down/recovered transitions at
// warn/notice, which the sink below mirrors to the logs channel. Started at ready so the sink
// is (about to be) attached when the first transition can fire; stopped in shutdown().
let watchdog: ReturnType<typeof startWatchdog> | null = null;

client.once(Events.ClientReady, async (c) => {
  // Attach the live log sink only if the operator pointed logChannelId at a real, sendable channel.
  // On any failure, log to stdout (sink not yet attached) and leave mirroring off — boot continues.
  // Attached FIRST so the ready notice below (and any immediate watchdog transition) is mirrored.
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

  // notice, not info: a (re)boot is a notable event the logs channel should show.
  log.notice("uxie ready", { tag: c.user.tag, guild: env.DISCORD_DEV_GUILD_ID });
  watchdog = startWatchdog(scrypt.rest, paraRaid?.client);

  // Journal rituals: morning briefing / evening nudge / weekly digest into the journal channel.
  // Same degrade-don't-crash contract as the log sink: an unusable channel logs and skips.
  if (journalMirrorOn) {
    try {
      const ch = await c.channels.fetch(guildConfig.journalChannelId);
      if (ch && ch.isTextBased() && ch.isSendable() && "threads" in ch) {
        journalRituals = startJournalRituals(
          scrypt.rest,
          paraRaid?.client,
          { send: (content) => ch.send(content), createThread: (o) => ch.threads.create(o) },
          { ...guildConfig.journalRituals, bundle: guildConfig.triageBundle || undefined },
        );
        log.info("journal rituals started", { channelId: guildConfig.journalChannelId });
      } else {
        log.error("journal channel not usable — rituals off", { channelId: guildConfig.journalChannelId });
      }
    } catch (err) {
      log.error("journal channel fetch failed — rituals off", { channelId: guildConfig.journalChannelId, err });
    }
  }
});

client.on(Events.InteractionCreate, async (i) => {
  await handleInteraction(i, allCommands, env.DISCORD_OWNER_ID, {
    components: scrypt.components,
    devGuildId: env.DISCORD_DEV_GUILD_ID,
    onboarding,
    messageCommands,
  });
});

// Stateless shutdown (decision 16): no caches/queues/scheduler to drain — just close the
// gateway and exit cleanly. A10: also stop the para-raid webhook receiver, if it was started.
async function shutdown(signal: string): Promise<void> {
  log.info("shutting down", { signal });
  watchdog?.stop();
  journalRituals?.stop();
  journalMirror?.stop();
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
