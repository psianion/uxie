// /delete-channel — delete a channel or category. Destructive and unrecoverable, so the
// builder carries a required `confirm` boolean that must be literally true — a deliberate
// second keystroke, not a modal (owner-gated already; a full confirm flow would be ceremony).
// Deleting a category does NOT delete its children; Discord re-homes them to no category, and
// the panel says so when the target is a category. Auto-defer + V2-on-editReply shape.
// NO try/catch in the body — the interaction-router is the single catch site (decision 10).
import { ChannelType, MessageFlags, SlashCommandBuilder } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";
import { ConfigError } from "../../../lib/errors.ts";
import { buildStatusContainer } from "../../../lib/ui/status-container.ts";
import type { StatusModel, StatusRow } from "../../../lib/ui/status-container.ts";

const DELETABLE_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildForum,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildCategory,
] as const;

export function buildDeleteChannelCommand(): LoadedCommand {
  const data = new SlashCommandBuilder()
    .setName("delete-channel")
    .setDescription("Delete a channel or category (irreversible)")
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("Channel or category to delete")
        .addChannelTypes(...DELETABLE_TYPES)
        .setRequired(true),
    )
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
      if (!guild) throw new ConfigError("delete-channel", "no guild context");

      const target = i.options.getChannel("channel", true);
      const confirm = i.options.getBoolean("confirm", true);
      const reason = i.options.getString("reason");

      if (!confirm) {
        throw new ConfigError("delete-channel", "not confirmed — set confirm to True to delete");
      }

      const isCategory = target.type === ChannelType.GuildCategory;
      // Snapshot the label before deletion — the mention would render as "#deleted-channel".
      const label = target.name ?? target.id;

      await guild.channels.delete(target.id, reason ?? undefined);

      const rows: StatusRow[] = [
        { icon: "🗑", label: "Deleted", value: `#${label}` },
        { icon: "🆔", label: "Channel ID", value: target.id },
      ];
      if (isCategory) {
        rows.push({
          icon: "📁",
          label: "Note",
          value: "children were re-homed to no category, not deleted",
        });
      }
      if (reason !== null) rows.push({ icon: "📋", label: "Reason", value: reason });

      const model: StatusModel = {
        title: isCategory ? "Category deleted" : "Channel deleted",
        health: "ok",
        badge: `#${label}`,
        rows,
        footer: `deleted from ${guild.name}`,
      };

      await i.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [buildStatusContainer(model)],
      });

      ctx.log.info("channel deleted", { channelId: target.id, name: label, isCategory });
    },
  };
}
