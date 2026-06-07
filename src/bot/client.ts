// Discord Client factory (ratified decision 6). Intents: Guilds ONLY — enough for
// interactionCreate (slash commands). NO message intents (no MessageContent privilege),
// NO DirectMessages, NO GuildMembers — minimum attack surface. allowedMentions
// { parse: [] } so echoing user text in replies never pings anyone (decision 8).
import { Client, GatewayIntentBits } from "discord.js";

export function createDiscordClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds],
    allowedMentions: { parse: [], repliedUser: false },
  });
}
