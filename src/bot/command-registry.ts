// Single source of the merged slash-command set, shared by BOTH the boot path (src/index.ts)
// and the standalone deploy script (deploy-commands.ts) so the deployed definitions can never
// drift from what the router dispatches. Builds the scrypt + server (+ para-raid, when enabled)
// modules and folds their command Collections together via mergeCommands (which throws
// ConfigError on a cross-module name collision). Onboarding contributes NO commands (it is
// event-driven) and is not included.
//
// The boot path passes its already-built `scrypt`/`paraRaid` modules in, so the /ping COMMAND
// and its component (Refresh/Retry) handlers share ONE ScryptRestClient (same reasoning applies
// to para-raid's client/session cache) — otherwise each would build its own, fragmenting live
// state. The deploy script omits both and gets throwaway modules (it only needs command
// definitions, not live clients); /raid is present in the deployed set iff paraRaidEnabled(env)
// (D6) — deploy runs off the same env file as boot, so definitions and runtime stay coherent.
import { Collection } from "discord.js";
import type { LoadedCommand } from "./command-loader.ts";
import { paraRaidEnabled, type Env } from "../lib/env.ts";
import { buildScryptModule } from "../integrations/scrypt/index.ts";
import { buildServerModule } from "../integrations/server/index.ts";
import { buildParaRaidModule } from "../integrations/para-raid/index.ts";
import { buildSupModule } from "../integrations/sup/index.ts";
import { mergeCommands } from "../lib/merge-commands.ts";

export function buildCommandRegistry(
  env: Env,
  scrypt: ReturnType<typeof buildScryptModule> = buildScryptModule(env),
  paraRaid: ReturnType<typeof buildParaRaidModule> | undefined = paraRaidEnabled(env)
    ? buildParaRaidModule(env)
    : undefined,
): Collection<string, LoadedCommand> {
  const server = buildServerModule(env);
  // sup borrows the scrypt/para-raid clients from the modules built above, so /sup status
  // probes the same live connections the per-app commands use (create-once-share-everywhere).
  const sup = buildSupModule(env, scrypt.rest, paraRaid?.client);
  const collections = [scrypt.commands, server.commands, sup.commands];
  if (paraRaid) collections.push(paraRaid.commands);
  return mergeCommands(...collections);
}
