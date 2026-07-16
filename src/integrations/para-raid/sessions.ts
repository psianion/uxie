// In-memory thread<->session cache (v1's statelessness invariant, D2 — no disk state). ANY
// miss — a webhook for an unknown session id, or a message in an unknown thread — triggers
// exactly one refresh from GET /v1/sessions and one retry of the lookup. A uxie restart loses
// nothing: the daemon is the source of truth and a cold cache just costs one extra round trip.
import type { ParaRaidClient, Session } from "./client.ts";

// A4: rebuild UNFILTERED (no ?status= query) and keep only the statuses a thread should still
// be talking to. dead/closed/closing sessions age out of the cache on the next refresh.
const LIVE_STATUSES = new Set<Session["status"]>(["live", "launching", "recovering"]);

export class SessionCache {
  private byThread = new Map<string, Session>(); // effective thread id (see threadFor) -> session
  private bySession = new Map<string, Session>(); // session id -> session
  // U6: explicit thread registrations for sessions whose adapter_ref is NOT a thread id (e.g.
  // CLI-opened librarian sessions, adapter_ref "librarian:<utc-date>"). Survives refresh —
  // refresh rebuilds from GET /v1/sessions, which knows nothing about the Discord thread we
  // created — and ages out with its session below.
  private threadBySession = new Map<string, string>();

  constructor(private client: ParaRaidClient) {}

  private async refresh(): Promise<void> {
    const res = await this.client.listSessions();
    if (res.status !== 200) return; // best-effort; the caller's post-refresh lookup just misses too
    this.byThread.clear();
    this.bySession.clear();
    for (const s of res.body.sessions) {
      if (!LIVE_STATUSES.has(s.status)) continue;
      this.byThread.set(this.threadFor(s), s);
      this.bySession.set(s.id, s);
    }
    // Registrations for sessions the daemon no longer reports live age out with them.
    for (const id of this.threadBySession.keys()) {
      if (!this.bySession.has(id)) this.threadBySession.delete(id);
    }
  }

  /** The Discord thread a session's events post to: an explicit registration wins over adapter_ref. */
  threadFor(session: Session): string {
    return this.threadBySession.get(session.id) ?? session.adapter_ref;
  }

  /** U6: map a session to a thread when its adapter_ref is not the thread id (librarian sessions). */
  registerThread(sessionId: string, threadId: string): void {
    this.threadBySession.set(sessionId, threadId);
    const s = this.bySession.get(sessionId);
    if (s) {
      this.byThread.delete(s.adapter_ref); // drop the stale non-thread key, if cached
      this.byThread.set(threadId, s);
    }
  }

  private async resolve<K>(map: Map<K, Session>, key: K): Promise<Session | undefined> {
    const hit = map.get(key);
    if (hit) return hit;
    await this.refresh();
    return map.get(key);
  }

  resolveByThread(threadId: string): Promise<Session | undefined> {
    return this.resolve(this.byThread, threadId);
  }

  resolveBySession(sessionId: string): Promise<Session | undefined> {
    return this.resolve(this.bySession, sessionId);
  }

  // The daemon said this session is gone (e.g. send_turn 404) but a refresh may still list it
  // (status can lag) — evict explicitly so the next resolve misses and re-fetches truth.
  invalidate(sessionId: string): void {
    const s = this.bySession.get(sessionId);
    if (s) this.byThread.delete(this.threadFor(s));
    this.bySession.delete(sessionId);
  }

  // A8: paused/resumed webhooks carry session_id: null, so there's nothing to resolve — always
  // refresh first so the fanout reaches every thread the daemon currently reports live for us,
  // not just whatever happened to already be cached.
  async liveThreadIds(): Promise<string[]> {
    await this.refresh();
    return [...this.byThread.keys()];
  }
}
