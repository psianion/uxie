// Merge per-module command collections into one; fail on cross-module name collision.
// The cross-module analogue of buildCommandCollection's intra-module guard, but throws
// ConfigError (config/registry fault) rather than a plain Error.
import { Collection } from "discord.js";
import type { LoadedCommand } from "../bot/command-loader.ts";
import { ConfigError } from "./errors.ts";

export function mergeCommands(
  ...collections: Collection<string, LoadedCommand>[]
): Collection<string, LoadedCommand> {
  const merged = new Collection<string, LoadedCommand>();
  for (const col of collections) {
    for (const [name, cmd] of col) {
      if (merged.has(name)) {
        throw new ConfigError(
          "command_registry",
          `duplicate command name across modules: ${name}`,
        );
      }
      merged.set(name, cmd);
    }
  }
  return merged;
}
