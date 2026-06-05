import { describe, expect, test, mock } from "bun:test";
import { Collection } from "discord.js";
import { handleMention } from "../../src/bot/mention-handler.ts";
import type { LoadedCommand } from "../../src/bot/command-loader.ts";

function fakeLog(): any {
  const l: any = { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) };
  l.child = () => l;
  return l;
}

function cmds(): Collection<string, LoadedCommand> {
  const c = new Collection<string, LoadedCommand>();
  c.set("ping", { data: { name: "ping", description: "Check health" } as any, execute: async () => {} });
  c.set("capture", { data: { name: "capture", description: "Save a note" } as any, execute: async () => {} });
  return c;
}

describe("handleMention", () => {
  test("replies with a help embed listing every command and pings nobody", async () => {
    const del = mock(async () => {});
    const reply = mock(async () => ({ delete: del }));
    const msg: any = { id: "m1", channelId: "c1", reply };
    const scheduled: Array<() => void> = [];

    await handleMention(msg, cmds(), fakeLog(), { schedule: (fn) => scheduled.push(fn) });

    expect(reply).toHaveBeenCalledTimes(1);
    const payload = (reply.mock.calls as any[][])[0]![0] as any;
    expect(payload.allowedMentions).toEqual({ parse: [] });
    const desc = payload.embeds[0].data.description as string;
    expect(desc).toContain("/ping");
    expect(desc).toContain("/capture");
    expect(scheduled).toHaveLength(1);
  });

  test("the scheduled self-delete fires and a rejecting delete does not throw", async () => {
    const del = mock(async () => {
      throw new Error("already gone");
    });
    const reply = mock(async () => ({ delete: del }));
    const msg: any = { id: "m1", channelId: "c1", reply };
    const scheduled: Array<() => void> = [];

    await handleMention(msg, cmds(), fakeLog(), { schedule: (fn) => scheduled.push(fn) });
    expect(() => scheduled[0]!()).not.toThrow();
    expect(del).toHaveBeenCalledTimes(1);
  });

  test("never throws if the reply itself fails (own catch site)", async () => {
    const reply = mock(async () => {
      throw new Error("missing perms");
    });
    const msg: any = { id: "m1", channelId: "c1", reply };
    await expect(handleMention(msg, cmds(), fakeLog())).resolves.toBeUndefined();
  });
});
