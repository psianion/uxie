// Discord Client factory (ratified decision 6). Intents: Guilds + GuildMembers. Guilds is
// enough for interactionCreate (slash commands + buttons); GuildMembers (privileged) is added
// ONLY for guildMemberAdd, which drives guest-role assignment on join. Onboarding state rides
// entirely on button customIds (NOT emoji reactions), so NO GuildMessageReactions intent and
// NO Partials are needed. NO message intents (no MessageContent privilege), NO DirectMessages —
// minimum attack surface (sending DMs needs no intent). allowedMentions { parse: [] } so
// echoing user text in replies never pings anyone (decision 8).
import { Client, GatewayIntentBits } from "discord.js";

export function createDiscordClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    allowedMentions: { parse: [], repliedUser: false },
  });
}
