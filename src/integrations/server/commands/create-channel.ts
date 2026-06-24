// /create-channel — create a channel inside a category. The `category` option is restricted to
// GuildCategory channels via addChannelTypes; the `type` option carries the four string choices
// (text|voice|forum|announcement) mapped through mapChannelType. Voice channels OMIT topic and
// slowmode. The router has already deferReply'd ephemerally, so the body replies via i.editReply.
// NO try/catch in the command body — interaction-router is the only catch site (decision 10).
import { ChannelType, SlashCommandBuilder } from "discord.js";
import type { GuildChannelCreateOptions } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";
import { ConfigError } from "../../../lib/errors.ts";
import { mapChannelType } from "../channel-type.ts";
import { buildPrivateOverwrites } from "../permissions.ts";

export function buildCreateChannelCommand(): LoadedCommand {
  return {
    data: withOwnerGate(
      new SlashCommandBuilder()
        .setName("create-channel")
        .setDescription("Create a channel inside a category")
        .addStringOption((o) =>
          o.setName("name").setDescription("Channel name").setRequired(true),
        )
        .addChannelOption((o) =>
          o
            .setName("category")
            .setDescription("Parent category")
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName("type")
            .setDescription("Channel type")
            .setRequired(true)
            .addChoices(
              { name: "text", value: "text" },
              { name: "voice", value: "voice" },
              { name: "forum", value: "forum" },
              { name: "announcement", value: "announcement" },
            ),
        )
        .addStringOption((o) =>
          o.setName("topic").setDescription("Channel topic (text-like channels only)"),
        )
        .addIntegerOption((o) =>
          o
            .setName("slowmode")
            .setDescription("Slowmode seconds (text-like channels only)"),
        )
        .addBooleanOption((o) =>
          o.setName("private").setDescription("Hide from @everyone"),
        )
        .addBooleanOption((o) => o.setName("nsfw").setDescription("Mark as NSFW"))
        .addRoleOption((o) =>
          o.setName("access_role").setDescription("Role granted access when private"),
        )
        .addRoleOption((o) =>
          o.setName("access_role_2").setDescription("Additional role granted access when private"),
        )
        .addRoleOption((o) =>
          o.setName("access_role_3").setDescription("Additional role granted access when private"),
        ),
    ),
    async execute(i, ctx) {
      const guild = i.guild;
      if (!guild) throw new ConfigError("create_channel", "no guild context");

      const name = i.options.getString("name", true);
      const category = i.options.getChannel("category", true);
      const parent = category.id;
      const typeChoice = i.options.getString("type", true);
      const channelType = mapChannelType(typeChoice);

      const topic = i.options.getString("topic");
      const slowmode = i.options.getInteger("slowmode");
      const isPrivate = i.options.getBoolean("private") ?? false;
      const nsfw = i.options.getBoolean("nsfw") ?? false;

      // Collect the optional access roles and dedupe by id (the operator may pick the same role
      // in two slots). These grant ViewChannel when private:true.
      const accessRoles = [
        i.options.getRole("access_role"),
        i.options.getRole("access_role_2"),
        i.options.getRole("access_role_3"),
      ].filter((r): r is NonNullable<typeof r> => r !== null);
      const accessRoleIds = [...new Set(accessRoles.map((r) => r.id))];

      const isVoice = channelType === ChannelType.GuildVoice;

      // mapChannelType only ever returns a GuildChannelType (text|voice|forum|announcement),
      // each a valid channels.create() target, but its static return type is the broad
      // ChannelType enum — narrow the `type` field to what GuildChannelCreateOptions accepts.
      const opts: GuildChannelCreateOptions = {
        name,
        type: channelType as GuildChannelCreateOptions["type"],
        parent,
        ...(nsfw ? { nsfw: true } : {}),
        ...(isPrivate
          ? {
              permissionOverwrites: buildPrivateOverwrites(
                accessRoleIds,
                guild.roles.everyone.id,
                i.client.user.id,
              ),
            }
          : {}),
        ...(!isVoice && topic !== null ? { topic } : {}),
        ...(!isVoice && slowmode !== null ? { rateLimitPerUser: slowmode } : {}),
      };

      const channel = await guild.channels.create(opts);

      // Name which roles were granted access (admins/owner always retain access via Discord).
      const access =
        isPrivate && accessRoleIds.length > 0
          ? ` Access: ${accessRoleIds.map((id) => `<@&${id}>`).join(", ")}.`
          : isPrivate
            ? " Visible only to admins."
            : "";

      await i.editReply(
        `Created channel **${channel.name}** in **${category.name}**${isPrivate ? " (private)" : ""}.${access}`,
      );
      ctx.log.info("channel created", {
        name,
        type: typeChoice,
        private: isPrivate,
        accessRoleIds,
      });
    },
  };
}
