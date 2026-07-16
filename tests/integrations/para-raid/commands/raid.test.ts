// /raid command behaviors. Fakes mirror tests/helpers.ts's fakeInteraction shape, extended
// with the subcommand + channel surface /raid actually touches. Errors are asserted as thrown
// ParaRaidError/ConfigError — the interaction-router owns the catch path (decisions 9/10).
import { describe, expect, mock, test } from "bun:test";
import { ChannelType } from "discord.js";
import { buildRaidCommand } from "../../../../src/integrations/para-raid/commands/raid.ts";
import { ConfigError, ParaRaidError } from "../../../../src/lib/errors.ts";
import type { ParaRaidClient, Session } from "../../../../src/integrations/para-raid/client.ts";
import type { SessionCache } from "../../../../src/integrations/para-raid/sessions.ts";

type MockedApi = ParaRaidClient & { openSession: any; listSessions: any; closeSession: any };

function fakeApi(over: Partial<Record<"openSession" | "listSessions" | "closeSession", unknown>> = {}): MockedApi {
  return {
    openSession: over.openSession ?? mock(async () => ({ status: 202, body: { session_id: "s1", status: "launching" } })),
    listSessions: over.listSessions ?? mock(async () => ({ status: 200, body: { sessions: [], next_cursor: null } })),
    closeSession: over.closeSession ?? mock(async () => ({ status: 200, body: { session_id: "s1", status: "closing" } })),
  } as unknown as MockedApi;
}

function fakeSessions(byThread: Record<string, { id: string }> = {}) {
  return {
    resolveByThread: mock(async (id: string) => byThread[id]),
  } as unknown as SessionCache;
}

function fakeThread(id = "new-thread") {
  return { id, send: mock(async (_: unknown) => {}) };
}

function fakeInteraction(over: Record<string, unknown> = {}): any {
  const thread = fakeThread();
  return {
    options: {
      getSubcommand: (_req?: boolean) => "open",
      getString: (name: string, _req?: boolean) => (name === "prompt" ? "fix the bug" : null),
    },
    channel: {
      type: ChannelType.GuildText,
      isThread: () => false,
      threads: { create: mock(async (_: unknown) => thread) },
    },
    client: { channels: { fetch: mock(async (_: string) => ({})) } },
    editReply: mock(async (_: unknown) => {}),
    _thread: thread,
    ...over,
  };
}

function execute(i: any, api = fakeApi(), sessions = fakeSessions()) {
  return buildRaidCommand(api, sessions).execute(i, {} as never);
}

describe("/raid open", () => {
  test("creates a thread and opens a session with adapter_ref = thread.id", async () => {
    const i = fakeInteraction();
    const api = fakeApi();
    await execute(i, api);

    const created = i.channel.threads.create.mock.calls[0]?.[0] as { name: string; type: number };
    expect(created.name).toBe("fix the bug");
    expect(created.type).toBe(ChannelType.PublicThread);
    expect(api.openSession).toHaveBeenCalledWith({
      adapter_ref: i._thread.id,
      prompt: "fix the bug",
      bundle_name: undefined,
    });
    expect(i._thread.send).toHaveBeenCalledWith("session launching — session_id `s1`");
    expect(i.editReply).toHaveBeenCalledWith(`opened <#${i._thread.id}>`);
  });

  test("passes the optional bundle through as bundle_name", async () => {
    const i = fakeInteraction();
    i.options.getString = (name: string) => ({ prompt: "fix the bug", bundle: "scrypt" })[name] ?? null;
    const api = fakeApi();
    await execute(i, api);
    expect(api.openSession.mock.calls[0]?.[0]).toEqual({
      adapter_ref: i._thread.id,
      prompt: "fix the bug",
      bundle_name: "scrypt",
    });
  });

  test("truncates a long prompt to a legal thread name", async () => {
    const i = fakeInteraction();
    i.options.getString = (name: string) => (name === "prompt" ? "p".repeat(200) : null);
    await execute(i);
    const created = i.channel.threads.create.mock.calls[0]?.[0] as { name: string };
    expect(created.name.length).toBeLessThanOrEqual(80);
    expect(created.name.endsWith("…")).toBe(true);
  });

  test("refuses to run inside a thread (nested sessions)", async () => {
    const i = fakeInteraction({ channel: { isThread: () => true } });
    await expect(execute(i)).rejects.toBeInstanceOf(ParaRaidError);
  });

  test("requires a guild text channel context", async () => {
    await expect(execute(fakeInteraction({ channel: null }))).rejects.toBeInstanceOf(ConfigError);
    const dm = fakeInteraction({ channel: { type: ChannelType.DM, isThread: () => false } });
    await expect(execute(dm)).rejects.toBeInstanceOf(ConfigError);
  });

  test("a failed open_session surfaces as ParaRaidError", async () => {
    const api = fakeApi({ openSession: mock(async () => ({ status: 500, body: {} })) });
    await expect(execute(fakeInteraction(), api)).rejects.toBeInstanceOf(ParaRaidError);
  });
});

