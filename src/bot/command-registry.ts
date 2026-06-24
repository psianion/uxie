// Single source of the merged slash-command set, shared by BOTH the boot path (src/index.ts)
// and the standalone deploy script (deploy-commands.ts) so the deployed definitions can never
// drift from what the router dispatches. Builds the scrypt + server modules and folds their
// command Collections together via mergeCommands (which throws ConfigError on a cross-module
// name collision). Onboarding contributes NO commands (it is event-driven) and is not included.
import { Collection } from "discord.js";
import type { LoadedCommand } from "./command-loader.ts";
import type { Env } from "../lib/env.ts";
import { buildScryptModule } from "../integrations/scrypt/index.ts";
import { buildServerModule } from "../integrations/server/index.ts";
import { mergeCommands } from "../lib/merge-commands.ts";

export function buildCommandRegistry(env: Env): Collection<string, LoadedCommand> {
  const scrypt = buildScryptModule(env);
  const server = buildServerModule(env);
  return mergeCommands(scrypt.commands, server.commands);
}
