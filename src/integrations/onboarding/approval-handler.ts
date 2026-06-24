// Handles the Approve/Deny buttons (onboard:approve|deny:<userId>:<roleId>) posted to
// #access-requests. Approval authority = OWNER ONLY (locked design decision 2): assert the
// clicker is env.DISCORD_OWNER_ID; non-owners get an ephemeral refusal with NO side effects.
//
// NO try/catch for control flow — faults bubble to the router (the single catch site). The
// local try/catch blocks are deliberate: (a) the role grant (so a hierarchy/permission failure
// renders an "error" decision instead of bubbling), and (b) the best-effort member DM (a DM
// failure is logged AND noted on the card, but the grant/deny stands regardless).
//
// CONCURRENCY: a per-message in-flight lock drops a double-click so the role swap + DM run
// exactly once (a single-owner bot's cheap, restart-tolerant guard against double-grant/DM).
//
// The interaction is acknowledged up front with i.deferUpdate(): the member fetch + role
// changes + DM can exceed Discord's 3-second window, so we ack first, then rebuild the request
// message into its terminal Components V2 state with i.editReply(). Doing the slow work before
// the first ack is what caused 10062 "Unknown interaction". Edits suppress mention pings
// (allowedMentions.parse: []) because V2 TextDisplay mentions ping. Ephemeral refusals use
// { flags: MessageFlags.Ephemeral }.
import { MessageFlags } from "discord.js";
import type { ButtonInteraction } from "discord.js";
import { guildConfig, roleMetaFor } from "../../config/guild.ts";
import { ConfigError } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { decodeOnboardCustomId } from "./custom-id.ts";
import { buildDecisionContainer, buildDmContainer } from "./ui.ts";

const V2 = MessageFlags.IsComponentsV2;

// Per-message in-flight lock (keyed by the request message id). Module-level + restart-tolerant
// — enough for a single-owner bot to serialize concurrent clicks on the same request card.
const inFlight = new Set<string>();

export async function handleApprovalButton(
  i: ButtonInteraction,
  ownerId: string,
  cfg: typeof guildConfig = guildConfig,
): Promise<void> {
  // Owner gate — non-owner refusal, no side effects.
  if (i.user.id !== ownerId) {
    await i.reply({
      content: "🚫 Only the owner can approve requests.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const decoded = decodeOnboardCustomId(i.customId);
  if (decoded.kind !== "approve" && decoded.kind !== "deny") {
    await i.reply({ content: "Unknown request.", flags: MessageFlags.Ephemeral });
    return;
  }
  const { userId, roleId } = decoded;
  const action = decoded.kind;

  const guild = i.guild;
  if (!guild) throw new ConfigError("approval", "no guild context");

  // Drop a concurrent double-click on the same card — ack it (no visible change) and bail.
  const lockKey = i.message.id;
  if (inFlight.has(lockKey)) {
    await i.deferUpdate().catch(() => {});
    return;
  }
  inFlight.add(lockKey);
  try {
    // Ack now — everything below (fetch, role changes, DM) can exceed the 3s window.
    await i.deferUpdate();

    const roleName = guild.roles.cache.get(roleId)?.name ?? roleId;

    // A left-the-guild member is an expected branch, not an error to bubble — so .catch(null).
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      await i.editReply({
        flags: V2,
        components: [buildDecisionContainer({ decision: "member_left", userId, roleId, roleName })],
        allowedMentions: { parse: [] },
      });
      return;
    }

    const avatarUrl = member.user.displayAvatarURL();
    const createdAtSec = Math.floor(member.user.createdTimestamp / 1000);

    if (action === "approve" && !member.roles.cache.has(roleId)) {
      try {
        // Additive step FIRST: if this fails (e.g. the role is above the bot's), NOTHING changed
        // and the member stays an unchanged, retryable guest — never stranded with no role.
        await member.roles.add(roleId);
      } catch (err) {
        // Hierarchy / permission failure — render an "error" decision naming the cause rather
        // than bubbling. The grant did NOT happen (no net change); buttons freeze disabled.
        log.error("approval grant failed", { userId, roleId, err });
        await i.editReply({
          flags: V2,
          components: [
            buildDecisionContainer({
              decision: "error",
              userId,
              roleId,
              roleName,
              avatarUrl,
              createdAtSec,
              reviewerId: i.user.id,
              failureReason: grantFailureReason(err),
            }),
          ],
          allowedMentions: { parse: [] },
        });
        return;
      }
      // Drop the guest role best-effort — the member already has the target role, so a removal
      // failure is harmless and must NOT be reported as a grant failure.
      await member.roles.remove(cfg.guestRoleId).catch((err) => {
        log.warn("approval guest-role removal failed (member already granted)", { userId, err });
      });
    }

    // Best-effort DM — the grant/deny stands regardless. Points the member at a next step.
    let dmFailed = false;
    try {
      await member.send({
        flags: V2,
        components: [
          buildDmContainer({
            decision: action === "approve" ? "approved" : "denied",
            roleName,
            guildName: guild.name,
            guildIconUrl: guild.iconURL() ?? undefined,
            jumpChannelId: roleMetaFor(roleId, cfg)?.unlockedChannelIds?.[0],
            welcomeChannelId: cfg.welcomeChannelId,
          }),
        ],
      });
    } catch (err) {
      dmFailed = true;
      log.error("approval DM failed", { userId, err });
    }

    await i.editReply({
      flags: V2,
      components: [
        buildDecisionContainer({
          decision: action === "approve" ? "approved" : "denied",
          userId,
          roleId,
          roleName,
          avatarUrl,
          createdAtSec,
          reviewerId: i.user.id,
          dmFailed,
        }),
      ],
      allowedMentions: { parse: [] },
    });
  } finally {
    inFlight.delete(lockKey);
  }
}

// Map a grant failure to a short cause for the error card. 50013 = Missing Permissions (the
// common case: the bot's role is below the role it's trying to assign).
function grantFailureReason(err: unknown): string {
  const code = (err as { code?: number })?.code;
  if (code === 50013) return "Missing permissions";
  const msg = (err as { message?: string })?.message;
  return msg ? msg : "Unknown error";
}
