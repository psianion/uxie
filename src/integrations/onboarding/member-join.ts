// guildMemberAdd handler: assign the guest role to every joining human; skip bots.
// Channel gating itself is operator-configured (locked design decision 3): the operator
// pre-configures channel permission overwrites so guests see only #welcome — the bot ONLY
// assigns GUEST_ROLE here and does NOT manage per-member channel overwrites.
//
// Gateway context: there is NO interaction-router catch site, so the whole body is wrapped
// and `roles.add` is AWAITed + logged. onMemberJoin MUST NEVER throw out of the gateway
// dispatcher (tests assert a rejecting roles.add does not escape).
import type { GuildMember } from "discord.js";
import { log } from "../../lib/log.ts";

export async function onMemberJoin(member: GuildMember, guestRoleId: string): Promise<void> {
  // Do not gate bots — they don't go through onboarding.
  if (member.user.bot) return;

  try {
    await member.roles.add(guestRoleId);
    log.info("guest role assigned", { userId: member.id });
  } catch (err) {
    log.error("guest role assign failed", { userId: member.id, err });
  }
}
