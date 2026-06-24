import { describe, expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { mapChannelType } from "../../../src/integrations/server/channel-type.ts";
import { ConfigError } from "../../../src/lib/errors.ts";

describe("mapChannelType", () => {
  test("text → GuildText", () => {
    expect(mapChannelType("text")).toBe(ChannelType.GuildText);
  });

  test("voice → GuildVoice", () => {
    expect(mapChannelType("voice")).toBe(ChannelType.GuildVoice);
  });

  test("forum → GuildForum", () => {
    expect(mapChannelType("forum")).toBe(ChannelType.GuildForum);
  });

  test("announcement → GuildAnnouncement", () => {
    expect(mapChannelType("announcement")).toBe(ChannelType.GuildAnnouncement);
  });

  function expectUnknown(choice: string): void {
    let caught: unknown;
    try {
      mapChannelType(choice);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).code).toBe("channel_type");
    expect((caught as ConfigError).message).toContain(choice);
  }

  test("unknown value 'category' throws ConfigError(channel_type)", () => {
    expectUnknown("category");
  });

  test("empty string throws ConfigError(channel_type)", () => {
    expectUnknown("");
  });
});
