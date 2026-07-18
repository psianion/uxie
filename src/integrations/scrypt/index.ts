// scrypt module entry. Builds the client from validated env and the command collection; the
// boot path wires the command collection into the interaction-router. Commands: /ping (health
// panel), /capture (MCP create_note → projects/_inbox), /journal (journal append), /search
// (hybrid search + confidence gate), /brief (daily context), /archive-thread (thread transcript
// → vault note). Always on: SCRYPT_SERVER_URL +
// SCRYPT_AUTH are required env, so there is no feature flag to check.
import { hostname } from "node:os";
import { Collection } from "discord.js";
import { buildCommandCollection, type LoadedCommand } from "../../bot/command-loader.ts";
import type { ComponentHandler } from "../../bot/interaction-router.ts";
import { ScryptRestClient } from "./rest-client.ts";
import { buildPingCommand } from "./commands/ping.ts";
import { buildCaptureCommand } from "./commands/capture.ts";
import { buildJournalCommand } from "./commands/journal.ts";
import { buildSearchCommand } from "./commands/search.ts";
import { buildBriefCommand } from "./commands/brief.ts";
import { buildArchiveThreadCommand } from "./commands/archive-thread.ts";
import { buildPingComponentHandler } from "./ping/handler.ts";
import { buildJournalComponentHandler } from "./journal/handler.ts";
import type { Env } from "../../lib/env.ts";

export interface ScryptModule {
  commands: Collection<string, LoadedCommand>;
  components: Collection<string, ComponentHandler>;
  rest: ScryptRestClient;
}

const VERSION = "0.1.0";

export function buildScryptModule(env: Env): ScryptModule {
  const rest = new ScryptRestClient(env.SCRYPT_SERVER_URL, env.SCRYPT_AUTH);

  const pingOpts = {
    version: VERSION,
    scryptHost: new URL(env.SCRYPT_SERVER_URL).host,
    allowRestart: env.ALLOW_SCRYPT_RESTART,
    // "<env label> · <machine hostname>" — tells you at a glance whether the responding
    // instance is local or the VPS (a token holds one live gateway connection at a time).
    host: `${env.UXIE_ENV} · ${hostname()}`,
  };

  const cmds: LoadedCommand[] = [
    buildPingCommand(rest, pingOpts),
    buildCaptureCommand(rest),
    buildJournalCommand(rest),
    buildSearchCommand(rest),
    buildBriefCommand(rest),
    buildArchiveThreadCommand(rest),
  ];

  // Restart deps are wired ONLY when the capability is enabled; secrets are passed so any
  // restart stderr surfaced to the owner is redacted of them.
  const pingHandler = buildPingComponentHandler(
    rest,
    pingOpts,
    env.ALLOW_SCRYPT_RESTART
      ? { command: env.SCRYPT_RESTART_CMD, secrets: [env.SCRYPT_AUTH, env.DISCORD_BOT_TOKEN] }
      : undefined,
  );
  const components = new Collection<string, ComponentHandler>();
  components.set(pingHandler.namespace, pingHandler);
  // /journal read's prev/next day buttons (journal:day:<date>).
  const journalHandler = buildJournalComponentHandler(rest);
  components.set(journalHandler.namespace, journalHandler);

  return {
    commands: buildCommandCollection(cmds),
    components,
    rest,
  };
}
