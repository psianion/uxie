// /delete-role — delete a guild role. Destructive, so it carries delete-channel's required
// `confirm: True` guard. @everyone and managed (integration) roles are rejected with a named
// reason before Discord would 400. Auto-defer + V2-on-editReply shape.
// NO try/catch in the body — the interaction-router is the single catch site (decision 10).
import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";
import { ConfigError } from "../../../lib/errors.ts";
import { buildStatusContainer } from "../../../lib/ui/status-container.ts";
import type { StatusModel, StatusRow } from "../../../lib/ui/status-container.ts";

export function buildDeleteRoleCommand(): LoadedCommand {
  const data = new SlashCommandBuilder()
    .setName("delete-role")
    .setDescription("Delete a role (irreversible)")
    .addRoleOption((o) => o.setName("role").setDescription("Role to delete").setRequired(true))
    .addBooleanOption((o) =>
      o
        .setName("confirm")
        .setDescription("Set to True to confirm — deletion cannot be undone")
        .setRequired(true),
    )
    .addStringOption((o) => o.setName("reason").setDescription("Audit-log reason"));

  return {
    data: withOwnerGate(data),
    async execute(i, ctx) {
      const guild = i.guild;
      if (!guild) throw new ConfigError("delete-role", "no guild context");

      const target = i.options.getRole("role", true);
      const confirm = i.options.getBoolean("confirm", true);
      const reason = i.options.getString("reason");

      if (!confirm) {
        throw new ConfigError("delete-role", "not confirmed — set confirm to True to delete");
      }
      if (target.id === guild.id) {
        throw new ConfigError("delete-role", "@everyone cannot be deleted");
      }
      if (target.managed) {
        throw new ConfigError("delete-role", "managed (integration) roles cannot be deleted");
      }

      // Snapshot the label before deletion — the mention would render as "@deleted-role".
      const label = target.name;

      await guild.roles.delete(target.id, reason ?? undefined);

      const rows: StatusRow[] = [
        { icon: "🗑", label: "Deleted", value: `@${label}` },
        { icon: "🆔", label: "Role ID", value: target.id },
      ];
      if (reason !== null) rows.push({ icon: "📋", label: "Reason", value: reason });

      const model: StatusModel = {
        title: "Role deleted",
        health: "ok",
        badge: `@${label}`,
        rows,
        footer: `deleted from ${guild.name}`,
      };

      await i.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [buildStatusContainer(model)],
      });

      ctx.log.info("role deleted", { roleId: target.id, name: label });
    },
  };
}
