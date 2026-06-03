// Discord Client factory (ratified decision 6). Intents: Guilds (interactionCreate) +
// GuildMessages (#inbox messageCreate) + MessageContent (PRIVILEGED — toggled in the dev
// portal) ONLY. NO DirectMessages, NO GuildMembers — minimum attack surface. Partials
// Channel + Message so the #inbox handler receives uncached payloads. allowedMentions
// { parse: [] } so echoing user text in replies never pings anyone (decision 8).
import { Client, GatewayIntentBits, Partials } from "discord.js";

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
    allowedMentions: { parse: [], repliedUser: false },
  });
}
