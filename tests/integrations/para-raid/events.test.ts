// createEventHandler: the business-logic side of the webhook receiver — one behavior per
// daemon event type, posting into the session's Discord thread. Fakes follow the repo
// convention: plain objects + bun:test mock(), no framework.
import { describe, expect, mock, test } from "bun:test";
import { AttachmentBuilder, ChannelType, DiscordAPIError, RESTJSONErrorCodes } from "discord.js";
import { createEventHandler, PAUSED_HINT, type EventDeps } from "../../../src/integrations/para-raid/events.ts";
import type { ParaRaidEvent } from "../../../src/integrations/para-raid/receiver.ts";
import { SessionCache } from "../../../src/integrations/para-raid/sessions.ts";
import type { ParaRaidClient, Session } from "../../../src/integrations/para-raid/client.ts";
import { setLogSink, type LogEntry } from "../../../src/lib/log.ts";

const THREAD_ID = "thread-1";
const SESSION_ID = "s1";

function evt(eventType: string, body: Record<string, unknown> = {}, sessionId: string | null = SESSION_ID): ParaRaidEvent {
  return { eventId: "evt-1", eventType, sessionId, body: { event_type: eventType, ...body } };
}

function fakeThread(over: Record<string, unknown> = {}): any {
  return {
    isThread: () => true,
    archived: false,
    setArchived: mock(async (_: boolean) => {}),
    send: mock(async (_: unknown) => {}),
    ...over,
  };
}

interface Rig {
  deps: EventDeps;
  handle: (e: ParaRaidEvent) => Promise<void>;
  thread: any;
  resumeSession: ReturnType<typeof mock>;
  closeSession: ReturnType<typeof mock>;
}

