// /create-role — create a guild role with granular options, then render a Components V2
// result panel. The command does NOT set defer:false, so the router auto-defers ephemerally:
// the interaction is acknowledged within Discord's 3s window BEFORE guild.roles.create() — an
// unbounded network write that can exceed 3s under rate-limits/latency. IsComponentsV2 cannot
// ride on a deferred placeholder, but it CAN be carried on editReply (per the discord.js
// display-components guidance), so the V2 panel renders on the deferred reply. This is the
// create-channel/create-category shape (defer + editReply), NOT /ping's reply-without-defer
// (which is only safe there because its probe is bounded to ~500ms).
// Do NOT switch this to defer:false + i.reply: that ties the ONLY ack to AFTER the write and
// surfaces to the user as "application did not respond" whenever the write is slow.
// NO try/catch in the body — the interaction-router is the single catch site (decision 10).
// Validation faults (bad hex, no guild) throw ConfigError; Discord rejects perms the bot lacks.
import {
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  SlashCommandBuilder,
} from "discord.js";
import type { RoleCreateOptions } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";
import { ConfigError } from "../../../lib/errors.ts";
import { buildStatusContainer } from "../../../lib/ui/status-container.ts";
import type { StatusModel, StatusRow } from "../../../lib/ui/status-container.ts";

// Named-color choices → hex numbers mapped in the handler. Values are the choice value strings.
const COLOR_CHOICES: { name: string; value: string }[] = [
  { name: "Default", value: "Default" },
  { name: "Red", value: "Red" },
  { name: "Orange", value: "Orange" },
  { name: "Yellow", value: "Yellow" },
  { name: "Green", value: "Green" },
  { name: "Aqua", value: "Aqua" },
  { name: "Blue", value: "Blue" },
  { name: "Purple", value: "Purple" },
  { name: "Pink", value: "Pink" },
  { name: "Gold", value: "Gold" },
  { name: "Navy", value: "Navy" },
  { name: "Grey", value: "Grey" },
  { name: "White", value: "White" },
  { name: "Black", value: "Black" },
];

const COLOR_HEX: Record<string, number> = {
  Default: 0x000000,
  Red: 0xed4245,
  Orange: 0xe67e22,
  Yellow: 0xfee75c,
  Green: 0x57f287,
  Aqua: 0x1abc9c,
  Blue: 0x3498db,
  Purple: 0x9b59b6,
  Pink: 0xeb459e,
  Gold: 0xf1c40f,
  Navy: 0x34495e,
  Grey: 0x95a5a6,
  White: 0xffffff,
  Black: 0x23272a,
};

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;

// Permission presets. Each preset's bits are the OR of the listed flags; presets compose
// member ⊂ moderator ⊂ manager, while admin is just Administrator.
const MEMBER_PERMS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.UseExternalEmojis,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
];

const MODERATOR_PERMS = [
  ...MEMBER_PERMS,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.DeafenMembers,
  PermissionFlagsBits.ManageThreads,
];

const MANAGER_PERMS = [
  ...MODERATOR_PERMS,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ManageGuild,
];

const PRESETS: Record<string, bigint[]> = {
  none: [],
  member: MEMBER_PERMS,
  moderator: MODERATOR_PERMS,
  manager: MANAGER_PERMS,
  admin: [PermissionFlagsBits.Administrator],
};

// perm_* option name → PermissionFlagsBits member. OR-ed in on top of the preset.
const PERM_TOGGLES: Record<string, bigint> = {
  perm_administrator: PermissionFlagsBits.Administrator,
  perm_manage_guild: PermissionFlagsBits.ManageGuild,
  perm_manage_roles: PermissionFlagsBits.ManageRoles,
  perm_manage_channels: PermissionFlagsBits.ManageChannels,
  perm_manage_messages: PermissionFlagsBits.ManageMessages,
  perm_kick_members: PermissionFlagsBits.KickMembers,
  perm_ban_members: PermissionFlagsBits.BanMembers,
  perm_moderate_members: PermissionFlagsBits.ModerateMembers,
  perm_mention_everyone: PermissionFlagsBits.MentionEveryone,
};

