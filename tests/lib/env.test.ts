import { describe, expect, test } from "bun:test";
import { parseEnv } from "../../src/lib/env.ts";

const complete = {
  DISCORD_BOT_TOKEN: "t",
  DISCORD_APP_ID: "a",
  DISCORD_DEV_GUILD_ID: "g",
  DISCORD_OWNER_ID: "o",
  SCRYPT_SERVER_URL: "http://scrypt:3000",
  SCRYPT_MCP_URL: "http://scrypt:3000/mcp",
  SCRYPT_AUTH: "b",
};

describe("parseEnv", () => {
  test("returns a typed object when all vars present", () => {
    const env = parseEnv(complete);
    expect(env.DISCORD_BOT_TOKEN).toBe("t");
    expect(env.SCRYPT_SERVER_URL).toBe("http://scrypt:3000");
  });

  test.each([
    "DISCORD_BOT_TOKEN",
    "DISCORD_APP_ID",
    "DISCORD_DEV_GUILD_ID",
    "DISCORD_OWNER_ID",
    "SCRYPT_SERVER_URL",
    "SCRYPT_MCP_URL",
    "SCRYPT_AUTH",
  ])("throws ConfigError when %s is missing", (missing) => {
    const partial = { ...complete, [missing]: undefined };
    expect(() => parseEnv(partial)).toThrow(/config/);
  });

  test("ConfigError message names the failed field", () => {
    const partial = { ...complete, SCRYPT_AUTH: undefined } as any;
    expect(() => parseEnv(partial)).toThrow(/SCRYPT_AUTH/);
  });
});
