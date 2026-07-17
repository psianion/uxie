import { describe, expect, test, mock } from "bun:test";
import { buildSupCommand } from "../../../../src/integrations/sup/commands/sup.ts";

const ctx = { clientTag: "uxie-x", log: { info() {}, warn() {}, error() {} } as any };
const V2 = 1 << 15;
const OPTS = { host: "test · box" };

const ACCENT_OK = 0x57f287;
const ACCENT_DEGRADED = 0xfee75c;

function supInteraction(): any {
  return {
    commandName: "sup",
    client: { ws: { ping: 42 } },
    options: { getSubcommand: mock(() => "status") },
    editReply: mock(async (_: unknown) => {}),
  };
}

function restStub(ok: boolean) {
  return { health: mock(async () => (ok ? { ok: true } : { ok: false, reason: "refused" })) } as any;
}

function accentOf(i: any): number {
  return i.editReply.mock.calls[0][0].components[0].toJSON().accent_color;
}

describe("/sup status", () => {
  test("all healthy, para-raid off → ok panel with module-off row", async () => {
    const cmd = buildSupCommand(restStub(true), undefined, OPTS);
    const i = supInteraction();
    await cmd.execute(i, ctx);
    const arg = i.editReply.mock.calls[0][0];
    expect(arg.flags & V2).toBe(V2);
    expect(accentOf(i)).toBe(ACCENT_OK);
    expect(JSON.stringify(arg.components[0].toJSON())).toContain("module off");
  });

  test("scrypt down → degraded", async () => {
    const cmd = buildSupCommand(restStub(false), undefined, OPTS);
    const i = supInteraction();
    await cmd.execute(i, ctx);
    expect(accentOf(i)).toBe(ACCENT_DEGRADED);
  });

  test("para-raid reachable → session census in the row", async () => {
    const paraRaid = {
      listSessions: mock(async () => ({
        status: 200,
        body: { sessions: [{ status: "live" }, { status: "live" }, { status: "dead" }], next_cursor: null },
      })),
    } as any;
    const cmd = buildSupCommand(restStub(true), paraRaid, OPTS);
    const i = supInteraction();
    await cmd.execute(i, ctx);
    const json = JSON.stringify(i.editReply.mock.calls[0][0].components[0].toJSON());
    expect(json).toContain("2 live");
    expect(json).toContain("1 dead");
    expect(accentOf(i)).toBe(ACCENT_OK);
  });

  test("para-raid probe rejects → degraded, unreachable row", async () => {
    const paraRaid = { listSessions: mock(async () => Promise.reject(new Error("timeout"))) } as any;
    const cmd = buildSupCommand(restStub(true), paraRaid, OPTS);
    const i = supInteraction();
    await cmd.execute(i, ctx);
    const json = JSON.stringify(i.editReply.mock.calls[0][0].components[0].toJSON());
    expect(json).toContain("unreachable");
    expect(accentOf(i)).toBe(ACCENT_DEGRADED);
  });
});
