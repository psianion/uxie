// Discord Client factory (ratified decision 6). Intents: Guilds + GuildMembers. Guilds is
// enough for interactionCreate (slash commands + buttons); GuildMembers (privileged) is added
// ONLY for guildMemberAdd, which drives guest-role assignment on join. Onboarding state rides
// entirely on button customIds (NOT emoji reactions), so NO GuildMessageReactions intent and
// NO Partials are needed. NO DirectMessages — minimum attack surface (sending DMs needs no
// intent). allowedMentions { parse: [] } so echoing user text in replies never pings anyone
// (decision 8).
//
// GuildMessages + MessageContent (both privileged) are added iff `relayEnabled` — the para-raid
// relay (D5/D1) reads owner messages in session threads to forward as turns. MessageContent
// must also be flipped on in the Discord dev portal (Bot > Privileged Gateway Intents) or login
// fails with "disallowed intents". v1 deployments (para-raid env group unset) keep today's
// minimal intent set — zero behavior change.
import { Client, GatewayIntentBits } from "discord.js";

export function createDiscordClient(relayEnabled: boolean): Client {
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers];
  if (relayEnabled) {
    intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  }
  return new Client({
    intents,
    allowedMentions: { parse: [], repliedUser: false },
  });
}
