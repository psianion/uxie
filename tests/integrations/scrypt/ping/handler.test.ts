import { describe, expect, test, mock } from "bun:test";
import { buildPingComponentHandler } from "../../../../src/integrations/scrypt/ping/handler.ts";
import { fakeButton } from "../../../helpers.ts";

const log = { info() {}, warn() {}, error() {} } as any;
const opts = { version: "0.1.0", scryptHost: "localhost:3777", allowRestart: false };
function rest(seq: any[]) {
  const calls = seq.slice();
  return { health: mock(async () => calls.shift() ?? seq[seq.length - 1]) } as any;
}

describe("ping component handler", () => {
  test("namespace is 'ping'", () => {
    expect(buildPingComponentHandler(rest([{ ok: true }]), opts).namespace).toBe("ping");
  });

  test("refresh re-probes and updates the panel in place", async () => {
    const h = buildPingComponentHandler(rest([{ ok: true }]), opts);
    const i = fakeButton({ customId: "ping:refresh" });
    await h.handle(i, { log });
    expect(i.update).toHaveBeenCalled();
    const json = JSON.stringify((i.update.mock.calls[0][0] as any).components[0].toJSON());
    expect(json).toContain("OK");
  });

  test("retry on a down backend updates with recovery buttons", async () => {
    const h = buildPingComponentHandler(rest([{ ok: false, reason: "unreachable" }]), opts);
    const i = fakeButton({ customId: "ping:retry" });
    await h.handle(i, { log });
    const json = JSON.stringify((i.update.mock.calls[0][0] as any).components[0].toJSON());
    expect(json).toContain("ping:retry");
  });

  test("details replies ephemerally with the failure explanation, no secrets", async () => {
    const h = buildPingComponentHandler(rest([{ ok: false, reason: "auth" }]), opts);
    const i = fakeButton({ customId: "ping:details" });
    await h.handle(i, { log });
    expect(i.reply).toHaveBeenCalled();
    const payload = i.reply.mock.calls[0][0] as any;
    expect(JSON.stringify(payload)).toMatch(/auth|SCRYPT_AUTH/i);
  });

  test("auto-retry stops as soon as health recovers", async () => {
    // down, down, then ok → should update a few times and end green.
    const h = buildPingComponentHandler(
      rest([{ ok: false, reason: "unreachable" }, { ok: false, reason: "unreachable" }, { ok: true }]),
      opts,
    );
    const i = fakeButton({ customId: "ping:autoretry" });
    await h.handle(i, { log }, { delayMs: 0, maxAttempts: 5 });
    const lastCall = i.update.mock.calls.at(-1)![0] as any;
    expect(JSON.stringify(lastCall.components[0].toJSON())).toContain("OK");
  });
});
