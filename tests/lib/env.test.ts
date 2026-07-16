import { describe, expect, test } from "bun:test";
import { parseEnv, paraRaidEnabled } from "../../src/lib/env.ts";

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

// D4/A11: PARARAID_SOCKET/PARARAID_ADAPTER_TOKEN/PARARAID_SIGNING_SECRET are all-or-none; the
// module (and paraRaidEnabled) is off when absent, and boot fails loudly on a partial group.
describe("parseEnv — para-raid env group (D4)", () => {
  const paraRaidVars = {
    PARARAID_SOCKET: "/run/para-raid.sock",
    PARARAID_ADAPTER_TOKEN: "adapter-token",
    PARARAID_SIGNING_SECRET: "signing-secret",
  };

  test("group absent: boots fine, paraRaidEnabled is false", () => {
    const env = parseEnv(complete);
    expect(paraRaidEnabled(env)).toBe(false);
  });

  test("group fully present: boots fine, paraRaidEnabled is true", () => {
    const env = parseEnv({ ...complete, ...paraRaidVars });
    expect(paraRaidEnabled(env)).toBe(true);
    expect(env.PARARAID_SOCKET).toBe("/run/para-raid.sock");
  });

  test.each(["PARARAID_SOCKET", "PARARAID_ADAPTER_TOKEN", "PARARAID_SIGNING_SECRET"])(
    "partial group (missing %s) fails boot, naming the missing field",
    (missing) => {
      const partial = { ...complete, ...paraRaidVars, [missing]: undefined };
      expect(() => parseEnv(partial)).toThrow(new RegExp(missing));
    },
  );

  test("PARARAID_WEBHOOK_PORT defaults to 18901 and coerces a numeric string", () => {
    expect(parseEnv(complete).PARARAID_WEBHOOK_PORT).toBe(18901);
    expect(parseEnv({ ...complete, PARARAID_WEBHOOK_PORT: "9000" }).PARARAID_WEBHOOK_PORT).toBe(9000);
  });

  // U6: LIBRARIAN_CHANNEL_ID is optional and OUTSIDE the all-or-none group — absent just means
  // the librarian handler is off.
  test("LIBRARIAN_CHANNEL_ID is optional; absent means undefined, without the para-raid group too", () => {
    expect(parseEnv(complete).LIBRARIAN_CHANNEL_ID).toBeUndefined();
    expect(parseEnv({ ...complete, ...paraRaidVars }).LIBRARIAN_CHANNEL_ID).toBeUndefined();
  });

  test("LIBRARIAN_CHANNEL_ID accepts a snowflake and rejects a non-snowflake, naming the field", () => {
    const id = "123456789012345678";
    expect(parseEnv({ ...complete, LIBRARIAN_CHANNEL_ID: id }).LIBRARIAN_CHANNEL_ID).toBe(id);
    expect(() => parseEnv({ ...complete, LIBRARIAN_CHANNEL_ID: "librarian-channel" })).toThrow(
      /LIBRARIAN_CHANNEL_ID/,
    );
  });
});
