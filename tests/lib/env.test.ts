import { describe, expect, test } from "bun:test";
import { parseEnv } from "../../src/lib/env.ts";

const complete = {
  DISCORD_BOT_TOKEN: "t",
  DISCORD_APP_ID: "a",
  DISCORD_DEV_GUILD_ID: "g",
  DISCORD_OWNER_ID: "o",
  SCRYPT_SERVER_URL: "http://localhost:3777",
  SCRYPT_AUTH: "b",
};

describe("parseEnv", () => {
  test("returns a typed object when all vars present", () => {
    const env = parseEnv(complete);
    expect(env.DISCORD_BOT_TOKEN).toBe("t");
    expect(env.SCRYPT_SERVER_URL).toBe("http://localhost:3777");
  });

  test.each([
    "DISCORD_BOT_TOKEN",
    "DISCORD_APP_ID",
    "DISCORD_DEV_GUILD_ID",
    "DISCORD_OWNER_ID",
    "SCRYPT_SERVER_URL",
    "SCRYPT_AUTH",
  ])("throws ConfigError when %s is missing", (missing) => {
    const partial = { ...complete, [missing]: undefined };
    expect(() => parseEnv(partial)).toThrow(/config/);
  });

  test("ConfigError message names the failed field", () => {
    const partial = { ...complete, SCRYPT_AUTH: undefined } as any;
    expect(() => parseEnv(partial)).toThrow(/SCRYPT_AUTH/);
  });

  test("ALLOW_SCRYPT_RESTART defaults false; SCRYPT_RESTART_CMD defaults to docker compose restart scrypt", () => {
    const env = parseEnv(complete);
    expect(env.ALLOW_SCRYPT_RESTART).toBe(false);
    expect(env.SCRYPT_RESTART_CMD).toBe("docker compose restart scrypt");
  });

  test("ALLOW_SCRYPT_RESTART parses '1' and 'true' as true", () => {
    expect(parseEnv({ ...complete, ALLOW_SCRYPT_RESTART: "1" }).ALLOW_SCRYPT_RESTART).toBe(true);
    expect(parseEnv({ ...complete, ALLOW_SCRYPT_RESTART: "true" }).ALLOW_SCRYPT_RESTART).toBe(true);
  });

  test("when restart allowed, an invalid SCRYPT_RESTART_CMD fails boot", () => {
    expect(() =>
      parseEnv({ ...complete, ALLOW_SCRYPT_RESTART: "1", SCRYPT_RESTART_CMD: "rm -rf /" }),
    ).toThrow();
  });

  test("when restart NOT allowed, a weird SCRYPT_RESTART_CMD is ignored (not validated)", () => {
    expect(() => parseEnv({ ...complete, SCRYPT_RESTART_CMD: "rm -rf /" })).not.toThrow();
  });

  test("UXIE_ENV defaults to 'local' and passes through a custom label", () => {
    expect(parseEnv(complete).UXIE_ENV).toBe("local");
    expect(parseEnv({ ...complete, UXIE_ENV: "vps" }).UXIE_ENV).toBe("vps");
  });
});

// UX-SEC-002: the SCRYPT_AUTH bearer must never cross the wire in cleartext, so SCRYPT_SERVER_URL
// accepts https:// to any host but http:// only to a loopback literal. A plaintext http:// to a
// remote host fails boot (naming the field) rather than silently leaking the bearer.
describe("parseEnv — Scrypt URL scheme enforcement (UX-SEC-002)", () => {
  const url = (server: string) => ({ ...complete, SCRYPT_SERVER_URL: server });

  test("accepts http:// to a loopback host (localhost / 127.0.0.1 / [::1])", () => {
    expect(() => parseEnv(url("http://localhost:3777"))).not.toThrow();
    expect(() => parseEnv(url("http://127.0.0.1:3000"))).not.toThrow();
    expect(() => parseEnv(url("http://[::1]:3000"))).not.toThrow();
  });

  test("accepts any https:// host", () => {
    expect(() => parseEnv(url("https://scrypt.example.com"))).not.toThrow();
    expect(() => parseEnv(url("https://scrypt:3000"))).not.toThrow();
  });

  test("rejects http:// to a non-loopback host, naming SCRYPT_SERVER_URL", () => {
    expect(() => parseEnv(url("http://10.0.0.5:3000"))).toThrow(/SCRYPT_SERVER_URL/);
    expect(() => parseEnv(url("http://scrypt:3000"))).toThrow(/SCRYPT_SERVER_URL/);
  });
});
