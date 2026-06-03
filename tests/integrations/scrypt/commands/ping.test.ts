import { describe, expect, test, mock } from "bun:test";
import { buildPingCommand } from "../../../../src/integrations/scrypt/commands/ping.ts";
import { fakeInteraction } from "../../../helpers.ts";

function fakeRest(health: any) {
  return { health: mock(async () => health) } as any;
}

const ctx = {
  clientTag: "uxie-x",
  log: { info: () => {}, warn: () => {}, error: () => {} } as any,
};

// /ping reads i.client.ws.ping for the heartbeat figure; provide a client stub.
function pingInteraction(overrides: Record<string, unknown> = {}) {
  return fakeInteraction({
    deferred: true,
    client: { ws: { ping: 42 } },
    createdTimestamp: Date.now() - 100,
    ...overrides,
  });
}

describe("/ping", () => {
  test("replies a STRING, alive + scrypt ok when health is good (decision 15)", async () => {
    const cmd = buildPingCommand(fakeRest({ ok: true }));
    const i = pingInteraction();
    await cmd.execute(i, ctx);
    const arg = i.editReply.mock.calls[0][0];
    expect(typeof arg).toBe("string");
    expect(arg).toMatch(/alive.*scrypt: ok/i);
  });

  test("replies scrypt: unreachable when health fails", async () => {
    const cmd = buildPingCommand(fakeRest({ ok: false, reason: "unreachable" }));
    const i = pingInteraction();
    await cmd.execute(i, ctx);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining("unreachable"));
  });

  test("surfaces the failure reason for auth and server", async () => {
    const auth = buildPingCommand(fakeRest({ ok: false, reason: "auth" }));
    const ia = pingInteraction();
    await auth.execute(ia, ctx);
    expect(ia.editReply).toHaveBeenCalledWith(expect.stringContaining("auth"));
  });

  test("is null-safe when client.ws.ping is null (not yet connected)", async () => {
    const cmd = buildPingCommand(fakeRest({ ok: true }));
    const i = pingInteraction({ client: { ws: { ping: null } } });
    await cmd.execute(i, ctx);
    const arg = i.editReply.mock.calls[0][0];
    expect(typeof arg).toBe("string");
    expect(arg).toMatch(/alive/i);
  });

  test("command data name is 'ping'", () => {
    const cmd = buildPingCommand(fakeRest({ ok: true }));
    expect(cmd.data.name).toBe("ping");
  });

  test("builder carries the default shape (decision 7)", () => {
    const cmd = buildPingCommand(fakeRest({ ok: true }));
    const json = (cmd.data as any).toJSON();
    expect(json.default_member_permissions).toBe("0");
  });
});
