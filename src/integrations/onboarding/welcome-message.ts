// Welcome message: build the role-picker as a Components V2 container (buildWelcomeContainer)
// and reconcile it idempotently in #welcome (find the bot's prior message -> edit, else send +
// pin). reconcileWelcomeMessage runs in gateway context (ClientReady) — there is NO router
// catch site, so it AWAITs every Discord call and CATCHES + LOGS its own failures via `log`;
// it never throws out into the dispatcher.
//
// Each pickable role renders as a Section: live role name + member count + a one-line blurb
// (from guildConfig.roleMeta), with an emoji-free "Request" button as the Section accessory
// (customId = onboard:pick:<roleId> via ./custom-id.ts).
//
// V2 NOTES (see the design spec): a V2 message has an EMPTY `content`, so the prior-message
// detection scans `components` (including Section accessories) for an `onboard:pick:` button.
// And `IsComponentsV2` cannot be added to an existing message via edit, so a legacy (non-V2)
// welcome message is deleted + re-sent rather than edited.
import { MessageFlags } from "discord.js";
import type { Client, Guild, MessageCreateOptions } from "discord.js";
import { guildConfig, roleMetaFor } from "../../config/guild.ts";
import { log } from "../../lib/log.ts";
import { buildWelcomeContainer, MAX_ROLE_SECTIONS, type WelcomeRole } from "./ui.ts";

const PICK_PREFIX = "onboard:pick:";

// Resolve a role id to its live name off the guild, falling back to the raw id when the role
// is not cached/resolvable. Centralised so the picker, the buttons, and the access-request
// container all label a role identically.
export function resolveRoleName(guild: Guild | null | undefined, roleId: string): string {
  return guild?.roles.cache.get(roleId)?.name ?? roleId;
}

// Build the per-role Section data (name + blurb + live member count), truncated to the V2
// component budget. `extraCount` is how many roles overflowed (surfaced as a "+N more" note),
// so the picker never advertises a role with no clickable button.
export function buildWelcomeRoles(
  guild: Guild | null | undefined,
  cfg: typeof guildConfig = guildConfig,
): { roles: WelcomeRole[]; extraCount: number } {
  let ids: readonly string[] = cfg.pickableRoleIds;
  let extraCount = 0;
  if (ids.length > MAX_ROLE_SECTIONS) {
    log.error("welcome role picker exceeds section limit — truncating", {
      count: ids.length,
      max: MAX_ROLE_SECTIONS,
    });
    extraCount = ids.length - MAX_ROLE_SECTIONS;
    ids = ids.slice(0, MAX_ROLE_SECTIONS);
  }

  const roles = ids.map((roleId) => ({
    roleId,
    name: resolveRoleName(guild, roleId),
    blurb: roleMetaFor(roleId, cfg)?.blurb,
    // role.members is only populated for cached members; reconcile fetches members first so this
    // is accurate live. Undefined (no cache) ⇒ the count is simply omitted by the builder.
    memberCount: guild?.roles.cache.get(roleId)?.members?.size,
  }));
  return { roles, extraCount };
}

// The full V2 welcome container. Pure; reconcile wraps it in a send/edit payload. Exported for
// unit testing via .toJSON().
export function buildWelcomePayload(
  guild: Guild | null | undefined,
  cfg: typeof guildConfig = guildConfig,
) {
  const { roles, extraCount } = buildWelcomeRoles(guild, cfg);
  const sla = cfg.reviewSla ?? "~24h";
  return buildWelcomeContainer({
    intro: cfg.welcomeMessage,
    roles,
    extraCount,
    footer: `An admin reviews every request · usually within ${sla}.`,
  });
}

// Minimal structural view of a fetched message's component tree for prior-message detection.
// A V2 button can sit in an ActionRow (`components`) OR as a Section accessory (`accessory`).
interface ComponentLike {
  customId?: string | null;
  components?: readonly ComponentLike[];
  accessory?: ComponentLike | null;
}

// Recursively scan a message's components (Container -> Section/ActionRow -> Button, incl. the
// Section's accessory button) for a role-pick button. Replaces the old `content.startsWith(...)`
// check, which is useless under V2 (V2 messages have empty content).
function hasPickButton(components: readonly ComponentLike[] | undefined): boolean {
  for (const c of components ?? []) {
    if (typeof c.customId === "string" && c.customId.startsWith(PICK_PREFIX)) return true;
    const acc = c.accessory;
    if (acc && typeof acc.customId === "string" && acc.customId.startsWith(PICK_PREFIX)) {
      return true;
    }
    if (hasPickButton(c.components)) return true;
  }
  return false;
}

// Idempotent reconcile in #welcome. Gateway-context: catches + logs its own failures so a
// missing channel / API error can never escape into the gateway dispatcher.
export async function reconcileWelcomeMessage(
  client: Client,
  cfg: typeof guildConfig = guildConfig,
): Promise<void> {
  try {
    const channel = await client.channels.fetch(cfg.welcomeChannelId);
    if (!channel || !channel.isTextBased() || !channel.isSendable()) {
      log.error("welcome channel missing or not text", { channelId: cfg.welcomeChannelId });
      return;
    }

    // Resolve role names off the guild that owns the welcome channel. A sendable text channel
    // is normally guild-based, but the narrowed union still admits DM channels (no `.guild`);
    // guard so name/count resolution falls back gracefully instead of throwing.
    const guild = "guild" in channel ? channel.guild : null;
    // Populate the member cache so per-role counts are accurate (GuildMembers intent is on).
    if (guild) await guild.members.fetch().catch(() => {});
    const container = buildWelcomePayload(guild, cfg);
    // Annotated (not inferred): a bare `const` widens the numeric enum member to the whole
    // MessageFlags enum, which the narrow MessageCreateOptions.flags union rejects.
    const sendPayload: MessageCreateOptions = {
      flags: MessageFlags.IsComponentsV2,
      components: [container],
    };
    const botId = client.user?.id;

    // Find the bot's prior welcome message (by its role-pick button) so re-running boots
    // reconcile it instead of spamming.
    const recent = await channel.messages.fetch({ limit: 50 });
    const existing = recent.find(
      (m) =>
        m.author?.id === botId &&
        hasPickButton(m.components as unknown as readonly ComponentLike[]),
    );

    if (existing) {
      // Already a V2 message ⇒ edit in place (components only; the V2 flag is immutable and
      // already set). A legacy non-V2 message can't gain the V2 flag via edit, so replace it.
      const isV2 = existing.flags?.has(MessageFlags.IsComponentsV2) ?? false;
      if (isV2) {
        await existing.edit({ components: [container] });
        log.info("welcome reconciled", { channelId: cfg.welcomeChannelId, action: "edit" });
        return;
      }
      await existing.delete().catch(() => {});
      const replaced = await channel.send(sendPayload);
      await replaced.pin();
      log.info("welcome reconciled", { channelId: cfg.welcomeChannelId, action: "replace" });
      return;
    }

    const sent = await channel.send(sendPayload);
    await sent.pin();
    log.info("welcome reconciled", { channelId: cfg.welcomeChannelId, action: "send" });
  } catch (err) {
    log.error("welcome reconcile failed", { err });
  }
}
