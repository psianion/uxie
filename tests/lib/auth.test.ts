import { describe, expect, test } from "bun:test";
import { assertOwner } from "../../src/lib/auth.ts";
import { NotOwnerError } from "../../src/lib/errors.ts";

describe("assertOwner", () => {
  test("passes when actor.user.id matches ownerId", () => {
    expect(() => assertOwner({ user: { id: "123" } } as any, "123")).not.toThrow();
  });
  test("passes for Message-shaped actors via author.id", () => {
    expect(() => assertOwner({ author: { id: "123" } } as any, "123")).not.toThrow();
  });
  test("throws NotOwnerError otherwise", () => {
    expect(() => assertOwner({ user: { id: "999" } } as any, "123")).toThrow(NotOwnerError);
  });
  test("throws NotOwnerError when actor has neither user nor author", () => {
    expect(() => assertOwner({} as any, "123")).toThrow(NotOwnerError);
  });
});
