import { describe, expect, test } from "bun:test";
import { GatewayIntentBits, IntentsBitField } from "discord.js";
import { createDiscordClient } from "../../src/bot/client.ts";

describe("createDiscordClient", () => {
  test("declares exactly the Guilds intent — no message/privileged intents (decision 6)", () => {
    const c = createDiscordClient();
    const bits = new IntentsBitField(c.options.intents);
    expect(bits.has(GatewayIntentBits.Guilds)).toBe(true);
    // Excluded — slash-only bot, keep attack surface minimal.
    expect(bits.has(GatewayIntentBits.GuildMessages)).toBe(false);
    expect(bits.has(GatewayIntentBits.MessageContent)).toBe(false);
    expect(bits.has(GatewayIntentBits.DirectMessages)).toBe(false);
    expect(bits.has(GatewayIntentBits.GuildMembers)).toBe(false);
  });

  test("suppresses mentions on replies (decision 8)", () => {
    const c = createDiscordClient();
    expect(c.options.allowedMentions).toEqual({ parse: [], repliedUser: false });
  });
});
