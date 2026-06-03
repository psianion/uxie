// Command collection builder. Each module hands buildScryptModule a list of
// LoadedCommand; this folds them into a name-keyed Collection and rejects duplicate
// names at boot (fail fast rather than silently shadowing). The CommandContext is the
// per-invocation handle the router passes into execute: the deterministic clientTag
// (decision 3) plus the interaction-scoped child logger (decision 4).
import {
  Collection,
  type ChatInputCommandInteraction,
  type SlashCommandBuilder,
} from "discord.js";

interface ScopedLogger {
  info: (m: string, f?: Record<string, unknown>) => void;
  warn: (m: string, f?: Record<string, unknown>) => void;
  error: (m: string, f?: Record<string, unknown>) => void;
}

export interface CommandContext {
  clientTag: string;
  log: ScopedLogger;
}

export interface LoadedCommand {
  data: SlashCommandBuilder | { name: string };
  execute: (i: ChatInputCommandInteraction, ctx: CommandContext) => Promise<void>;
}

export function buildCommandCollection(cmds: LoadedCommand[]): Collection<string, LoadedCommand> {
  const c = new Collection<string, LoadedCommand>();
  for (const cmd of cmds) {
    const name = cmd.data.name;
    if (c.has(name)) throw new Error(`duplicate command name: ${name}`);
    c.set(name, cmd);
  }
  return c;
}
