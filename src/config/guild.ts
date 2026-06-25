// Operator-edited guild structure (NOT secrets — so it does NOT go through env.ts).
// Ships with REAL operator snowflakes; `assertGuildConfig()` (called in src/index.ts right
// after parseEnv()) rejects any malformed/duplicate id, naming the offending field, so a
// mis-edit fails LOUDLY at boot rather than silently mis-routing onboarding.
import { ConfigError } from "../lib/errors.ts";

// Optional per-role metadata for the welcome picker + DMs. All fields optional — a role with no
// entry falls back to generic copy, so deployments that don't fill it in still work.
export type RoleMeta = {
  blurb?: string; // one-line "what this unlocks", shown under the role on the picker
  emoji?: string; // reserved — buttons stay text-only today
  unlockedChannelIds?: readonly string[]; // a channel to point the approved member at in the DM
};

export const guildConfig = {
  welcomeChannelId: "1511369481904062645",
  accessRequestsChannelId: "1519115092908707951",
  guestRoleId: "1519115363332259871",

  // Owner-only live log channel for warn+error mirroring. Empty = disabled (sink OFF). Set to a
  // private channel id to mirror logs there. Validated as a snowflake only when non-empty.
  logChannelId: "1519677387397271602",

  // Roles a guest can request. Each renders as its own Components V2 Section on the welcome
  // picker (live role name + blurb + member count + a "Request" button accessory).
  pickableRoleIds: ["1519115759408779314", "1519115612578644018"],

  // Per-role copy keyed by role id (must be a pickable role). Edit the blurbs freely; add
  // `unlockedChannelIds: ["<channel id>"]` to name a channel the approved member is pointed at.
  roleMeta: {
    "1519115759408779314": {
      blurb: "Game nights, LFG pings, and the clips channel.",
    },
    "1519115612578644018": {
      blurb: "Dev channels, project access, and release pings.",
    },
  },

  // The picker's intro / value-prop line (operator-customizable). The role list is rendered as
  // Sections below it, so this no longer needs a {roles} placeholder.
  welcomeMessage: `You're in as a guest for now. Pick a role below to unlock the channels and pings you actually came here for — an admin approves each request.`,

  // Shown in the welcome footer + the submit-success ack so requesters know when to expect a reply.
  reviewSla: "~24h",
} as const;

const SNOWFLAKE = /^[0-9]{17,20}$/;
const PLACEHOLDERS = ["CHANNEL_ID_HERE", "ROLE_ID_HERE"] as const;

// Look up a role's metadata (cast past the `as const` literal key type so any roleId resolves).
export function roleMetaFor(
  roleId: string,
  cfg: typeof guildConfig = guildConfig,
): RoleMeta | undefined {
  return (cfg.roleMeta as Readonly<Record<string, RoleMeta>> | undefined)?.[roleId];
}

// Reject the literal placeholders (clearer message) BEFORE the snowflake shape check.
function assertSnowflake(value: string, field: string): void {
  if (PLACEHOLDERS.includes(value as (typeof PLACEHOLDERS)[number])) {
    throw new ConfigError("guild_config", `guild config invalid — ${field} is a placeholder`);
  }
  if (!SNOWFLAKE.test(value)) {
    throw new ConfigError("guild_config", `guild config invalid — ${field} is not a snowflake`);
  }
}

// Boot-time validation. Throws ConfigError("guild_config", ...) naming the offending field.
export function assertGuildConfig(cfg: typeof guildConfig = guildConfig): void {
  assertSnowflake(cfg.welcomeChannelId, "welcomeChannelId");
  assertSnowflake(cfg.accessRequestsChannelId, "accessRequestsChannelId");
  assertSnowflake(cfg.guestRoleId, "guestRoleId");

  // Optional: a blank logChannelId disables the log sink; only validate a non-empty value.
  if (cfg.logChannelId) assertSnowflake(cfg.logChannelId, "logChannelId");

  // `as const` types the default pickableRoleIds.length as a literal; widen to number so the
  // empty-picker guard also covers configs passed in by callers/tests.
  if ((cfg.pickableRoleIds.length as number) === 0) {
    throw new ConfigError("guild_config", "guild config invalid — pickableRoleIds is empty");
  }

  const seenRoleIds = new Set<string>();
  for (const [index, roleId] of cfg.pickableRoleIds.entries()) {
    assertSnowflake(roleId, `pickableRoleIds[${index}]`);
    if (seenRoleIds.has(roleId)) {
      throw new ConfigError(
        "guild_config",
        `guild config invalid — pickableRoleIds has duplicate roleId "${roleId}"`,
      );
    }
    seenRoleIds.add(roleId);
  }

  // roleMeta is optional, but any key present must be a pickable role and its unlockedChannelIds
  // must be snowflakes — so a typo'd id fails loudly rather than silently rendering generic copy.
  const roleMeta = (cfg.roleMeta ?? {}) as Readonly<Record<string, RoleMeta>>;
  for (const [roleId, meta] of Object.entries(roleMeta)) {
    assertSnowflake(roleId, `roleMeta key "${roleId}"`);
    if (!seenRoleIds.has(roleId)) {
      throw new ConfigError(
        "guild_config",
        `guild config invalid — roleMeta key "${roleId}" is not in pickableRoleIds`,
      );
    }
    for (const channelId of meta.unlockedChannelIds ?? []) {
      assertSnowflake(channelId, `roleMeta["${roleId}"].unlockedChannelIds`);
    }
  }
}
