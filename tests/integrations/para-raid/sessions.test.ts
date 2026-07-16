// SessionCache: thread<->session mapping fed exclusively by GET /v1/sessions (D2 — no disk
// state). The fake client is the only seam SessionCache has; only listSessions is consumed.
import { describe, expect, test } from "bun:test";
import type { ParaRaidClient, Session, SessionStatus } from "../../../src/integrations/para-raid/client.ts";
import { SessionCache } from "../../../src/integrations/para-raid/sessions.ts";

function session(id: string, threadId: string, status: SessionStatus): Session {
  return {
    id,
    adapter_id: "a1",
    adapter_ref: threadId,
    status,
    tmux_session: `tmux-${id}`,
    cwd: "/work",
    created_at: 1,
    updated_at: 2,
    last_turn_at: null,
    recovery_expires_at: null,
  };
}

function fakeClient(sessions: () => Session[], status = 200) {
  let calls = 0;
  const client = {
    listSessions: async () => {
      calls++;
      return { status, body: { sessions: sessions(), next_cursor: null } };
    },
  } as unknown as ParaRaidClient;
  return { client, calls: () => calls };
}

describe("SessionCache — resolution + refresh", () => {
  test("a cache miss triggers exactly ONE listSessions refresh; hits are then served from cache", async () => {
    const s1 = session("s1", "thread-1", "live");
    const { client, calls } = fakeClient(() => [s1]);
    const cache = new SessionCache(client);

    expect(await cache.resolveByThread("thread-1")).toEqual(s1);
    expect(calls()).toBe(1);

    // Subsequent lookups (either key) hit the cache — no further daemon round trips.
    expect(await cache.resolveByThread("thread-1")).toEqual(s1);
    expect(await cache.resolveBySession("s1")).toEqual(s1);
    expect(calls()).toBe(1);
  });

  test("a miss that stays a miss after refresh resolves undefined (one refresh, one retry)", async () => {
    const { client, calls } = fakeClient(() => []);
    const cache = new SessionCache(client);
    expect(await cache.resolveByThread("nope")).toBeUndefined();
    expect(calls()).toBe(1);
    // Every subsequent miss re-checks the daemon — the cache never caches a negative.
    expect(await cache.resolveBySession("nope")).toBeUndefined();
    expect(calls()).toBe(2);
  });

  test("keeps only live|launching|recovering; dead/closed/closing never enter the cache", async () => {
    const rows = [
      session("s-live", "t-live", "live"),
      session("s-launching", "t-launching", "launching"),
      session("s-recovering", "t-recovering", "recovering"),
      session("s-dead", "t-dead", "dead"),
      session("s-closed", "t-closed", "closed"),
      session("s-closing", "t-closing", "closing"),
    ];
    const { client } = fakeClient(() => rows);
    const cache = new SessionCache(client);

    expect(await cache.resolveBySession("s-live")).toBeDefined();
    expect(await cache.resolveBySession("s-launching")).toBeDefined();
    expect(await cache.resolveBySession("s-recovering")).toBeDefined();
    expect(await cache.resolveBySession("s-dead")).toBeUndefined();
    expect(await cache.resolveByThread("t-closed")).toBeUndefined();
    expect(await cache.resolveByThread("t-closing")).toBeUndefined();
  });

  test("a non-200 listSessions leaves the cache untouched (best-effort refresh)", async () => {
    const s1 = session("s1", "thread-1", "live");
    let status = 200;
    let calls = 0;
    const client = {
      listSessions: async () => {
        calls++;
        return { status, body: { sessions: [s1], next_cursor: null } };
      },
    } as unknown as ParaRaidClient;
    const cache = new SessionCache(client);

    await cache.resolveByThread("thread-1"); // warm
    status = 500;
    // This miss triggers a refresh that fails (500) — it must not wipe the good mapping.
    expect(await cache.resolveBySession("missing")).toBeUndefined();
    expect(await cache.resolveByThread("thread-1")).toEqual(s1);
    expect(calls).toBe(2);
  });
});

describe("SessionCache — invalidate", () => {
  test("invalidate evicts both keys so the next resolve re-fetches truth", async () => {
    const s1 = session("s1", "thread-1", "live");
    let live = true;
    const { client, calls } = fakeClient(() => (live ? [s1] : []));
    const cache = new SessionCache(client);

    await cache.resolveByThread("thread-1"); // cached
    expect(calls()).toBe(1);

    // Daemon says the session is gone (send_turn 404) but a refresh could still list it —
    // eviction must beat the stale cache.
    live = false;
    cache.invalidate("s1");
    expect(await cache.resolveByThread("thread-1")).toBeUndefined();
    expect(await cache.resolveBySession("s1")).toBeUndefined();
    expect(calls()).toBe(3); // both post-invalidate lookups missed and refreshed
  });

  test("invalidate of an unknown session id is a no-op", async () => {
    const s1 = session("s1", "thread-1", "live");
    const { client } = fakeClient(() => [s1]);
    const cache = new SessionCache(client);
    await cache.resolveByThread("thread-1");
    cache.invalidate("never-heard-of-it");
    expect(await cache.resolveByThread("thread-1")).toEqual(s1);
  });
});

describe("SessionCache — liveThreadIds", () => {
  test("always refreshes first and returns only live-status thread ids (A8 fanout)", async () => {
    const rows = [
      session("s1", "t1", "live"),
      session("s2", "t2", "recovering"),
      session("s3", "t3", "dead"),
    ];
    const { client, calls } = fakeClient(() => rows);
    const cache = new SessionCache(client);

    expect((await cache.liveThreadIds()).sort()).toEqual(["t1", "t2"]);
    expect(calls()).toBe(1);
    // A second call refreshes again — paused/resumed events carry no session_id, so the
    // fanout must reflect the daemon's CURRENT view, not a warm cache.
    rows.push(session("s4", "t4", "live"));
    expect((await cache.liveThreadIds()).sort()).toEqual(["t1", "t2", "t4"]);
    expect(calls()).toBe(2);
  });
});
