// /purge — bulk-delete recent messages in a text channel, optionally filtered to one author.
// Uses bulkDelete(…, true): Discord's bulk endpoint silently cannot touch messages older than
// 14 days, so filterOld skips them instead of erroring — the panel reports the ACTUAL deleted
// count, which may be lower than requested (old messages, or fewer matching the author).
// With a user filter the last 100 messages are fetched and the newest `count` from that author
// are deleted — "count from the last 100", not "search all history" (bounded by design).
// Auto-defer + V2-on-editReply shape; requires confirm like the other destructive commands? No —
// purge is bounded (≤100, ≤14 days) and routine moderation; a confirm would just add friction.
// NO try/catch in the body — the interaction-router is the single catch site (decision 10).
import { ChannelType, MessageFlags, SlashCommandBuilder } from "discord.js";
import type { TextChannel } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";
import { ConfigError } from "../../../lib/errors.ts";
import { buildStatusContainer } from "../../../lib/ui/status-container.ts";
import type { StatusModel, StatusRow } from "../../../lib/ui/status-container.ts";

export function buildPurgeCommand(): LoadedCommand {
  const data = new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Bulk-delete recent messages (≤100, none older than 14 days)")
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("Text channel to purge")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    )
    .addIntegerOption((o) =>
      o
        .setName("count")
        .setDescription("How many recent messages to delete (1-100)")
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true),
    )
    .addUserOption((o) =>
      o.setName("user").setDescription("Only delete messages from this user (last 100 scanned)"),
    );

  return {
    data: withOwnerGate(data),
    async execute(i, ctx) {
      const guild = i.guild;
      if (!guild) throw new ConfigError("purge", "no guild context");

      const target = i.options.getChannel("channel", true);
      const count = i.options.getInteger("count", true);
      const user = i.options.getUser("user");

      const channel = (await guild.channels.fetch(target.id)) as TextChannel | null;
      if (!channel || channel.type !== ChannelType.GuildText) {
        throw new ConfigError("purge", "channel is not a text channel");
      }

      let deletedCount: number;
      if (user) {
        const recent = await channel.messages.fetch({ limit: 100 });
        const fromUser = [...recent.values()]
          .filter((m) => m.author.id === user.id)
          .slice(0, count);
        const deleted = await channel.bulkDelete(fromUser, true);
        deletedCount = deleted.size;
      } else {
        const deleted = await channel.bulkDelete(count, true);
        deletedCount = deleted.size;
      }

      const rows: StatusRow[] = [
        { icon: "🧹", label: "Channel", value: `<#${channel.id}>` },
        { icon: "🔢", label: "Deleted", value: `${deletedCount} of ${count} requested` },
      ];
      if (user) rows.push({ icon: "👤", label: "Author filter", value: `<@${user.id}>` });
      if (deletedCount < count) {
        rows.push({
          icon: "ℹ️",
          label: "Note",
          value: user
            ? "fewer matching messages in the last 100, or some were older than 14 days"
            : "some messages were older than 14 days (bulk delete cannot touch them)",
        });
      }

      const model: StatusModel = {
        title: "Purge complete",
        health: "ok",
        badge: `${deletedCount} deleted`,
        rows,
        footer: `purged in ${guild.name}`,
      };

      await i.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [buildStatusContainer(model)],
      });

      ctx.log.info("purge", { channelId: channel.id, requested: count, deleted: deletedCount });
    },
  };
}
