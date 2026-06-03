import {
  ApplicationIntegrationType,
  InteractionContextType,
  type SharedSlashCommand,
} from "discord.js";

/**
 * UXIE-DISCORD-GUIDELINES §6.2 / ratified decision 7 — every slash-command builder
 * must apply these three setters:
 *   - setContexts(InteractionContextType.Guild)
 *   - setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
 *   - setDefaultMemberPermissions(0n)
 * Centralised here so the six command files cannot drift. Mutates and returns the
 * same builder instance for fluent chaining.
 *
 * The bound is `SharedSlashCommand` (the base class carrying these three setters), NOT
 * `SlashCommandBuilder`: after `.addStringOption()` a builder narrows to
 * `SlashCommandOptionsOnlyBuilder`, which still extends `SharedSlashCommand` but is no
 * longer assignable to `SlashCommandBuilder`. Widening here lets option-carrying commands
 * (e.g. /capture) pass through the same gate as option-less ones (/ping).
 */
export function applyDefaultBuilderShape<B extends SharedSlashCommand>(b: B): B {
  b.setContexts(InteractionContextType.Guild);
  b.setIntegrationTypes(ApplicationIntegrationType.GuildInstall);
  b.setDefaultMemberPermissions(0n);
  return b;
}

/**
 * Public name each command file calls. Delegates to applyDefaultBuilderShape so the
 * default-shape setters live in exactly one place (decision 7). Runtime owner
 * enforcement is router-located (decision 9), not here — this only stamps builder shape.
 */
export function withOwnerGate<B extends SharedSlashCommand>(b: B): B {
  return applyDefaultBuilderShape(b);
}
