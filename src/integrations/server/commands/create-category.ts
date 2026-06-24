// /create-category — create a category channel (optionally private). The router has already
// deferReply'd ephemerally, so the body replies via i.editReply. NO try/catch in the command
// body — interaction-router is the only catch site (decision 10). Owner enforcement is
// router-located; this only stamps builder shape via withOwnerGate (decision 9).
import { ChannelType, SlashCommandBuilder } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";
import { ConfigError } from "../../../lib/errors.ts";
import { buildPrivateOverwrites } from "../permissions.ts";

export function buildCreateCategoryCommand(): LoadedCommand {
  return {
    data: withOwnerGate(
      new SlashCommandBuilder()
        .setName("create-category")
        .setDescription("Create a category channel")
        .addStringOption((o) =>
          o.setName("name").setDescription("Category name").setRequired(true),
        )
        .addIntegerOption((o) => o.setName("position").setDescription("Sort position"))
        .addBooleanOption((o) =>
          o
            .setName("private")
            .setDescription("Hide from @everyone (only granted roles see it)"),
        )
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
      if (!guild) throw new ConfigError("create_category", "no guild context");

      const name = i.options.getString("name", true);
      const position = i.options.getInteger("position");
      const isPrivate = i.options.getBoolean("private") ?? false;

      // Collect the optional access roles and dedupe by id. These grant ViewChannel when
      // private:true; with none given a private category is visible only to admins/owner.
      const accessRoles = [
        i.options.getRole("access_role"),
        i.options.getRole("access_role_2"),
        i.options.getRole("access_role_3"),
      ].filter((r): r is NonNullable<typeof r> => r !== null);
      const accessRoleIds = [...new Set(accessRoles.map((r) => r.id))];

      const overwrites = isPrivate
        ? buildPrivateOverwrites(accessRoleIds, guild.roles.everyone.id, i.client.user.id)
        : undefined;

      const category = await guild.channels.create({
        name,
        type: ChannelType.GuildCategory,
        ...(position !== null ? { position } : {}),
        ...(overwrites ? { permissionOverwrites: overwrites } : {}),
      });

      // Name which roles were granted access (admins/owner always retain access via Discord).
      const access =
        isPrivate && accessRoleIds.length > 0
          ? ` Access: ${accessRoleIds.map((id) => `<@&${id}>`).join(", ")}.`
          : isPrivate
            ? " Visible only to admins."
            : "";

      await i.editReply(
        `Created category **${category.name}**${isPrivate ? " (private)" : ""}.${access}`,
      );
      ctx.log.info("category created", { name, private: isPrivate, accessRoleIds });
    },
  };
}
