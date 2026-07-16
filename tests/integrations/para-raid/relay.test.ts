// relayMessage (D1/A7): owner messages in a known session thread become send_turn calls, and
// NOTHING may escape it — an unhandled rejection in a MessageCreate listener would take the
// whole process down via index.ts's unhandledRejection handler.
import { describe, expect, mock, test } from "bun:test";
import { relayMessage, type RelayDeps } from "../../../src/integrations/para-raid/relay.ts";
import { PAUSED_HINT } from "../../../src/integrations/para-raid/events.ts";
import { setLogSink, type LogEntry } from "../../../src/lib/log.ts";

const OWNER = "owner-1";
const BOT_USER = "bot-user-1";

function fakeMessage(over: Record<string, unknown> = {}): any {
  const removeUser = mock(async (_: string) => {});
  return {
    author: { bot: false, id: OWNER },
    content: "do the thing",
    channel: { isThread: () => true, id: "thread-1" },
    client: { user: { id: BOT_USER } },
    react: mock(async (_emoji: string) => ({ users: { remove: removeUser } })),
    reply: mock(async (_: unknown) => {}),
    _removeUser: removeUser,
    ...over,
  };
}

function fakeDeps(over: Partial<Record<keyof RelayDeps | "sendTurn" | "resolveByThread", unknown>> = {}): {
  deps: RelayDeps;
  sendTurn: ReturnType<typeof mock>;
  invalidate: ReturnType<typeof mock>;
} {
  const sendTurn = mock(async (_: { session_id: string; prompt: string }) => ({ status: 200, body: {} }));
  const invalidate = mock((_: string) => {});
  const deps = {
    client: {} as never,
    api: { sendTurn: over.sendTurn ?? sendTurn },
    sessions: {
      resolveByThread:
        over.resolveByThread ?? (async (id: string) => (id === "thread-1" ? { id: "s1", adapter_ref: id } : undefined)),
      invalidate,
    },
    ownerId: OWNER,
  } as unknown as RelayDeps;
  return { deps, sendTurn, invalidate };
}

async function captureLogs(fn: () => Promise<void>): Promise<LogEntry[]> {
  const entries: LogEntry[] = [];
  setLogSink((e) => entries.push(e));
  try {
    await fn();
  } finally {
    setLogSink(null);
  }
  return entries;
}

describe("relayMessage — happy path", () => {
  test("owner message in a known session thread sends the turn and reacts ⏳", async () => {
    const msg = fakeMessage();
    const { deps, sendTurn } = fakeDeps();
    await relayMessage(msg, deps);
    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(sendTurn.mock.calls[0]?.[0]).toEqual({ session_id: "s1", prompt: "do the thing" });
    expect(msg.react).toHaveBeenCalledWith("⏳");
    // Success: no failure reply, no ❌, pending reaction left in place.
    expect(msg.reply).not.toHaveBeenCalled();
    expect(msg._removeUser).not.toHaveBeenCalled();
  });
});

describe("relayMessage — ignored messages", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["bot authors", { author: { bot: true, id: OWNER } }],
    ["non-owner authors", { author: { bot: false, id: "someone-else" } }],
    ["empty content", { content: "" }],
    ["non-thread channels", { channel: { isThread: () => false, id: "chan-1" } }],
    ["threads with no known session", { channel: { isThread: () => true, id: "unknown-thread" } }],
  ];
  for (const [name, over] of cases) {
    test(`${name} are ignored silently (no send_turn, no reaction, no reply)`, async () => {
      const msg = fakeMessage(over);
      const { deps, sendTurn } = fakeDeps();
      await relayMessage(msg, deps);
      expect(sendTurn).not.toHaveBeenCalled();
      expect(msg.react).not.toHaveBeenCalled();
      expect(msg.reply).not.toHaveBeenCalled();
    });
  }
});

describe("relayMessage — send_turn failures", () => {
  test("503 posts the PAUSED_HINT and swaps ⏳ for ❌", async () => {
    const msg = fakeMessage();
    const { deps } = fakeDeps({ sendTurn: mock(async () => ({ status: 503, body: {} })) });
    await relayMessage(msg, deps);
    expect(msg.reply).toHaveBeenCalledWith(PAUSED_HINT);
    expect(msg._removeUser).toHaveBeenCalledWith(BOT_USER);
    expect(msg.react).toHaveBeenCalledWith("❌");
  });

  test("404 evicts the stale cache entry and tells the owner the session is gone", async () => {
    const msg = fakeMessage();
    const { deps, invalidate } = fakeDeps({ sendTurn: mock(async () => ({ status: 404, body: {} })) });
    await relayMessage(msg, deps);
    expect(invalidate).toHaveBeenCalledWith("s1");
    expect(msg.reply).toHaveBeenCalledWith(
      "session is no longer live — run /raid status or open a new one",
    );
  });

  test("any other >=400 posts a generic failure with the status code", async () => {
    const msg = fakeMessage();
    const { deps, invalidate } = fakeDeps({ sendTurn: mock(async () => ({ status: 500, body: {} })) });
    await relayMessage(msg, deps);
    expect(msg.reply).toHaveBeenCalledWith("send_turn failed (500)");
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("relayMessage — never throws (A7)", () => {
  test("a throwing session resolve is swallowed, logged, and reported to the thread", async () => {
    const msg = fakeMessage();
    const { deps, sendTurn } = fakeDeps({
      resolveByThread: async () => {
        throw new Error("cache exploded");
      },
    });
    const logs = await captureLogs(() => relayMessage(msg, deps)); // must resolve, not reject
    expect(sendTurn).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith("internal error relaying to para-raid");
    expect(logs.some((e) => e.level === "error" && e.msg.includes("relay failed"))).toBe(true);
  });

  test("a rejecting sendTurn is swallowed", async () => {
    const msg = fakeMessage();
    const { deps } = fakeDeps({
      sendTurn: mock(async () => {
        throw new Error("socket gone");
      }),
    });
    await captureLogs(() => relayMessage(msg, deps));
    expect(msg.reply).toHaveBeenCalledWith("internal error relaying to para-raid");
  });

  test("even when every Discord call also rejects, relayMessage still resolves", async () => {
    const msg = fakeMessage({
      react: mock(async () => {
        throw new Error("no perms");
      }),
      reply: mock(async () => {
        throw new Error("no perms");
      }),
    });
    const { deps } = fakeDeps({
      sendTurn: mock(async () => {
        throw new Error("socket gone");
      }),
    });
    // The contract: this promise NEVER rejects, whatever breaks inside.
    await captureLogs(() => relayMessage(msg, deps));
  });
});
