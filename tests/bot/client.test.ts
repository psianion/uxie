import { describe, expect, test } from "bun:test";
import { GatewayIntentBits, IntentsBitField, Partials } from "discord.js";
import { createDiscordClient } from "../../src/bot/client.ts";

describe("createDiscordClient", () => {
  test("declares exactly Guilds + GuildMessages + MessageContent intents (decision 6)", () => {
    const c = createDiscordClient();
    const bits = new IntentsBitField(c.options.intents);
    expect(bits.has(GatewayIntentBits.Guilds)).toBe(true);
    expect(bits.has(GatewayIntentBits.GuildMessages)).toBe(true);
    expect(bits.has(GatewayIntentBits.MessageContent)).toBe(true);
    // Excluded by decision 6 — keep attack surface minimal.
    expect(bits.has(GatewayIntentBits.DirectMessages)).toBe(false);
    expect(bits.has(GatewayIntentBits.GuildMembers)).toBe(false);
  });

  test("registers Channel + Message partials (decision 6)", () => {
    const c = createDiscordClient();
    expect(c.options.partials).toContain(Partials.Channel);
    expect(c.options.partials).toContain(Partials.Message);
  });

  test("suppresses mentions on replies (decision 8)", () => {
    const c = createDiscordClient();
    expect(c.options.allowedMentions).toEqual({ parse: [], repliedUser: false });
  });
});
