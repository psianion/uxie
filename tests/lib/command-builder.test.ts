import { describe, expect, test } from "bun:test";
import {
  SlashCommandBuilder,
  InteractionContextType,
  ApplicationIntegrationType,
} from "discord.js";
import { withOwnerGate, applyDefaultBuilderShape } from "../../src/lib/command-builder.ts";

describe("withOwnerGate", () => {
  test("applies the three required setters", () => {
    const b = withOwnerGate(new SlashCommandBuilder().setName("ping").setDescription("p"));
    const json = b.toJSON();
    expect(json.contexts).toEqual([InteractionContextType.Guild]);
    expect(json.integration_types).toEqual([ApplicationIntegrationType.GuildInstall]);
    expect(json.default_member_permissions).toBe("0");
  });

  test("returns the same builder instance for chaining", () => {
    const b = new SlashCommandBuilder().setName("x").setDescription("x");
    expect(withOwnerGate(b)).toBe(b);
  });
});

describe("applyDefaultBuilderShape", () => {
  test("applies the three required setters (decision 7)", () => {
    const b = applyDefaultBuilderShape(
      new SlashCommandBuilder().setName("ask").setDescription("a"),
    );
    const json = b.toJSON();
    expect(json.contexts).toEqual([InteractionContextType.Guild]);
    expect(json.integration_types).toEqual([ApplicationIntegrationType.GuildInstall]);
    expect(json.default_member_permissions).toBe("0");
  });

  test("returns the same builder instance", () => {
    const b = new SlashCommandBuilder().setName("y").setDescription("y");
    expect(applyDefaultBuilderShape(b)).toBe(b);
  });
});
