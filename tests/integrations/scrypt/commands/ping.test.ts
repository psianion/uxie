import { describe, expect, test, mock } from "bun:test";
import { buildPingCommand } from "../../../../src/integrations/scrypt/commands/ping.ts";
import { fakeInteraction } from "../../../helpers.ts";

function fakeRest(health: any) {
  return { health: mock(async () => health) } as any;
}
const ctx = { clientTag: "uxie-x", log: { info() {}, warn() {}, error() {} } as any };
const opts = { version: "0.1.0", scryptHost: "localhost:3777", allowRestart: false, host: "local · test-box" };

// /ping replies immediately (no defer). Provide reply/fetchReply/editReply + a client stub.
function pingInteraction(over: Record<string, unknown> = {}) {
  return fakeInteraction({
    deferred: false,
    client: { ws: { ping: 42 } },
    createdTimestamp: Date.now() - 100,
    reply: mock(async (_: unknown) => {}),
    fetchReply: mock(async () => ({ createdTimestamp: Date.now() })),
    editReply: mock(async (_: unknown) => {}),
    ...over,
  });
}

const V2 = 1 << 15; // MessageFlags.IsComponentsV2 = 32768
const EPHEMERAL = 1 << 6; // 64

describe("/ping (Components V2)", () => {
  test("opts out of auto-defer", () => {
    expect(buildPingCommand(fakeRest({ ok: true }), opts).defer).toBe(false);
  });

  test("command data name is 'ping' with default builder shape (decision 7)", () => {
    const cmd = buildPingCommand(fakeRest({ ok: true }), opts);
    expect(cmd.data.name).toBe("ping");
    expect((cmd.data as any).toJSON().default_member_permissions).toBe("0");
  });

  test("replies once with Ephemeral|IsComponentsV2 and components (no content/embeds)", async () => {
    const cmd = buildPingCommand(fakeRest({ ok: true }), opts);
    const i = pingInteraction();
    await cmd.execute(i, ctx);
    const payload = i.reply.mock.calls[0][0];
    expect(payload.flags & V2).toBe(V2);
    expect(payload.flags & EPHEMERAL).toBe(EPHEMERAL);
    expect(Array.isArray(payload.components)).toBe(true);
    expect(payload.content).toBeUndefined();
    expect(payload.embeds).toBeUndefined();
  });

  test("green container when scrypt is healthy", async () => {
    const cmd = buildPingCommand(fakeRest({ ok: true }), opts);
    const i = pingInteraction();
    await cmd.execute(i, ctx);
    const json = JSON.stringify(i.reply.mock.calls[0][0].components[0].toJSON());
    expect(json).toContain("OK");
  });

  test("down container shows recovery buttons when scrypt unreachable", async () => {
    const cmd = buildPingCommand(fakeRest({ ok: false, reason: "unreachable" }), opts);
    const i = pingInteraction();
    await cmd.execute(i, ctx);
    const json = JSON.stringify(i.reply.mock.calls[0][0].components[0].toJSON());
    expect(json).toContain("ping:retry");
    expect(json).toContain("ping:details");
  });

  test("re-renders once via editReply to append API roundtrip", async () => {
    const cmd = buildPingCommand(fakeRest({ ok: true }), opts);
    const i = pingInteraction();
    await cmd.execute(i, ctx);
    expect(i.fetchReply).toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalled();
  });

  test("null-safe when client.ws.ping is null", async () => {
    const cmd = buildPingCommand(fakeRest({ ok: true }), opts);
    const i = pingInteraction({ client: { ws: { ping: null } } });
    await cmd.execute(i, ctx);
    expect(i.reply).toHaveBeenCalled();
  });
});