function sessionRow(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    adapter_id: "a1",
    adapter_ref: "thread-1",
    status: "live",
    tmux_session: "t",
    cwd: "/w",
    created_at: 1,
    updated_at: 2,
    last_turn_at: null,
    recovery_expires_at: null,
    ...over,
  };
}

describe("/raid status", () => {
  const asStatus = (i: any) => {
    i.options.getSubcommand = () => "status";
    return i;
  };

  test("says so when there are no sessions", async () => {
    const i = asStatus(fakeInteraction());
    await execute(i);
    expect(i.editReply).toHaveBeenCalledWith("no para-raid sessions");
  });

  test("lists each session and flags orphans whose thread no longer resolves (A3)", async () => {
    const rows = [sessionRow(), sessionRow({ id: "s2", adapter_ref: "gone-thread" })];
    const api = fakeApi({
      listSessions: mock(async () => ({ status: 200, body: { sessions: rows, next_cursor: null } })),
    });
    const i = asStatus(fakeInteraction());
    i.client.channels.fetch = mock(async (id: string) => {
      if (id === "gone-thread") throw new Error("Unknown Channel");
      return {};
    });
    await execute(i, api);
    const reply = i.editReply.mock.calls[0]?.[0] as string;
    const [line1, line2] = reply.split("\n");
    expect(line1).toContain("`s1` — live — <#thread-1>");
    expect(line1).not.toContain("orphaned");
    expect(line2).toContain("`s2`");
    expect(line2).toContain("(orphaned — thread not found)");
  });

  test("a failed listSessions surfaces as ParaRaidError", async () => {
    const api = fakeApi({ listSessions: mock(async () => ({ status: 502, body: {} })) });
    await expect(execute(asStatus(fakeInteraction()), api)).rejects.toBeInstanceOf(ParaRaidError);
  });
});

describe("/raid close", () => {
  const asClose = (i: any, sessionOpt: string | null = null) => {
    i.options.getSubcommand = () => "close";
    i.options.getString = (name: string) => (name === "session" ? sessionOpt : null);
    return i;
  };

  test("an explicit session id wins — no thread needed (orphan reaping, A3)", async () => {
    const api = fakeApi();
    const i = asClose(fakeInteraction({ channel: null }), "s-orphan");
    await execute(i, api);
    expect(api.closeSession).toHaveBeenCalledWith({ session_id: "s-orphan" });
    expect(i.editReply).toHaveBeenCalledWith("closing session `s-orphan`");
  });

  test("inside a session thread, the session resolves from the thread id", async () => {
    const api = fakeApi();
    const sessions = fakeSessions({ "thread-1": { id: "s1" } });
    const i = asClose(fakeInteraction({ channel: { isThread: () => true, id: "thread-1" } }));
    await execute(i, api, sessions);
    expect(api.closeSession).toHaveBeenCalledWith({ session_id: "s1" });
  });

  test("outside a session thread with no id, it refuses with guidance", async () => {
    const i = asClose(fakeInteraction()); // GuildText channel, not a thread
    await expect(execute(i)).rejects.toBeInstanceOf(ParaRaidError);
  });

  test("a failed close_session surfaces as ParaRaidError", async () => {
    const api = fakeApi({ closeSession: mock(async () => ({ status: 500, body: {} })) });
    const i = asClose(fakeInteraction(), "s1");
    await expect(execute(i, api)).rejects.toBeInstanceOf(ParaRaidError);
  });
});
