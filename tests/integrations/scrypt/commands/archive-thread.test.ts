import { describe, expect, test, mock } from "bun:test";
import { buildArchiveThreadCommand } from "../../../../src/integrations/scrypt/commands/archive-thread.ts";
import { ConfigError } from "../../../../src/lib/errors.ts";
import { fakeInteraction } from "../../../helpers.ts";

const ctx = { clientTag: "uxie-x", log: { info() {}, warn() {}, error() {} } as any };

// discord.js fetch() returns a Collection (newest-first) keyed by id; a Map is close enough
// for the implementation, which only touches .values()/.size.
function msg(id: string, username: string, content: string, minute: number) {
  return {
    id,
    content,
    author: { username },
    createdAt: new Date(Date.UTC(2026, 6, 17, 10, minute)),
    attachments: { size: 0, values: () => [] as any[] },
  };
}

// Serve scripted pages (each newest-first); an empty Map once exhausted.
function threadInteraction(pages: any[][], opts: { title?: string } = {}) {
  const fetch = mock(async (_args: { limit: number; before?: string }) => {
    const page = pages.shift() ?? [];
    return new Map(page.map((m) => [m.id, m]));
  });
  return fakeInteraction({
    deferred: true,
    channel: {
      isThread: () => true,
      name: "para-raid research",
      parentId: "parent-1",
      messages: { fetch },
    },
    options: { getString: mock((_: string) => opts.title ?? null) },
  });
}

describe("/archive-thread", () => {
  test("data name is 'archive-thread' with default builder shape (decision 7)", () => {
    const cmd = buildArchiveThreadCommand({} as any);
    expect(cmd.data.name).toBe("archive-thread");
    expect((cmd.data as any).toJSON().default_member_permissions).toBe("0");
    expect(cmd.defer).toBeUndefined();
  });

  test("compiles a chronological transcript and files it once via createNote with clientTag", async () => {
    const createNote = mock(async (_: any) => ({ path: "projects/_inbox/other/x.md" }));
    const cmd = buildArchiveThreadCommand({ createNote } as any);
    // One page, newest-first: bob replied after alice.
    const i = threadInteraction([[msg("2", "bob", "reply from bob", 5), msg("1", "alice", "hello from alice", 1)]]);
    await cmd.execute(i, ctx);

    expect(createNote).toHaveBeenCalledTimes(1);
    const arg = createNote.mock.calls[0]![0];
    expect(arg.clientTag).toBe("uxie-x");
    expect(arg.title).toBe("para-raid research"); // no override ⇒ thread name
    // both authors present, chronological (alice before bob)
    expect(arg.content).toContain("alice");
    expect(arg.content).toContain("bob");
    expect(arg.content.indexOf("hello from alice")).toBeLessThan(arg.content.indexOf("reply from bob"));
    expect(i.editReply.mock.calls[0][0]).toBe("archived 2 messages → `projects/_inbox/other/x.md`");
  });

  test("title option overrides the thread name", async () => {
    const createNote = mock(async (_: any) => ({ path: "p.md" }));
    const cmd = buildArchiveThreadCommand({ createNote } as any);
    const i = threadInteraction([[msg("1", "alice", "hi", 1)]], { title: "My Note" });
    await cmd.execute(i, ctx);
    expect(createNote.mock.calls[0]![0].title).toBe("My Note");
  });

  test("throws ConfigError when not run inside a thread", async () => {
    const cmd = buildArchiveThreadCommand({ createNote: mock() } as any);
    const i = fakeInteraction({ deferred: true, channel: { isThread: () => false } });
    await expect(cmd.execute(i, ctx)).rejects.toBeInstanceOf(ConfigError);
  });

  test("pagination continues on a full page and stops on a short page", async () => {
    const createNote = mock(async (_: any) => ({ path: "p.md" }));
    const cmd = buildArchiveThreadCommand({ createNote } as any);
    const fullPage = Array.from({ length: 100 }, (_, k) => msg(`f${k}`, "alice", `m${k}`, k % 60));
    const shortPage = [msg("s1", "bob", "last", 0)];
    const i = threadInteraction([fullPage, shortPage]);
    await cmd.execute(i, ctx);
    // 2 fetches: full page ⇒ keep paging, short page ⇒ stop (no third fetch).
    expect(i.channel.messages.fetch).toHaveBeenCalledTimes(2);
  });
});
