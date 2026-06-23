import { describe, expect, test } from "bun:test";
import { ButtonStyle } from "discord.js";
import { buildPingModel } from "../../../../src/integrations/scrypt/ping/model.ts";

const sys = { heartbeatMs: 42, uptimeSec: 111, roundtripMs: 538 };
const opts = { version: "0.1.0", scryptHost: "localhost:3777", allowRestart: false };

describe("buildPingModel", () => {
  test("ok health → green, no recovery buttons", () => {
    const m = buildPingModel({ ok: true, latencyMs: 12 }, sys, opts);
    expect(m.health).toBe("ok");
    expect(m.badge).toContain("OK");
    expect(m.buttons?.map((b) => b.id)).toEqual(["ping:refresh"]);
  });

  test("auth reason → degraded (amber) with recovery buttons (no restart when disallowed)", () => {
    const m = buildPingModel({ ok: false, reason: "auth", latencyMs: 8 }, sys, opts);
    expect(m.health).toBe("degraded");
    const ids = m.buttons!.map((b) => b.id);
    expect(ids).toContain("ping:retry");
    expect(ids).toContain("ping:autoretry");
    expect(ids).toContain("ping:details");
    expect(ids).not.toContain("ping:restart");
  });

  test("server reason → degraded", () => {
    expect(buildPingModel({ ok: false, reason: "server", latencyMs: 9 }, sys, opts).health).toBe("degraded");
  });

  test("timeout/unreachable → down (red)", () => {
    expect(buildPingModel({ ok: false, reason: "timeout", latencyMs: 500 }, sys, opts).health).toBe("down");
    expect(buildPingModel({ ok: false, reason: "unreachable", latencyMs: 1 }, sys, opts).health).toBe("down");
  });

  test("restart button appears only when allowRestart and health != ok", () => {
    const allowed = { ...opts, allowRestart: true };
    expect(buildPingModel({ ok: true, latencyMs: 5 }, sys, allowed).buttons?.map((b) => b.id)).toEqual(["ping:refresh"]);
    const down = buildPingModel({ ok: false, reason: "unreachable", latencyMs: 1 }, sys, allowed);
    const restart = down.buttons!.find((b) => b.id === "ping:restart");
    expect(restart).toBeDefined();
    expect(restart!.style).toBe(ButtonStyle.Danger);
  });

  test("restart button disabled while restarting", () => {
    const m = buildPingModel(
      { ok: false, reason: "unreachable", latencyMs: 1 },
      sys,
      { ...opts, allowRestart: true, restarting: true },
    );
    expect(m.buttons!.find((b) => b.id === "ping:restart")!.disabled).toBe(true);
  });

  test("null heartbeat renders n/a and uptime is humanized", () => {
    const m = buildPingModel({ ok: true, latencyMs: 5 }, { heartbeatMs: null, uptimeSec: 111 }, opts);
    const gw = m.rows.find((r) => r.label === "Gateway")!;
    expect(gw.value).toContain("n/a");
    expect(m.rows.find((r) => r.label === "Uptime")!.value).toContain("1m 51s");
  });
});
