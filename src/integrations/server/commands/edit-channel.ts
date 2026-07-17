// /edit-channel — edit an existing channel's mutable surface (name, topic, slowmode, nsfw,
// parent category, position), then render a Components V2 result panel. Only the options the
// caller actually provided are sent to channel.edit(), so an omitted option never clobbers the
// current value. Auto-defer shape (create-role's reasoning): the ack precedes the unbounded
// channels.edit write, and IsComponentsV2 rides on the editReply.
// NO try/catch in the body — the interaction-router is the single catch site (decision 10).
// Voice channels have no topic/nsfw; Discord rejects those edits server-side, and the topic/
// nsfw options say "text-like channels" so the caller knows before trying.
import { ChannelType, MessageFlags, SlashCommandBuilder } from "discord.js";
import type { GuildChannelEditOptions } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";
import { ConfigError } from "../../../lib/errors.ts";
import { buildStatusContainer } from "../../../lib/ui/status-container.ts";
import type { StatusModel, StatusRow } from "../../../lib/ui/status-container.ts";

const EDITABLE_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildForum,
  ChannelType.GuildAnnouncement,
] as const;

export function buildEditChannelCommand(): LoadedCommand {
  // No defer:false — the router auto-defers so the ack precedes the channels.edit write below.
  const data = new SlashCommandBuilder()
    .setName("edit-channel")
    .setDescription("Edit an existing channel (only the options you provide change)")
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("Channel to edit")
        .addChannelTypes(...EDITABLE_TYPES)
        .setRequired(true),
    )
    .addStringOption((o) => o.setName("name").setDescription("New channel name"))
    .addStringOption((o) =>
      o.setName("topic").setDescription("New topic (text-like channels only)"),
    )
    .addIntegerOption((o) =>
      o
        .setName("slowmode")
        .setDescription("Slowmode in seconds, 0 disables (text-like channels only)")
        .setMinValue(0)
        .setMaxValue(21600),
    )
    .addBooleanOption((o) =>
      o.setName("nsfw").setDescription("Age-restrict the channel (text-like channels only)"),
    )
    .addChannelOption((o) =>
      o
        .setName("category")
        .setDescription("Move the channel under this category")
        .addChannelTypes(ChannelType.GuildCategory),
    )
    .addIntegerOption((o) =>
      o.setName("position").setDescription("New position within its category").setMinValue(0),
    )
    .addStringOption((o) => o.setName("reason").setDescription("Audit-log reason"));

  return {
    data: withOwnerGate(data),
    async execute(i, ctx) {
      const guild = i.guild;
      if (!guild) throw new ConfigError("edit-channel", "no guild context");

      const target = i.options.getChannel("channel", true);
      const name = i.options.getString("name");
      const topic = i.options.getString("topic");
      const slowmode = i.options.getInteger("slowmode");
      const nsfw = i.options.getBoolean("nsfw");
      const category = i.options.getChannel("category");
      const position = i.options.getInteger("position");
      const reason = i.options.getString("reason");

      const edits: GuildChannelEditOptions = {
        ...(name !== null ? { name } : {}),
        ...(topic !== null ? { topic } : {}),
        ...(slowmode !== null ? { rateLimitPerUser: slowmode } : {}),
        ...(nsfw !== null ? { nsfw } : {}),
        ...(category !== null ? { parent: category.id } : {}),
        ...(position !== null ? { position } : {}),
        ...(reason !== null ? { reason } : {}),
      };
      // `reason` alone edits nothing — require at least one actual change.
      const changedKeys = Object.keys(edits).filter((k) => k !== "reason");
      if (changedKeys.length === 0) {
        throw new ConfigError("edit-channel", "provide at least one option to change");
      }

      const channel = await guild.channels.edit(target.id, edits);

      const rows: StatusRow[] = [{ icon: "🏷", label: "Channel", value: `<#${channel.id}>` }];
      if (name !== null) rows.push({ icon: "✏️", label: "Name", value: name });
      if (topic !== null) rows.push({ icon: "📝", label: "Topic", value: topic || "(cleared)" });
      if (slowmode !== null)
        rows.push({ icon: "🐌", label: "Slowmode", value: slowmode === 0 ? "off" : `${slowmode}s` });
      if (nsfw !== null) rows.push({ icon: "🔞", label: "NSFW", value: nsfw ? "yes" : "no" });
      if (category !== null)
        rows.push({ icon: "📁", label: "Category", value: category.name ?? category.id });
      if (position !== null) rows.push({ icon: "🔢", label: "Position", value: String(position) });

      const model: StatusModel = {
        title: "Channel updated",
        health: "ok",
        badge: `<#${channel.id}>`,
        rows,
        footer: `${changedKeys.length} field(s) changed in ${guild.name}`,
      };

      await i.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [buildStatusContainer(model)],
      });

      ctx.log.info("channel edited", { channelId: channel.id, changed: changedKeys });
    },
  };
}
