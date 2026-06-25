import { describe, expect, test } from "bun:test";
import { buildCommandRegistry } from "../../src/bot/command-registry.ts";
import { buildScryptModule } from "../../src/integrations/scrypt/index.ts";
import type { Env } from "../../src/lib/env.ts";

// Minimal hand-built Env. buildScryptModule constructs a ScryptRestClient/ScryptMcpClient from
// the URLs and a ping component handler — provide valid-URL strings so nothing throws at
// construction. ALLOW_SCRYPT_RESTART:false keeps the restart deps unwired.
const env = {
  DISCORD_BOT_TOKEN: "tok",
  DISCORD_APP_ID: "app",
  DISCORD_DEV_GUILD_ID: "guild-1",
  DISCORD_OWNER_ID: "123",
  SCRYPT_SERVER_URL: "http://localhost:3777",
  SCRYPT_MCP_URL: "http://localhost:3777/mcp",
  SCRYPT_AUTH: "auth",
  ALLOW_SCRYPT_RESTART: false,
  SCRYPT_RESTART_CMD: "docker compose restart scrypt",
} as Env;

describe("buildCommandRegistry", () => {
  test("merges scrypt + server commands into one Collection", () => {
    const reg = buildCommandRegistry(env);
    expect(reg.has("ping")).toBe(true);
    expect(reg.has("create-category")).toBe(true);
    expect(reg.has("create-channel")).toBe(true);
    expect(reg.has("create-role")).toBe(true);
  });

  test("contains exactly the expected command names (no duplicates / no extras)", () => {
    const reg = buildCommandRegistry(env);
    const names = [...reg.keys()].sort();
    expect(names).toEqual(["create-category", "create-channel", "create-role", "ping"]);
  });

  test("does not throw on the real module set (no cross-module name collision)", () => {
    expect(() => buildCommandRegistry(env)).not.toThrow();
  });

  // Regression: the boot path passes its already-built scrypt module so the /ping command and
  // its component handlers share ONE ScryptRestClient. If the registry rebuilt scrypt instead,
  // the command's rest client would differ from the components', fragmenting connectivity state.
  test("uses the passed-in scrypt module's command instance (shared, not rebuilt)", () => {
    const scrypt = buildScryptModule(env);
    const reg = buildCommandRegistry(env, scrypt);
    expect(reg.get("ping")).toBe(scrypt.commands.get("ping"));
  });
});
