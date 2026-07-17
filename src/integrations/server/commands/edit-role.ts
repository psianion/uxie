// /edit-role — edit an existing role's name, color, hoist, mentionable, or position. Shares
// create-role's color picker + resolution (imported, so the two commands can never drift) and
// its auto-defer + V2-on-editReply shape. Only provided options are sent to roles.edit().
// Guards: @everyone cannot be edited here (its "name" and position are fixed by Discord and
// editing it is almost always a mis-click); managed (integration) roles are rejected — Discord
// owns them and the edit would 400 anyway, this just names the reason first.
// Permission bits are deliberately NOT editable here: recreating a role with /create-role's
// preset table is clearer than diffing bitfields in slash options. Revisit if it comes up.
// NO try/catch in the body — the interaction-router is the single catch site (decision 10).
import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";
import { ConfigError } from "../../../lib/errors.ts";
import { buildStatusContainer } from "../../../lib/ui/status-container.ts";
import type { StatusModel, StatusRow } from "../../../lib/ui/status-container.ts";
import { COLOR_CHOICES, resolveColor } from "./create-role.ts";

export function buildEditRoleCommand(): LoadedCommand {
  const data = new SlashCommandBuilder()
    .setName("edit-role")
    .setDescription("Edit an existing role (only the options you provide change)")
    .addRoleOption((o) => o.setName("role").setDescription("Role to edit").setRequired(true))
    .addStringOption((o) => o.setName("name").setDescription("New role name"))
    .addStringOption((o) =>
      o.setName("color").setDescription("Named color").addChoices(...COLOR_CHOICES),
    )
    .addStringOption((o) =>
      o.setName("color_hex").setDescription("Custom hex like #5865F2 (overrides color)"),
    )
    .addBooleanOption((o) =>
      o.setName("hoist").setDescription("Display members of this role separately in the sidebar"),
    )
    .addBooleanOption((o) =>
      o.setName("mentionable").setDescription("Allow anyone to @mention this role"),
    )
    .addIntegerOption((o) =>
      o.setName("position").setDescription("Move the role to this position").setMinValue(1),
    )
    .addStringOption((o) => o.setName("reason").setDescription("Audit-log reason"));

  return {
    data: withOwnerGate(data),
    async execute(i, ctx) {
      const guild = i.guild;
      if (!guild) throw new ConfigError("edit-role", "no guild context");

      const target = i.options.getRole("role", true);
      if (target.id === guild.id) {
        throw new ConfigError("edit-role", "@everyone cannot be edited with this command");
      }
      if (target.managed) {
        throw new ConfigError("edit-role", "managed (integration) roles cannot be edited");
      }

      const name = i.options.getString("name");
      const colorChoice = i.options.getString("color");
      const colorHex = i.options.getString("color_hex");
      const hoist = i.options.getBoolean("hoist");
      const mentionable = i.options.getBoolean("mentionable");
      const position = i.options.getInteger("position");
      const reason = i.options.getString("reason");

      const color = resolveColor(colorChoice, colorHex);
      // "Default" named choice means "reset to no color" — Discord encodes that as 0.
      const colorEdit =
        color !== undefined ? color : colorChoice === "Default" ? 0 : undefined;

      const edits = {
        ...(name !== null ? { name } : {}),
        ...(colorEdit !== undefined ? { color: colorEdit } : {}),
        ...(hoist !== null ? { hoist } : {}),
        ...(mentionable !== null ? { mentionable } : {}),
        ...(position !== null ? { position } : {}),
        ...(reason !== null ? { reason } : {}),
      };
      const changedKeys = Object.keys(edits).filter((k) => k !== "reason");
      if (changedKeys.length === 0) {
        throw new ConfigError("edit-role", "provide at least one option to change");
      }

      const role = await guild.roles.edit(target.id, edits);

      const rows: StatusRow[] = [{ icon: "🏷", label: "Role", value: `<@&${role.id}>` }];
      if (name !== null) rows.push({ icon: "✏️", label: "Name", value: name });
      if (colorEdit !== undefined)
        rows.push({
          icon: "🎨",
          label: "Color",
          value: colorEdit === 0 ? "default" : `#${colorEdit.toString(16).padStart(6, "0")}`,
        });
      if (hoist !== null) rows.push({ icon: "📌", label: "Hoisted", value: hoist ? "yes" : "no" });
      if (mentionable !== null)
        rows.push({ icon: "🔔", label: "Mentionable", value: mentionable ? "yes" : "no" });
      if (position !== null)
        rows.push({ icon: "🔢", label: "Position", value: String(role.position) });

      const model: StatusModel = {
        title: "Role updated",
        health: "ok",
        badge: `<@&${role.id}>`,
        rows,
        footer: `${changedKeys.length} field(s) changed in ${guild.name}`,
      };

      await i.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [buildStatusContainer(model)],
      });

      ctx.log.info("role edited", { roleId: role.id, changed: changedKeys });
    },
  };
}
