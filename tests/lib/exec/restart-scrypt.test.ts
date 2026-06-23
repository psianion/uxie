import { describe, expect, test, mock } from "bun:test";
import {
  parseRestartCommand,
  createRestartGuard,
  redactStderr,
  restartScrypt,
  type RestartRunner,
} from "../../../src/lib/exec/restart-scrypt.ts";
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

describe("createRestartGuard", () => {
  test("single-flight: second acquire is rejected until release", () => {
    const g = createRestartGuard(() => 1_000_000);
    expect(g.tryAcquire().ok).toBe(true);
    const second = g.tryAcquire();
    expect(second.ok).toBe(false);
    expect((second as any).reason).toBe("in_flight");
  });

  test("cooldown: blocks within 60s of the previous release, allows after", () => {
    let t = 1_000_000;
    const g = createRestartGuard(() => t);
    expect(g.tryAcquire().ok).toBe(true);
    g.release(); // lastAt = t
    t += 30_000;
    const blocked = g.tryAcquire();
    expect(blocked.ok).toBe(false);
    expect((blocked as any).reason).toBe("cooldown");
    t += 31_000; // now 61s since release
    expect(g.tryAcquire().ok).toBe(true);
  });
});

describe("redactStderr", () => {
  test("strips secret substrings and caps length", () => {
    const out = redactStderr("boom token=SUPERSECRET tail", ["SUPERSECRET"]);
    expect(out).not.toContain("SUPERSECRET");
    expect(out).toContain("***");
    expect(redactStderr("x".repeat(2000), []).length).toBeLessThanOrEqual(501);
  });
});

describe("restartScrypt", () => {
  test("runs the parsed argv with a secret-free env and a timeout", async () => {
    let seen: any = null;
    const runner: RestartRunner = async (argv, o) => {
      seen = { argv, o };
      return { code: 0, stderr: "" };
    };
    const res = await restartScrypt(
      { command: "docker compose restart scrypt", secrets: ["TOK"] },
      runner,
      { cwd: "/proj", timeoutMs: 30_000 },
    );
    expect(res.ok).toBe(true);
    expect(seen.argv).toEqual(["docker", "compose", "restart", "scrypt"]);
    expect(seen.o.cwd).toBe("/proj");
    expect(seen.o.timeoutMs).toBe(30_000);
    expect(Object.values(seen.o.env)).not.toContain("TOK"); // secrets never passed down
  });

  test("non-zero exit → ok:false with redacted stderr", async () => {
    const runner: RestartRunner = async () => ({ code: 1, stderr: "fail TOKVAL here" });
    const res = await restartScrypt({ command: "docker restart scrypt", secrets: ["TOKVAL"] }, runner);
    expect(res.ok).toBe(false);
    expect(res.code).toBe(1);
    expect(res.stderr).not.toContain("TOKVAL");
  });
});
