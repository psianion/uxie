import { describe, expect, test } from "bun:test";
import { Collection } from "discord.js";
import { mergeCommands } from "../../src/lib/merge-commands.ts";
import { buildCommandCollection, type LoadedCommand } from "../../src/bot/command-loader.ts";
import { ConfigError } from "../../src/lib/errors.ts";

// Minimal LoadedCommand-shaped stub keyed by name.
function stub(name: string): LoadedCommand {
  return { data: { name }, execute: async () => {} };
}

function collectionOf(...names: string[]): Collection<string, LoadedCommand> {
  return buildCommandCollection(names.map(stub));
}

describe("mergeCommands", () => {
  test("disjoint collections merge to the union of names", () => {
    const a = collectionOf("ping", "create-category");
    const b = collectionOf("create-channel");
    const merged = mergeCommands(a, b);
    expect(merged.size).toBe(3);
    expect([...merged.keys()].sort()).toEqual(["create-category", "create-channel", "ping"]);
    expect(merged.get("ping")).toBe(a.get("ping")!);
  });

  test("duplicate name across collections throws ConfigError(command_registry)", () => {
    const a = collectionOf("dup");
    const b = collectionOf("dup");
    let caught: unknown;
    try {
      mergeCommands(a, b);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).code).toBe("command_registry");
    expect((caught as ConfigError).message).toContain("dup");
  });

  test("zero args returns an empty collection", () => {
    const merged = mergeCommands();
    expect(merged).toBeInstanceOf(Collection);
    expect(merged.size).toBe(0);
  });

  test("a single collection passes through unchanged in content", () => {
    const a = collectionOf("only");
    const merged = mergeCommands(a);
    expect(merged.size).toBe(1);
    expect(merged.has("only")).toBe(true);
  });
});
