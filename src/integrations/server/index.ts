// server module entry. Assembles the /create-category + /create-channel commands into a
// name-keyed Collection (shape mirrors ScryptModule.commands) so the merged command registry
// can fold it together with scrypt's. `env` is accepted for symmetry with buildScryptModule(env)
// even though it is unused here — the commands read guildConfig directly via permissions.ts. Does
// NOT read process.env (decision 11).
import { Collection } from "discord.js";
import { buildCommandCollection, type LoadedCommand } from "../../bot/command-loader.ts";
import type { Env } from "../../lib/env.ts";
import { buildCreateCategoryCommand } from "./commands/create-category.ts";
import { buildCreateChannelCommand } from "./commands/create-channel.ts";
import { buildCreateRoleCommand } from "./commands/create-role.ts";

export function buildServerModule(
  _env: Env,
): { commands: Collection<string, LoadedCommand> } {
  const cmds: LoadedCommand[] = [
    buildCreateCategoryCommand(),
    buildCreateChannelCommand(),
    buildCreateRoleCommand(),
  ];
  return { commands: buildCommandCollection(cmds) };
}
