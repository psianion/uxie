// Discord Client factory (ratified decision 6). Intents: Guilds + GuildMembers. Guilds is
// enough for interactionCreate (slash commands + buttons); GuildMembers (privileged) is added
// ONLY for guildMemberAdd, which drives guest-role assignment on join. Onboarding state rides
// entirely on button customIds (NOT emoji reactions), so NO GuildMessageReactions intent and
// NO Partials are needed. NO DirectMessages — minimum attack surface (sending DMs needs no
// intent). allowedMentions { parse: [] } so echoing user text in replies never pings anyone
// (decision 8).
//
// GuildMessages + MessageContent (both privileged) are added iff `messageIntents` — needed by
// the para-raid relay (D5/D1: owner messages in session threads forwarded as turns) AND the
// journal mirror (owner messages in #journal appended as entries), so the boot path ORs those
// two feature flags. MessageContent must also be flipped on in the Discord dev portal (Bot >
// Privileged Gateway Intents) or login fails with "disallowed intents". Deployments with both
// features off keep today's minimal intent set — zero behavior change.
import { Client, GatewayIntentBits } from "discord.js";

export function createDiscordClient(messageIntents: boolean): Client {
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers];
  if (messageIntents) {
    intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  }
  return new Client({
    intents,
    allowedMentions: { parse: [], repliedUser: false },
  });
}
