import { describe, expect, test } from "bun:test";
import { GatewayIntentBits, IntentsBitField } from "discord.js";
import { createDiscordClient } from "../../src/bot/client.ts";

describe("createDiscordClient", () => {
  test("declares Guilds + GuildMembers — no message/DM intents (decision 6 + onboarding)", () => {
    const c = createDiscordClient();
    const bits = new IntentsBitField(c.options.intents);
    expect(bits.has(GatewayIntentBits.Guilds)).toBe(true);
    // GuildMembers (privileged) is required for guildMemberAdd → guest-role assignment.
    expect(bits.has(GatewayIntentBits.GuildMembers)).toBe(true);
    // Excluded — onboarding state rides on button customIds (not reactions), and the bot
    // never reads message content, so keep the attack surface minimal.
    expect(bits.has(GatewayIntentBits.GuildMessages)).toBe(false);
    expect(bits.has(GatewayIntentBits.MessageContent)).toBe(false);
    expect(bits.has(GatewayIntentBits.DirectMessages)).toBe(false);
    expect(bits.has(GatewayIntentBits.GuildMessageReactions)).toBe(false);
  });

  test("suppresses mentions on replies (decision 8)", () => {
    const c = createDiscordClient();
    expect(c.options.allowedMentions).toEqual({ parse: [], repliedUser: false });
  });
});