function rig(over: {
  thread?: any;
  channelFetch?: (id: string) => Promise<unknown>;
  resumeStatus?: number;
  resumeBody?: Record<string, unknown>;
  liveThreads?: string[];
} = {}): Rig {
  const thread = over.thread ?? fakeThread();
  const resumeSession = mock(async (_: { session_id: string }) => ({
    status: over.resumeStatus ?? 200,
    body: over.resumeBody ?? { status: "live" },
  }));
  const closeSession = mock(async (_: { session_id: string }) => ({ status: 200, body: {} }));
  const deps = {
    client: { channels: { fetch: over.channelFetch ?? (async (_: string) => thread) } },
    api: { resumeSession, closeSession },
    sessions: {
      resolveBySession: async (id: string) =>
        id === SESSION_ID ? { id, adapter_ref: THREAD_ID, status: "live" } : undefined,
      threadFor: (s: { adapter_ref: string }) => s.adapter_ref,
      registerThread: mock(() => {}),
      liveThreadIds: async () => over.liveThreads ?? [THREAD_ID],
    },
  } as unknown as EventDeps;
  return { deps, handle: createEventHandler(deps), thread, resumeSession, closeSession };
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

describe("session_live", () => {
  test("posts 'session live' into the session's thread", async () => {
    const r = rig();
    await r.handle(evt("session_live"));
    expect(r.thread.send).toHaveBeenCalledWith("session live");
  });
});

describe("turn_replied", () => {
  test("a short reply is posted inline verbatim", async () => {
    const r = rig();
    await r.handle(evt("turn_replied", { reply: "all done" }));
    expect(r.thread.send).toHaveBeenCalledWith("all done");
  });

  test("an empty/absent reply becomes the placeholder (A1 — Discord 400s on empty content)", async () => {
    const r = rig();
    await r.handle(evt("turn_replied", {}));
    expect(r.thread.send).toHaveBeenCalledWith("(no textual output)");
  });

  test("a reply over 2000 chars becomes an attachment with a 300-char preview", async () => {
    const r = rig();
    const long = "x".repeat(2001);
    await r.handle(evt("turn_replied", { reply: long }));
    const sent = r.thread.send.mock.calls[0]?.[0] as { content: string; files: unknown[] };
    expect(sent.content).toBe(`${"x".repeat(300)}… (full reply attached)`);
    expect(sent.files).toHaveLength(1);
    expect(sent.files[0]).toBeInstanceOf(AttachmentBuilder);
  });

  test("a reply of exactly 2000 chars still posts inline", async () => {
    const r = rig();
    const exact = "y".repeat(2000);
    await r.handle(evt("turn_replied", { reply: exact }));
    expect(r.thread.send).toHaveBeenCalledWith(exact);
  });
});

describe("turn_failed", () => {
  test("posts the daemon's error verbatim", async () => {
    const r = rig();
    await r.handle(evt("turn_failed", { error: "pane crashed" }));
    expect(r.thread.send).toHaveBeenCalledWith("turn failed: pane crashed");
  });

  test("a Stop-timeout gets the reassuring wording instead of a bare error dump (A9)", async () => {
    const r = rig();
    await r.handle(evt("turn_failed", { error: "Stop timeout after 600000ms for session s1" }));
    const sent = r.thread.send.mock.calls[0]?.[0] as string;
    expect(sent).toContain("pane may still finish");
    expect(sent).not.toContain("turn failed:");
  });

  test("a non-string error falls back to 'unknown error'", async () => {
    const r = rig();
    await r.handle(evt("turn_failed", {}));
    expect(r.thread.send).toHaveBeenCalledWith("turn failed: unknown error");
  });
});

describe("session_dead", () => {
  test("posts the death notice with the daemon's reason", async () => {
    const r = rig();
    await r.handle(evt("session_dead", { reason: "tmux exited" }));
    expect(r.thread.send).toHaveBeenCalledWith("session dead (tmux exited)");
  });

  test("a missing reason reads as unknown", async () => {
    const r = rig();
    await r.handle(evt("session_dead", {}));
    expect(r.thread.send).toHaveBeenCalledWith("session dead (unknown)");
  });
});

describe("session_recover_candidate (A6)", () => {
  test("calls resumeSession and posts 'recovered' when the daemon answers live", async () => {
    const r = rig({ resumeStatus: 200, resumeBody: { status: "live" } });
    await r.handle(evt("session_recover_candidate"));
    expect(r.resumeSession).toHaveBeenCalledWith({ session_id: SESSION_ID });
    expect(r.thread.send).toHaveBeenCalledWith("session recovered after restart");
  });

  test("posts the failure + dead notice when resume does not answer live", async () => {
    const r = rig({ resumeStatus: 200, resumeBody: { status: "dead", error: "pane gone" } });
    await r.handle(evt("session_recover_candidate"));
    const sent = r.thread.send.mock.calls[0]?.[0] as string;
    expect(sent).toContain("recovery failed (pane gone)");
    expect(sent).toContain("dead");
  });

  test("an event without a session id is a no-op", async () => {
    const r = rig();
    await r.handle(evt("session_recover_candidate", {}, null));
    expect(r.resumeSession).not.toHaveBeenCalled();
    expect(r.thread.send).not.toHaveBeenCalled();
  });
});

describe("paused / resumed (A8 — null session_id fanout)", () => {
  test("paused fans the hint out to every live thread", async () => {
    const t1 = fakeThread();
    const t2 = fakeThread();
    const threads: Record<string, any> = { "t-1": t1, "t-2": t2 };
    const r = rig({ liveThreads: ["t-1", "t-2"], channelFetch: async (id) => threads[id] });
    await captureLogs(() => r.handle(evt("paused", {}, null)));
    expect(t1.send).toHaveBeenCalledWith(PAUSED_HINT);
    expect(t2.send).toHaveBeenCalledWith(PAUSED_HINT);
  });

  test("resumed posts the back-alive note", async () => {
    const r = rig();
    await captureLogs(() => r.handle(evt("resumed", {}, null)));
    expect(r.thread.send).toHaveBeenCalledWith("para-raid daemon resumed — sessions are live again");
  });

  test("one unreachable thread does not sink the rest of the fanout", async () => {
    const good = fakeThread();
    const r = rig({
      liveThreads: ["t-bad", "t-good"],
      channelFetch: async (id) => {
        if (id === "t-bad") throw new Error("transient");
        return good;
      },
    });
    await captureLogs(() => r.handle(evt("paused", {}, null))); // must resolve
    expect(good.send).toHaveBeenCalledWith(PAUSED_HINT);
  });
});

describe("unknown event types", () => {
  test("tool_call and friends are log-only — nothing reaches Discord", async () => {
    const fetch = mock(async () => fakeThread());
    const r = rig({ channelFetch: fetch });
    const logs = await captureLogs(() => r.handle(evt("tool_call", { name: "Bash" })));
    expect(fetch).not.toHaveBeenCalled();
    expect(logs.some((e) => e.level === "info" && e.msg === "para-raid event")).toBe(true);
  });

  test("an event for an unknown session is dropped with a warning", async () => {
    const r = rig();
    const logs = await captureLogs(() => r.handle(evt("session_live", {}, "never-seen")));
    expect(r.thread.send).not.toHaveBeenCalled();
    expect(logs.some((e) => e.level === "warn" && e.msg.includes("unknown session"))).toBe(true);
  });
});

function unknownChannelError(): DiscordAPIError {
  return new DiscordAPIError(
    { message: "Unknown Channel", code: RESTJSONErrorCodes.UnknownChannel },
    RESTJSONErrorCodes.UnknownChannel,
    404,
    "GET",
    "https://discord.com/api/v10/channels/thread-1",
    { body: undefined, files: undefined },
  );
}

describe("thread posting mechanics", () => {
  test("an archived thread is unarchived before posting", async () => {
    const thread = fakeThread({ archived: true });
    const r = rig({ thread });
    await r.handle(evt("session_live"));
    expect(thread.setArchived).toHaveBeenCalledWith(false);
    expect(thread.send).toHaveBeenCalledWith("session live");
  });

  test("Unknown Channel on fetch reaps the session and resolves (acks — no retry loop, A2)", async () => {
    const r = rig({
      channelFetch: async () => {
        throw unknownChannelError();
      },
    });
    await captureLogs(() => r.handle(evt("session_live"))); // resolves => receiver acks 200
    expect(r.closeSession).toHaveBeenCalledWith({ session_id: SESSION_ID });
  });

  test("Unknown Channel on send (deleted mid-post) also reaps and acks", async () => {
    const thread = fakeThread({
      send: mock(async () => {
        throw unknownChannelError();
      }),
    });
    const r = rig({ thread });
    await captureLogs(() => r.handle(evt("turn_replied", { reply: "hi" })));
    expect(r.closeSession).toHaveBeenCalledWith({ session_id: SESSION_ID });
  });

  test("a vanished/non-thread channel closes the session and acks", async () => {
    const r = rig({ channelFetch: async () => null });
    await captureLogs(() => r.handle(evt("session_live")));
    expect(r.closeSession).toHaveBeenCalledWith({ session_id: SESSION_ID });
  });

  test("a transient Discord failure propagates so the receiver 500s and para-raid redelivers", async () => {
    const thread = fakeThread({
      send: mock(async () => {
        throw new Error("ECONNRESET");
      }),
    });
    const r = rig({ thread });
    await expect(r.handle(evt("session_live"))).rejects.toThrow("ECONNRESET");
    expect(r.closeSession).not.toHaveBeenCalled();
  });
});

// U6: unmapped librarian sessions. Uses the REAL SessionCache so the registration + refresh
// mechanics are exercised, not faked — only the daemon client and Discord are stubs.
describe("librarian sessions (U6 — adapter_ref is not a thread id)", () => {
  const LIB_SESSION_ID = "s-lib";
  const LIB_REF = "librarian:2026-07-16";
  const LIB_CHANNEL_ID = "123456789012345678";
  const LIB_THREAD_ID = "999999999999999999";

  function libSession(over: Partial<Session> = {}): Session {
    return {
      id: LIB_SESSION_ID,
      adapter_id: "uxie",
      adapter_ref: LIB_REF,
      status: "live",
      tmux_session: "tmux-lib",
      cwd: "/work",
      created_at: 1,
      updated_at: 2,
      last_turn_at: null,
      recovery_expires_at: null,
      ...over,
    };
  }

  interface LibRig {
    handle: (e: ParaRaidEvent) => Promise<void>;
    sessions: SessionCache;
    create: ReturnType<typeof mock>;
    createdThread: any;
    channelFetch: ReturnType<typeof mock>;
    closeSession: ReturnType<typeof mock>;
  }

  function libRig(over: {
    channelId?: string | undefined; // pass the key with undefined to model "env absent"
    activeThreads?: any[];
    daemonSessions?: () => Session[];
    channelFetch?: (id: string) => Promise<unknown>;
  } = {}): LibRig {
    const sessions = new SessionCache({
      listSessions: async () => ({
        status: 200,
        body: { sessions: (over.daemonSessions ?? (() => [libSession()]))(), next_cursor: null },
      }),
    } as unknown as ParaRaidClient);
    const createdThread = fakeThread({ id: LIB_THREAD_ID, name: LIB_REF });
    const create = mock(async (_: { name: string }) => createdThread);
    const active = over.activeThreads ?? [];
    const channel = {
      type: ChannelType.GuildText,
      threads: {
        fetchActive: async () => ({ threads: { find: (fn: (t: any) => boolean) => active.find(fn) } }),
        create,
      },
    };
    const threadsById: Record<string, any> = { [LIB_THREAD_ID]: createdThread };
    for (const t of active) threadsById[t.id] = t;
    const channelFetch = mock(
      over.channelFetch ??
        (async (id: string) => (id === LIB_CHANNEL_ID ? channel : (threadsById[id] ?? null))),
    );
    const closeSession = mock(async (_: { session_id: string }) => ({ status: 200, body: {} }));
    const deps = {
      client: { channels: { fetch: channelFetch } },
      api: { closeSession },
      sessions,
      librarianChannelId: "channelId" in over ? over.channelId : LIB_CHANNEL_ID,
    } as unknown as EventDeps;
    return { handle: createEventHandler(deps), sessions, create, createdThread, channelFetch, closeSession };
  }

  test("creates a public thread named the adapter_ref, registers it, and the digest lands via the normal turn_replied path", async () => {
    const r = libRig();
    await r.handle(evt("session_live", {}, LIB_SESSION_ID));
    expect(r.create).toHaveBeenCalledWith({ name: LIB_REF });
    expect(r.createdThread.send).toHaveBeenCalledWith("session live");

    // Subsequent event: no second create/fetchActive — the registered mapping serves it.
    await r.handle(evt("turn_replied", { reply: "nightly digest" }, LIB_SESSION_ID));
    expect(r.createdThread.send).toHaveBeenCalledWith("nightly digest");
    expect(r.create).toHaveBeenCalledTimes(1);
  });

  test("dedups via an existing active thread with the exact adapter_ref name (in-memory cache lost on restart)", async () => {
    const existing = fakeThread({ id: "888888888888888888", name: LIB_REF });
    const r = libRig({ activeThreads: [existing, fakeThread({ id: "777", name: "other" })] });
    await r.handle(evt("turn_replied", { reply: "digest after restart" }, LIB_SESSION_ID));
    expect(r.create).not.toHaveBeenCalled();
    expect(existing.send).toHaveBeenCalledWith("digest after restart");
  });

  test("LIBRARIAN_CHANNEL_ID absent: librarian events are logged + dropped, Discord untouched", async () => {
    const r = libRig({ channelId: undefined });
    const logs = await captureLogs(() => r.handle(evt("turn_replied", { reply: "digest" }, LIB_SESSION_ID)));
    expect(r.channelFetch).not.toHaveBeenCalled();
    expect(r.create).not.toHaveBeenCalled();
    expect(logs.some((e) => e.level === "warn" && e.msg.includes("LIBRARIAN_CHANNEL_ID"))).toBe(true);
  });

  test("a non-librarian unknown session id is still dropped with a warning (no thread created)", async () => {
    const r = libRig();
    const logs = await captureLogs(() => r.handle(evt("session_live", {}, "never-seen")));
    expect(r.create).not.toHaveBeenCalled();
    expect(logs.some((e) => e.level === "warn" && e.msg.includes("unknown session"))).toBe(true);
  });

  test("a non-librarian non-thread ref never enters the librarian path", async () => {
    const cron = libSession({ id: "s-cron", adapter_ref: "cron:2026-07-16" });
    const r = libRig({ daemonSessions: () => [cron] });
    await captureLogs(() => r.handle(evt("session_live", {}, "s-cron")));
    // Falls through to the normal post path (fetch of the raw ref finds nothing → reap + ack).
    expect(r.create).not.toHaveBeenCalled();
    expect(r.closeSession).toHaveBeenCalledWith({ session_id: "s-cron" });
  });

  test("librarian channel Unknown Channel: reaps the session and resolves (acks, never crashes)", async () => {
    const r = libRig({
      channelFetch: async () => {
        throw unknownChannelError();
      },
    });
    await captureLogs(() => r.handle(evt("session_live", {}, LIB_SESSION_ID))); // must resolve
    expect(r.closeSession).toHaveBeenCalledWith({ session_id: LIB_SESSION_ID });
  });

  test("librarian channel vanished/not-a-text-channel: reaps the session and resolves", async () => {
    const r = libRig({ channelFetch: async () => null });
    await captureLogs(() => r.handle(evt("session_live", {}, LIB_SESSION_ID)));
    expect(r.closeSession).toHaveBeenCalledWith({ session_id: LIB_SESSION_ID });
  });
});
