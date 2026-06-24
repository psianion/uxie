// Pure map of the /create-channel `type` choice string → discord.js ChannelType. Throws
// ConfigError on any unknown value. The ChannelTypeChoice union is exported so the command
// builder derives its four choices (text|voice|forum|announcement) from this one place.
import { ChannelType } from "discord.js";
import { ConfigError } from "../../lib/errors.ts";

export type ChannelTypeChoice = "text" | "voice" | "forum" | "announcement";

export function mapChannelType(choice: string): ChannelType {
  switch (choice) {
    case "text":
      return ChannelType.GuildText;
    case "voice":
      return ChannelType.GuildVoice;
    case "forum":
      return ChannelType.GuildForum;
    case "announcement":
      return ChannelType.GuildAnnouncement;
    default:
      throw new ConfigError("channel_type", `unknown channel type: ${choice}`);
  }
}
