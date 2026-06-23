import { describe, expect, test } from "bun:test";
import { ButtonStyle } from "discord.js";
import { buildStatusContainer, ACCENT, type StatusModel } from "../../../src/lib/ui/status-container.ts";

function model(over: Partial<StatusModel> = {}): StatusModel {
  return {
    title: "Uxie · Health Check",
    health: "ok",
    badge: "🟢 OK",
    rows: [
      { icon: "⚡", label: "Gateway", value: "connected · 42 ms" },
      { icon: "🗄", label: "Scrypt", value: "reachable · 12 ms" },
    ],
    footer: "uxie v0.1.0 · localhost",
    ...over,
  };
}

describe("buildStatusContainer", () => {
  test("accent colour tracks health", () => {
    expect(buildStatusContainer(model({ health: "ok" })).toJSON().accent_color).toBe(ACCENT.ok);
    expect(buildStatusContainer(model({ health: "degraded" })).toJSON().accent_color).toBe(ACCENT.degraded);
    expect(buildStatusContainer(model({ health: "down" })).toJSON().accent_color).toBe(ACCENT.down);
  });

  test("renders title+badge, every row, and footer as text", () => {
    const json = JSON.stringify(buildStatusContainer(model()).toJSON());
    expect(json).toContain("Uxie · Health Check");
    expect(json).toContain("🟢 OK");
    expect(json).toContain("Gateway");
    expect(json).toContain("connected · 42 ms");
    expect(json).toContain("Scrypt");
    expect(json).toContain("uxie v0.1.0 · localhost");
  });

  test("no action row when buttons absent", () => {
    const comps = buildStatusContainer(model()).toJSON().components;
    expect(comps.some((c: any) => c.type === 1)).toBe(false); // ActionRow = type 1
  });

  test("renders buttons with exact custom ids, labels, styles", () => {
    const m = model({
      buttons: [
        { id: "ping:refresh", label: "Refresh", emoji: "🔄", style: ButtonStyle.Secondary },
        { id: "ping:restart", label: "Restart Scrypt", emoji: "🔧", style: ButtonStyle.Danger, disabled: true },
      ],
    });
    const row = buildStatusContainer(m).toJSON().components.find((c: any) => c.type === 1) as any;
    expect(row).toBeDefined();
    const ids = row.components.map((b: any) => b.custom_id);
    expect(ids).toEqual(["ping:refresh", "ping:restart"]);
    const restart = row.components.find((b: any) => b.custom_id === "ping:restart");
    expect(restart.style).toBe(ButtonStyle.Danger);
    expect(restart.disabled).toBe(true);
  });
});
