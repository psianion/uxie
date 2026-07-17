import { describe, expect, test } from "bun:test";
import { assertGuildConfig, guildConfig } from "../../src/config/guild.ts";
import { ConfigError } from "../../src/lib/errors.ts";

// 18-digit snowflake-like ids (pass /^[0-9]{17,20}$/).
const R1 = "111111111111111111";
const R2 = "222222222222222222";
const CH1 = "444444444444444444";
const CH2 = "555555555555555555";
const GUEST = "666666666666666666";

// A fully-valid config built by spreading guildConfig and overriding every field.
function validConfig(): typeof guildConfig {
  return {
    ...guildConfig,
    welcomeChannelId: CH1,
    accessRequestsChannelId: CH2,
    guestRoleId: GUEST,
    pickableRoleIds: [R1, R2],
    welcomeMessage: "Pick a role below.",
    roleMeta: {},
  } as unknown as typeof guildConfig;
}

// Helper: assert assertGuildConfig(cfg) throws a ConfigError with code guild_config naming `field`.
function expectReject(cfg: typeof guildConfig, field: string): void {
  let caught: unknown;
  try {
    assertGuildConfig(cfg);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  expect((caught as ConfigError).code).toBe("guild_config");
  expect((caught as ConfigError).message).toContain(field);
}

describe("assertGuildConfig", () => {
  test("accepts a fully-valid config (no throw)", () => {
    expect(() => assertGuildConfig(validConfig())).not.toThrow();
  });

  test("accepts a single-entry pickableRoleIds", () => {
    const cfg = { ...validConfig(), pickableRoleIds: [R1] } as unknown as typeof guildConfig;
    expect(() => assertGuildConfig(cfg)).not.toThrow();
  });

  test("the committed default config (real operator ids) is accepted", () => {
    expect(() => assertGuildConfig()).not.toThrow();
  });

  test("rejects a placeholder at a top-level id", () => {
    const cfg = {
      ...validConfig(),
      welcomeChannelId: "CHANNEL_ID_HERE",
    } as unknown as typeof guildConfig;
    expectReject(cfg, "welcomeChannelId");
  });

  test("rejects a placeholder inside pickableRoleIds[i]", () => {
    const cfg = {
      ...validConfig(),
      pickableRoleIds: [R1, "ROLE_ID_HERE"],
    } as unknown as typeof guildConfig;
    expectReject(cfg, "pickableRoleIds[1]");
  });

  test("rejects a malformed (non-snowflake) id", () => {
    const cfg = { ...validConfig(), guestRoleId: "123" } as unknown as typeof guildConfig;
    expectReject(cfg, "guestRoleId");
  });

  test("rejects a malformed (non-snowflake) pickable role id", () => {
    const cfg = {
      ...validConfig(),
      pickableRoleIds: [R1, "15612578644018"], // the invalid id the operator supplied
    } as unknown as typeof guildConfig;
    expectReject(cfg, "pickableRoleIds[1]");
  });

  test("rejects an empty pickableRoleIds", () => {
    const cfg = { ...validConfig(), pickableRoleIds: [] } as unknown as typeof guildConfig;
    expectReject(cfg, "pickableRoleIds");
  });

  test("rejects a duplicate roleId in pickableRoleIds", () => {
    const cfg = {
      ...validConfig(),
      pickableRoleIds: [R1, R1],
    } as unknown as typeof guildConfig;
    expectReject(cfg, "duplicate roleId");
  });

  test("rejects a roleMeta key that is not a pickable role", () => {
    const cfg = {
      ...validConfig(),
      roleMeta: { "999999999999999999": { blurb: "x" } },
    } as unknown as typeof guildConfig;
    expectReject(cfg, "roleMeta key");
  });

  test("rejects a malformed unlockedChannelIds snowflake", () => {
    const cfg = {
      ...validConfig(),
      roleMeta: { [R1]: { unlockedChannelIds: ["123"] } },
    } as unknown as typeof guildConfig;
    expectReject(cfg, "unlockedChannelIds");
  });

  test("accepts an empty logChannelId (sink disabled)", () => {
    const cfg = { ...validConfig(), logChannelId: "" } as unknown as typeof guildConfig;
    expect(() => assertGuildConfig(cfg)).not.toThrow();
  });

  test("accepts a valid non-empty logChannelId", () => {
    const cfg = { ...validConfig(), logChannelId: CH1 } as unknown as typeof guildConfig;
    expect(() => assertGuildConfig(cfg)).not.toThrow();
  });

  test("rejects a malformed non-empty logChannelId", () => {
    const cfg = { ...validConfig(), logChannelId: "123" } as unknown as typeof guildConfig;
    expectReject(cfg, "logChannelId");
  });

  test("triageChannelId: empty accepted (triage off), malformed rejected", () => {
    const off = { ...validConfig(), triageChannelId: "" } as unknown as typeof guildConfig;
    expect(() => assertGuildConfig(off)).not.toThrow();
    const bad = { ...validConfig(), triageChannelId: "123" } as unknown as typeof guildConfig;
    expectReject(bad, "triageChannelId");
  });
});
