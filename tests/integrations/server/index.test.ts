import { describe, expect, test } from "bun:test";
import { Collection } from "discord.js";
import { buildServerModule } from "../../../src/integrations/server/index.ts";
import type { Env } from "../../../src/lib/env.ts";

describe("buildServerModule", () => {
  test("returns { commands } as a Collection of exactly create-category + create-channel + create-role", () => {
    // env is unused by buildServerModule; an empty cast is acceptable per the plan.
    const mod = buildServerModule({} as Env);
    expect(mod.commands).toBeInstanceOf(Collection);
    expect(mod.commands.size).toBe(3);
    expect(mod.commands.has("create-category")).toBe(true);
    expect(mod.commands.has("create-channel")).toBe(true);
    expect(mod.commands.has("create-role")).toBe(true);
  });

  test("each command exposes data + execute", () => {
    const mod = buildServerModule({} as Env);
    for (const cmd of mod.commands.values()) {
      expect(typeof cmd.data.name).toBe("string");
      expect(typeof cmd.execute).toBe("function");
    }
  });
});
