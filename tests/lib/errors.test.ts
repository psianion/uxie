import { describe, expect, test } from "bun:test";
import {
  UxieError,
  NotOwnerError,
  ScryptError,
  ScryptTimeoutError,
  ConfigError,
} from "../../src/lib/errors.ts";

describe("errors", () => {
  test("UxieError carries code and message", () => {
    const e = new UxieError("boom", "something broke");
    expect(e.code).toBe("boom");
    expect(e.message).toBe("something broke");
    expect(e.toUserMessage()).toBe("boom: something broke");
  });

  test("subclasses preserve their names", () => {
    expect(new NotOwnerError("not_owner", "x").name).toBe("NotOwnerError");
    expect(new ScryptError("scrypt_timeout", "x").name).toBe("ScryptError");
    expect(new ConfigError("config", "x").name).toBe("ConfigError");
  });

  test("ScryptTimeoutError is a ScryptError subclass with its own name", () => {
    const e = new ScryptTimeoutError("scrypt_timeout", "timed out");
    expect(e).toBeInstanceOf(ScryptError);
    expect(e).toBeInstanceOf(UxieError);
    expect(e.name).toBe("ScryptTimeoutError");
  });

  test("cause is retained", () => {
    const root = new Error("root");
    const e = new ScryptError("scrypt_server", "wrapped", root);
    expect(e.cause).toBe(root);
  });
});
