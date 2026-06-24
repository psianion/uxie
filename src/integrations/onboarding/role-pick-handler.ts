// Handles a role-picker button (onboard:pick:<roleId>): validate the roleId is configured,
// guard against re-requesting a role the member already has, defer an ephemeral ack up front
// (so the network post below can't blow Discord's 3s window), post a Components V2 Access
// Request container (light dossier + Approve/Deny) to #access-requests for owner review, then
// confirm to the guest via editReply.
//
// NO try/catch — this is an interaction handler reached via the router, so faults bubble to
// handleInteraction (the single catch site). A missing #access-requests channel surfaces as
// a ConfigError to the router (mis-config, not a silent swallow). Ephemeral replies ALWAYS
// use { flags: MessageFlags.Ephemeral }. The posted request is V2 (flags: IsComponentsV2) and
// suppresses mention pings (allowedMentions.parse: []) — V2 TextDisplay mentions would
// otherwise ping the requester + role on every request.
import { MessageFlags } from "discord.js";
import type { ButtonInteraction } from "discord.js";
import { guildConfig } from "../../config/guild.ts";
import { ConfigError } from "../../lib/errors.ts";
import { decodeOnboardCustomId } from "./custom-id.ts";
import { buildAccessRequestContainer } from "./ui.ts";

// UX-SEC-001: per-user+role flood throttle for the guest-reachable role-pick button. Default
// 5-minute window, overridable via cfg.rolePickCooldownMs. In-memory + single-process (Bun):
// it resets on restart, which is acceptable (worst case a guest re-requests once after a deploy).
const ROLE_PICK_COOLDOWN_MS = 5 * 60_000;
const rolePickThrottle = new Map<string, number>(); // `${userId}:${roleId}` -> expiry epoch-ms

// Test support: the throttle is module-level state that outlives a single call, so tests reset it
// between cases.
export function __clearRolePickThrottle(): void {
  rolePickThrottle.clear();
}

export async function handleRolePick(
  i: ButtonInteraction,
  cfg: typeof guildConfig & { rolePickCooldownMs?: number } = guildConfig,
  now: () => number = Date.now,
): Promise<void> {
  const decoded = decodeOnboardCustomId(i.customId);
  // The router only routes onboard:pick: here, but assert the kind for safety.
  if (decoded.kind !== "pick") {
    await i.reply({ content: "Unknown request.", flags: MessageFlags.Ephemeral });
    return;
  }

  const roleId = decoded.roleId;
  // `as const` narrows pickableRoleIds to a literal tuple, which over-narrows `.includes`'s
  // argument; widen to readonly string[] so any decoded snowflake can be tested.
  if (!(cfg.pickableRoleIds as readonly string[]).includes(roleId)) {
    await i.reply({
      content: "⚠️ That button's out of date — that role isn't available anymore.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Label the role by its live name (falls back to the raw id if the role is not cached).
  const roleName = i.guild?.roles.cache.get(roleId)?.name ?? roleId;

  // Already-has-role guard. A cached GuildMember exposes roles.cache.has(roleId). The
  // partial / APIInteractionGuildMember shape lacks that — skip the guard rather than throw.
  const memberRoles = i.member?.roles;
  if (
    memberRoles &&
    typeof memberRoles === "object" &&
    "cache" in memberRoles &&
    memberRoles.cache.has(roleId)
  ) {
    await i.reply({
      content: `✅ You already have **${roleName}** — you're all set.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Per-user+role flood throttle (UX-SEC-001). A guest who does not yet hold the role never trips
  // the already-has-role guard above, so this is what stops them spamming #access-requests by
  // re-clicking the persistent Request button. Stamp BEFORE the first await so a same-tick
  // double-click is single-flighted; prune expired keys opportunistically (the map stays tiny).
  const nowMs = now();
  for (const [k, exp] of rolePickThrottle) if (exp <= nowMs) rolePickThrottle.delete(k);
  const throttleKey = `${i.user.id}:${roleId}`;
  if ((rolePickThrottle.get(throttleKey) ?? 0) > nowMs) {
    await i.reply({
      content: `⏳ You've already requested **${roleName}** — an admin is reviewing it. Hang tight.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  rolePickThrottle.set(throttleKey, nowMs + (cfg.rolePickCooldownMs ?? ROLE_PICK_COOLDOWN_MS));

  // Ack immediately with a deferred ephemeral reply — fetching/sending to #access-requests can
  // exceed Discord's 3s window (which would 10062 the guest's click). We confirm via editReply
  // only AFTER the post succeeds; if the channel is mis-configured the ConfigError bubbles to
  // the router, which editReplies an error rather than a misleading "submitted".
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = await i.client.channels.fetch(cfg.accessRequestsChannelId);
  if (!channel || !channel.isSendable()) {
    throw new ConfigError(
      "access_requests_channel",
      "access-requests channel missing or not text",
    );
  }

  const container = buildAccessRequestContainer({
    userId: i.user.id,
    roleId,
    roleName,
    avatarUrl: i.user.displayAvatarURL(),
    createdAtSec: Math.floor(i.user.createdTimestamp / 1000),
    atSec: Math.floor(Date.now() / 1000),
  });
  await channel.send({
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [] },
  });

  const sla = cfg.reviewSla ?? "~24h";
  await i.editReply({
    content: `✅ Request sent for **${roleName}** — an admin reviews every request, usually within ${sla}. You'll get a DM here either way.`,
  });
}
