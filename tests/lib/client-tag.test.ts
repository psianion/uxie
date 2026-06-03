import { describe, expect, test } from "bun:test";
import { makeClientTag, makeMessageClientTag } from "../../src/lib/client-tag.ts";

describe("client tag", () => {
  test("interaction tag = uxie-<id>", () => {
    expect(makeClientTag({ id: "abc" } as any)).toBe("uxie-abc");
  });
  test("message tag = uxie-msg-<id>", () => {
    expect(makeMessageClientTag({ id: "xyz" } as any)).toBe("uxie-msg-xyz");
  });
  test("is deterministic (same input -> same output, no randomUUID)", () => {
    const i = { id: "same" } as any;
    expect(makeClientTag(i)).toBe(makeClientTag(i));
    expect(makeClientTag(i)).toBe("uxie-same");
  });
  test("message tag is deterministic", () => {
    const m = { id: "m1" } as any;
    expect(makeMessageClientTag(m)).toBe(makeMessageClientTag(m));
  });
});
