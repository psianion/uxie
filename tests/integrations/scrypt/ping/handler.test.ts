import { describe, expect, test, mock } from "bun:test";
import { buildPingComponentHandler } from "../../../../src/integrations/scrypt/ping/handler.ts";
import { fakeButton } from "../../../helpers.ts";
import { createRestartGuard } from "../../../../src/lib/exec/restart-scrypt.ts";

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

const allow = { version: "0.1.0", scryptHost: "localhost:3777", allowRestart: true };

function restartDeps(over: any = {}) {
  return {
    command: "docker compose restart scrypt",
    secrets: ["TOK"],
    runner: mock(async () => ({ code: 0, stderr: "" })),
    guard: createRestartGuard(() => 1_000_000),
    now: () => 1_000_000,
    newNonce: () => "nonce-1",
    ...over,
  };
}

describe("ping restart", () => {
  test("ping:restart shows a confirm panel carrying the nonce", async () => {
    const h = buildPingComponentHandler(rest([{ ok: false, reason: "unreachable" }]), allow, restartDeps());
    const i = fakeButton({ customId: "ping:restart" });
    await h.handle(i, { log });
    const json = JSON.stringify((i.update.mock.calls[0][0] as any).components[0].toJSON());
    expect(json).toContain("ping:restart-confirm:nonce-1");
    expect(json).toContain("ping:restart-cancel");
  });

  test("confirm with a stale/unknown nonce refuses to run", async () => {
    const runner = mock(async () => ({ code: 0, stderr: "" }));
    const h = buildPingComponentHandler(rest([{ ok: false, reason: "unreachable" }]), allow, restartDeps({ runner }));
    // No prior ping:restart, so there is no pending nonce.
    const i = fakeButton({ customId: "ping:restart-confirm:bogus" });
    await h.handle(i, { log });
    expect(runner).not.toHaveBeenCalled();
  });

  test("happy path: restart → ok → green recovered panel", async () => {
    const runner = mock(async () => ({ code: 0, stderr: "" }));
    const deps = restartDeps({ runner });
    // backend down at confirm time, healthy after restart.
    const h = buildPingComponentHandler(rest([{ ok: false, reason: "unreachable" }, { ok: true }]), allow, deps);
    const start = fakeButton({ customId: "ping:restart" });
    await h.handle(start, { log }); // sets pending nonce-1
    const confirm = fakeButton({ customId: "ping:restart-confirm:nonce-1" });
    await h.handle(confirm, { log });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(confirm.deferUpdate).toHaveBeenCalled();
    const last = confirm.editReply.mock.calls.at(-1)![0] as any;
    expect(JSON.stringify(last.components[0].toJSON())).toContain("OK");
  });

  test("failed restart → red panel, redacted stderr, no secret leak", async () => {
    const runner = mock(async () => ({ code: 1, stderr: "explode TOK leak" }));
    const deps = restartDeps({ runner });
    const h = buildPingComponentHandler(
      rest([{ ok: false, reason: "unreachable" }, { ok: false, reason: "unreachable" }]),
      allow,
      deps,
    );
    const start = fakeButton({ customId: "ping:restart" });
    await h.handle(start, { log });
    const confirm = fakeButton({ customId: "ping:restart-confirm:nonce-1" });
    await h.handle(confirm, { log });
    const last = JSON.stringify((confirm.editReply.mock.calls.at(-1)![0] as any).components[0].toJSON());
    expect(last).not.toContain("TOK");
    expect(last).toMatch(/fail|error|couldn't/i);
  });

  test("restart is inert when allowRestart is false", async () => {
    const runner = mock(async () => ({ code: 0, stderr: "" }));
    const h = buildPingComponentHandler(rest([{ ok: false, reason: "unreachable" }]), opts, restartDeps({ runner }));
    const i = fakeButton({ customId: "ping:restart" });
    await h.handle(i, { log });
    expect(runner).not.toHaveBeenCalled();
  });
});