function resolveColor(colorChoice: string | null, colorHex: string | null): number | undefined {
  if (colorHex !== null) {
    if (!HEX_RE.test(colorHex)) {
      throw new ConfigError("create-role", `invalid color_hex: ${colorHex}`);
    }
    return parseInt(colorHex.replace(/^#/, ""), 16);
  }
  // "Default" is an explicit no-color choice: omit color so Discord uses its true default
  // (and the panel renders "default") rather than forwarding solid black #000000.
  if (colorChoice !== null && colorChoice !== "Default" && colorChoice in COLOR_HEX) {
    return COLOR_HEX[colorChoice];
  }
  return undefined;
}

export function buildCreateRoleCommand(): LoadedCommand {
  return {
    // No defer:false — the router auto-defers so the ack precedes the roles.create write below.
    data: withOwnerGate(
      new SlashCommandBuilder()
        .setName("create-role")
        .setDescription("Create a guild role with granular options")
        .addStringOption((o) =>
          o.setName("name").setDescription("Name of the role").setRequired(true),
        )
        .addStringOption((o) =>
          o.setName("color").setDescription("Named color").addChoices(...COLOR_CHOICES),
        )
        .addStringOption((o) =>
          o
            .setName("color_hex")
            .setDescription("Custom hex like #5865F2 (overrides color)"),
        )
        .addBooleanOption((o) =>
          o
            .setName("hoist")
            .setDescription("Display members of this role separately in the sidebar"),
        )
        .addBooleanOption((o) =>
          o.setName("mentionable").setDescription("Allow anyone to @mention this role"),
        )
        .addIntegerOption((o) =>
          o
            .setName("position")
            .setDescription("Insert the role at this position")
            .setMinValue(1),
        )
        .addStringOption((o) =>
          o
            .setName("permission_preset")
            .setDescription("Base permission bundle")
            .addChoices(
              { name: "none", value: "none" },
              { name: "member", value: "member" },
              { name: "moderator", value: "moderator" },
              { name: "manager", value: "manager" },
              { name: "admin", value: "admin" },
            ),
        )
        .addBooleanOption((o) =>
          o.setName("perm_administrator").setDescription("Grant Administrator"),
        )
        .addBooleanOption((o) =>
          o.setName("perm_manage_guild").setDescription("Grant Manage Server"),
        )
        .addBooleanOption((o) =>
          o.setName("perm_manage_roles").setDescription("Grant Manage Roles"),
        )
        .addBooleanOption((o) =>
          o.setName("perm_manage_channels").setDescription("Grant Manage Channels"),
        )
        .addBooleanOption((o) =>
          o.setName("perm_manage_messages").setDescription("Grant Manage Messages"),
        )
        .addBooleanOption((o) =>
          o.setName("perm_kick_members").setDescription("Grant Kick Members"),
        )
        .addBooleanOption((o) =>
          o.setName("perm_ban_members").setDescription("Grant Ban Members"),
        )
        .addBooleanOption((o) =>
          o.setName("perm_moderate_members").setDescription("Grant Timeout Members"),
        )
        .addBooleanOption((o) =>
          o.setName("perm_mention_everyone").setDescription("Grant Mention @everyone"),
        )
        .addStringOption((o) =>
          o.setName("reason").setDescription("Audit-log reason"),
        ),
    ),
    async execute(i, ctx) {
      const guild = i.guild;
      if (!guild) throw new ConfigError("create-role", "no guild context");

      const name = i.options.getString("name", true);
      const colorChoice = i.options.getString("color");
      const colorHex = i.options.getString("color_hex");
      const hoist = i.options.getBoolean("hoist");
      const mentionable = i.options.getBoolean("mentionable");
      const position = i.options.getInteger("position");
      const presetName = i.options.getString("permission_preset");
      const reason = i.options.getString("reason");

      const color = resolveColor(colorChoice, colorHex);

      // Start from the preset's bits (none/empty when unset), then OR-in each enabled perm_*.
      const bits = new PermissionsBitField(PRESETS[presetName ?? "none"] ?? []);
      for (const [optName, flag] of Object.entries(PERM_TOGGLES)) {
        if (i.options.getBoolean(optName) === true) bits.add(flag);
      }
      const hasPerms = bits.bitfield !== 0n;

      const opts: RoleCreateOptions = {
        name,
        ...(color !== undefined ? { color } : {}),
        ...(hoist !== null ? { hoist } : {}),
        ...(mentionable !== null ? { mentionable } : {}),
        ...(position !== null ? { position } : {}),
        ...(hasPerms ? { permissions: bits } : {}),
        ...(reason !== null ? { reason } : {}),
      };

      const role = await guild.roles.create(opts);

      const granted = bits.toArray();
      const presetLabel = presetName ?? "none";
      const permsValue = hasPerms
        ? `${presetLabel} · ${granted.length} granted`
        : "none";

      const rows: StatusRow[] = [
        { icon: "🏷", label: "Name", value: `<@&${role.id}>` },
        { icon: "🎨", label: "Color", value: color !== undefined ? `#${color.toString(16).padStart(6, "0")}` : "default" },
        { icon: "📌", label: "Hoisted", value: hoist === true ? "yes" : "no" },
        { icon: "🔔", label: "Mentionable", value: mentionable === true ? "yes" : "no" },
        { icon: "🔢", label: "Position", value: String(role.position) },
        { icon: "🛡", label: "Permissions", value: permsValue },
        { icon: "🆔", label: "Role ID", value: role.id },
      ];

      const model: StatusModel = {
        title: "Role created",
        health: "ok",
        badge: `<@&${role.id}>`,
        rows,
        footer: `created in ${guild.name}`,
      };

      // Router already deferred ephemerally; carry IsComponentsV2 on the edit so the deferred
      // placeholder upgrades to the V2 panel. (Ephemerality is fixed at defer time.)
      await i.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [buildStatusContainer(model)],
      });

      ctx.log.info("role created", {
        name,
        roleId: role.id,
        preset: presetLabel,
        grantedCount: granted.length,
      });
    },
  };
}
