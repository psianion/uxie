import { describe, expect, test } from "bun:test";
import { Collection } from "discord.js";
import { buildCommandCollection, type LoadedCommand } from "../../src/bot/command-loader.ts";

describe("buildCommandCollection", () => {
  test("builds a Collection keyed by command name", () => {
    const mods: LoadedCommand[] = [
      { data: { name: "ping" } as any, execute: async () => {} },
      { data: { name: "ask" } as any, execute: async () => {} },
    ];
    const c = buildCommandCollection(mods);
    expect(c).toBeInstanceOf(Collection);
    expect(c.get("ping")).toBeTruthy();
    expect(c.get("ask")).toBeTruthy();
    expect(c.size).toBe(2);
  });

  test("throws on duplicate command names", () => {
    const mods: LoadedCommand[] = [
      { data: { name: "ping" } as any, execute: async () => {} },
      { data: { name: "ping" } as any, execute: async () => {} },
    ];
    expect(() => buildCommandCollection(mods)).toThrow(/duplicate/);
  });
});
