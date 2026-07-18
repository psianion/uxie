import { describe, expect, test, mock } from "bun:test";
import { startJournalMirror } from "../../../src/integrations/journal/capture.ts";

const CFG = { channelId: "jc", ownerId: "123" };

// Minimal Client stub: records listeners so tests can fire gateway events directly.
function fakeClient() {
  const handlers = new Map<string, Function>();
  return {
    on: (evt: string, fn: Function) => handlers.set(evt, fn),
    off: (evt: string) => handlers.delete(evt),
    emit: async (evt: string, ...args: unknown[]) => {
      await (handlers.get(evt) as any)?.(...args);
      // handlers fire-and-forget (void async); let the microtask queue drain
      await new Promise((r) => setTimeout(r, 0));
    },
  } as any;
}

function fakeRest(over: Record<string, unknown> = {}) {
  const bundle = {
    date: "2026-07-17",
    entries: [{ id: "2026-07-17T10:00:00.000Z", displayTime: "10:00", body: "hi" }],
    tasks_due: [],
    related: [],
  };
  return {
    journalEntry: mock(async (_b: string, _t: string) => bundle),
    journalEditEntry: mock(async (_d: string, _i: string, _b: string, _t?: string) => bundle),
    journalDeleteEntry: mock(async (_d: string, _i: string, _t?: string) => bundle),
    ...over,
  } as any;
}

function msg(over: Record<string, unknown> = {}) {
  return {
    id: "m1",
    channelId: "jc",
    author: { id: "123", bot: false },
    content: "today was good",
    react: mock(async (_: string) => ({})),
    ...over,
  };
}

describe("journal mirror", () => {
  test("owner message in the journal channel → appended + ✅ + mapped", async () => {
    const client = fakeClient();
    const rest = fakeRest();
    const mirror = startJournalMirror(client, rest, CFG);
    const m = msg();
    await client.emit("messageCreate", m);
    expect(rest.journalEntry).toHaveBeenCalledWith("today was good", "uxie-msg-m1");
    expect(m.react).toHaveBeenCalledWith("✅");
    expect(mirror.entryCount()).toBe(1);
  });

  test("other channels and non-owner authors are ignored", async () => {
    const client = fakeClient();
    const rest = fakeRest();
    startJournalMirror(client, rest, CFG);
    await client.emit("messageCreate", msg({ channelId: "elsewhere" }));
    await client.emit("messageCreate", msg({ author: { id: "999", bot: false } }));
    await client.emit("messageCreate", msg({ author: { id: "botid", bot: true } }));
    expect(rest.journalEntry).not.toHaveBeenCalled();
  });

  test("editing a mapped message PATCHes the entry", async () => {
    const client = fakeClient();
    const rest = fakeRest();
    startJournalMirror(client, rest, CFG);
    const m = msg();
    await client.emit("messageCreate", m);
    await client.emit("messageUpdate", m, { ...m, content: "today was great" });
    expect(rest.journalEditEntry).toHaveBeenCalledWith(
      "2026-07-17",
      "2026-07-17T10:00:00.000Z",
      "today was great",
      "uxie-msg-m1",
    );
  });

  test("deleting a mapped message DELETEs the entry and unmaps it", async () => {
    const client = fakeClient();
    const rest = fakeRest();
    const mirror = startJournalMirror(client, rest, CFG);
    const m = msg();
    await client.emit("messageCreate", m);
    await client.emit("messageDelete", m);
    expect(rest.journalDeleteEntry).toHaveBeenCalledWith("2026-07-17", "2026-07-17T10:00:00.000Z", "uxie-msg-m1");
    expect(mirror.entryCount()).toBe(0);
  });

  test("append failure reacts ❌ and never throws", async () => {
    const client = fakeClient();
    const rest = fakeRest({ journalEntry: mock(async () => Promise.reject(new Error("down"))) });
    startJournalMirror(client, rest, CFG);
    const m = msg();
    await client.emit("messageCreate", m);
    expect(m.react).toHaveBeenCalledWith("❌");
  });

  test("edit of an unmapped (pre-boot) message is ignored", async () => {
    const client = fakeClient();
    const rest = fakeRest();
    startJournalMirror(client, rest, CFG);
    const m = msg({ id: "ancient" });
    await client.emit("messageUpdate", m, m);
    expect(rest.journalEditEntry).not.toHaveBeenCalled();
  });
});
