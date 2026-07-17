// /list-structure — read-only overview of the guild: one row per category (children inline),
// a row for uncategorized channels, and a roles summary. Rendered through the same StatusModel
// kit as every other panel — a category is a row whose value is its child list, so no new UI
// primitives. Values are clipped ("+N more") to stay far inside the 4000-char container limit:
// this is an orientation glance, not an export.
// Reads only — fetches live channel/role state so the panel can't show stale cache.
// NO try/catch in the body — the interaction-router is the single catch site (decision 10).
import { ChannelType, MessageFlags, SlashCommandBuilder } from "discord.js";
import type { NonThreadGuildBasedChannel } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";
import { ConfigError } from "../../../lib/errors.ts";
import { buildStatusContainer } from "../../../lib/ui/status-container.ts";
import type { StatusModel, StatusRow } from "../../../lib/ui/status-container.ts";

const MAX_VALUE_CHARS = 160;

const TYPE_ICON: Partial<Record<ChannelType, string>> = {
  [ChannelType.GuildText]: "#",
  [ChannelType.GuildAnnouncement]: "📣",
  [ChannelType.GuildVoice]: "🔊",
  [ChannelType.GuildForum]: "💬",
  [ChannelType.GuildStageVoice]: "🎙",
};

function clip(names: string[]): string {
  if (names.length === 0) return "(empty)";
  let out = "";
  for (let n = 0; n < names.length; n++) {
    const next = out ? `${out} · ${names[n]}` : names[n]!;
    if (next.length > MAX_VALUE_CHARS) return `${out} +${names.length - n} more`;
    out = next;
  }
  return out;
}

function channelLabel(c: NonThreadGuildBasedChannel): string {
  return `${TYPE_ICON[c.type] ?? "#"}${c.name}`;
}

export function buildListStructureCommand(): LoadedCommand {
  return {
    data: withOwnerGate(
      new SlashCommandBuilder()
        .setName("list-structure")
        .setDescription("Overview of categories, channels, and roles"),
    ),
    async execute(i, ctx) {
      const guild = i.guild;
      if (!guild) throw new ConfigError("list-structure", "no guild context");

      const channels = await guild.channels.fetch();
      const roles = await guild.roles.fetch();

      const all = [...channels.values()].filter(
        (c): c is NonThreadGuildBasedChannel => c !== null,
      );
      const categories = all
        .filter((c) => c.type === ChannelType.GuildCategory)
        .sort((a, b) => a.position - b.position);

      const rows: StatusRow[] = [];
      for (const cat of categories) {
        const children = all
          .filter((c) => c.parentId === cat.id)
          .sort((a, b) => a.position - b.position);
        rows.push({ icon: "📁", label: cat.name, value: clip(children.map(channelLabel)) });
      }

      const orphans = all.filter(
        (c) => c.type !== ChannelType.GuildCategory && c.parentId === null,
      );
      if (orphans.length > 0) {
        rows.push({ icon: "📂", label: "(no category)", value: clip(orphans.map(channelLabel)) });
      }

      // Roles: position order (highest first, how the sidebar shows them), @everyone omitted,
      // managed roles marked — they're visible but not editable.
      const roleList = [...roles.values()]
        .filter((r) => r.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .map((r) => (r.managed ? `${r.name}*` : r.name));
      rows.push({ icon: "🛡", label: `Roles (${roleList.length})`, value: clip(roleList) });

      const channelCount = all.filter((c) => c.type !== ChannelType.GuildCategory).length;
      const model: StatusModel = {
        title: "Server structure",
        health: "ok",
        badge: guild.name,
        rows,
        footer: `${categories.length} categories · ${channelCount} channels · ${roleList.length} roles (* = managed)`,
      };

      await i.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [buildStatusContainer(model)],
      });

      ctx.log.info("structure listed", {
        categories: categories.length,
        channels: channelCount,
        roles: roleList.length,
      });
    },
  };
}
