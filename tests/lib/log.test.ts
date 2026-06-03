import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { createLogger } from "../../src/lib/log.ts";

describe("logger", () => {
  let spy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    spy = spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    spy.mockRestore();
  });

  test("emits JSON with level, msg, and fields", () => {
    const log = createLogger();
    log.info("hello", { k: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(spy.mock.calls[0][0]);
    expect(line.level).toBe("info");
    expect(line.msg).toBe("hello");
    expect(line.k).toBe(1);
    expect(typeof line.t).toBe("string");
  });

  test("child merges scoped fields", () => {
    const log = createLogger().child({ interactionId: "abc" });
    log.warn("boom");
    const line = JSON.parse(spy.mock.calls[0][0]);
    expect(line.interactionId).toBe("abc");
    expect(line.level).toBe("warn");
  });

  test("error includes serialized error", () => {
    const log = createLogger();
    log.error("crash", { err: new Error("root") });
    const line = JSON.parse(spy.mock.calls[0][0]);
    expect(line.err).toContain("root");
  });

  test("redacts BOT_TOKEN / AUTH / SECRET / KEY substrings (UXIE §17.2)", () => {
    const log = createLogger();
    log.info("boot", {
      DISCORD_BOT_TOKEN: "supersecret",
      SCRYPT_AUTH: "bearer-abc",
      SOMETHING_SECRET: "x",
      MY_API_KEY: "y",
      safe: "value",
    });
    const line = JSON.parse(spy.mock.calls[0][0]);
    expect(line.DISCORD_BOT_TOKEN).toBe("[REDACTED]");
    expect(line.SCRYPT_AUTH).toBe("[REDACTED]");
    expect(line.SOMETHING_SECRET).toBe("[REDACTED]");
    expect(line.MY_API_KEY).toBe("[REDACTED]");
    expect(line.safe).toBe("value");
  });

  test("redacts nested secret keys (recursive serializer)", () => {
    const log = createLogger();
    log.info("nested", {
      config: { SCRYPT_AUTH: "bearer-abc", host: "scrypt" },
      safe: "ok",
    });
    const line = JSON.parse(spy.mock.calls[0][0]);
    expect(line.config.SCRYPT_AUTH).toBe("[REDACTED]");
    expect(line.config.host).toBe("scrypt");
    expect(line.safe).toBe("ok");
  });

  test("is cycle-safe", () => {
    const log = createLogger();
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => log.info("cyclic", { a })).not.toThrow();
    const line = JSON.parse(spy.mock.calls[0][0]);
    expect(line.a.name).toBe("a");
    expect(line.a.self).toBe("[Circular]");
  });
});
