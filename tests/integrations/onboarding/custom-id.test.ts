import { describe, expect, test } from "bun:test";
import {
  decodeOnboardCustomId,
  encodeApproval,
  encodePick,
} from "../../../src/integrations/onboarding/custom-id.ts";
import { ConfigError } from "../../../src/lib/errors.ts";

const R = "111111111111111111";
const U = "222222222222222222";

describe("onboarding custom-id codec", () => {
  test("encodePick produces onboard:pick:<roleId>", () => {
    expect(encodePick(R)).toBe(`onboard:pick:${R}`);
  });

  test("encodeApproval produces onboard:<action>:<userId>:<roleId>", () => {
    expect(encodeApproval("approve", U, R)).toBe(`onboard:approve:${U}:${R}`);
    expect(encodeApproval("deny", U, R)).toBe(`onboard:deny:${U}:${R}`);
  });

  test("round-trips pick", () => {
    expect(decodeOnboardCustomId(encodePick(R))).toEqual({ kind: "pick", roleId: R });
  });

  test("round-trips approve", () => {
    expect(decodeOnboardCustomId(encodeApproval("approve", U, R))).toEqual({
      kind: "approve",
      userId: U,
      roleId: R,
    });
  });

  test("round-trips deny", () => {
    expect(decodeOnboardCustomId(encodeApproval("deny", U, R))).toEqual({
      kind: "deny",
      userId: U,
      roleId: R,
    });
  });

  // Malformed inputs all throw ConfigError(onboard_custom_id).
  function expectMalformed(raw: string): void {
    let caught: unknown;
    try {
      decodeOnboardCustomId(raw);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).code).toBe("onboard_custom_id");
  }

  test("rejects the wrong namespace", () => {
    expectMalformed(`foo:pick:${R}`);
  });

  test("rejects an unknown action", () => {
    expectMalformed(`onboard:bogus:${R}`);
  });

  test("rejects wrong arity for pick (too few colons)", () => {
    expectMalformed(`onboard:pick`);
  });

  test("rejects wrong arity for pick (too many colons)", () => {
    expectMalformed(`onboard:pick:${R}:${U}`);
  });

  test("rejects wrong arity for approval (too few colons)", () => {
    expectMalformed(`onboard:approve:${U}`);
  });

  test("rejects wrong arity for approval (too many colons)", () => {
    expectMalformed(`onboard:approve:${U}:${R}:extra`);
  });

  test("rejects a non-snowflake pick param", () => {
    expectMalformed(`onboard:pick:abc`);
  });

  test("rejects a non-snowflake approval userId", () => {
    expectMalformed(`onboard:approve:abc:${R}`);
  });

  test("rejects a non-snowflake approval roleId", () => {
    expectMalformed(`onboard:deny:${U}:abc`);
  });

  test("rejects the empty string", () => {
    expectMalformed("");
  });
});
