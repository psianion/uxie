import { describe, expect, test } from "bun:test";
import { parseRestartCommand } from "../../../src/lib/exec/restart-scrypt.ts";
import { ConfigError } from "../../../src/lib/errors.ts";

describe("parseRestartCommand", () => {
  test("splits a clean docker command into argv", () => {
    expect(parseRestartCommand("docker compose restart scrypt")).toEqual([
      "docker", "compose", "restart", "scrypt",
    ]);
  });
  test("collapses extra whitespace", () => {
    expect(parseRestartCommand("docker   restart    scrypt")).toEqual(["docker", "restart", "scrypt"]);
  });
  test.each([";", "|", "&", "$", ">", "<", "`", "(", ")", '"', "'", "\\"])(
    "rejects shell metacharacter %p",
    (meta) => {
      expect(() => parseRestartCommand(`docker restart scrypt ${meta}`)).toThrow(ConfigError);
    },
  );
  test("rejects empty / whitespace-only", () => {
    expect(() => parseRestartCommand("   ")).toThrow(ConfigError);
  });
  test("rejects a binary outside the allowlist", () => {
    expect(() => parseRestartCommand("rm -rf /")).toThrow(ConfigError);
    expect(() => parseRestartCommand("systemctl restart scrypt")).toThrow(ConfigError);
  });
});
