// para-raid control client over the daemon's unix socket. Mirrors para-raid's own
// reference-adapter client (para-raid/examples/reference-adapter/client.ts): identity is the
// per-adapter bearer token ALONE — the daemon derives the caller's adapter id from the token,
// and every mutating call carries a fresh Idempotency-Key so a network retry is a server-side
// no-op (the daemon caches the first 2xx response per key for 24h). listSessions is a GET and
// carries no Idempotency-Key (it isn't mutating). A 5s AbortSignal.timeout bounds every call —
// the socket is loopback-local, so anything slower than that is the daemon wedged, not network.
import { randomUUID } from "node:crypto";

export type SessionStatus = "launching" | "live" | "recovering" | "dead" | "closed" | "closing";

// GET /v1/sessions row shape (src/api/handlers/sessions-list.ts).
export interface Session {
  id: string;
  adapter_id: string;
  adapter_ref: string;
  status: SessionStatus;
  tmux_session: string;
  cwd: string;
  created_at: number;
  updated_at: number;
  last_turn_at: number | null;
  recovery_expires_at: number | null;
}

export interface ApiResult<T> {
  status: number;
  body: T;
}

const TIMEOUT_MS = 5000;

export class ParaRaidClient {
  constructor(
    private socketPath: string,
    private token: string,
  ) {}

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs: number = TIMEOUT_MS,
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      headers["Idempotency-Key"] = randomUUID();
    }
    const res = await fetch(`http://para-raid${path}`, {
      method,
      // Bun routes the request over the unix socket; the host above is ignored.
      unix: this.socketPath,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
  }

  openSession(req: { adapter_ref: string; prompt: string; bundle_name?: string }) {
    return this.call<{ session_id: string; turn_id?: string; status: string }>(
      "POST",
      "/v1/open_session",
      req,
    );
  }

  sendTurn(req: { session_id: string; prompt: string }) {
    return this.call<{ session_id: string; turn_id: string; status: string; error?: string }>(
      "POST",
      "/v1/send_turn",
      req,
    );
  }

  closeSession(req: { session_id: string }) {
    return this.call<{ session_id: string; status: string }>("POST", "/v1/close_session", req);
  }

  resumeSession(req: { session_id: string }) {
    // resume_session blocks while the daemon runs `claude --resume` (up to 3
    // attempts with backoff; ~18s observed on a cold machine). The default 5s
    // timeout made uxie hang up early, retry, and race a second resume that
    // killed the session. 120s comfortably covers the daemon's worst case.
    return this.call<{ session_id: string; status: string; error?: string }>(
      "POST",
      "/v1/resume_session",
      req,
      120_000,
    );
  }

  // ponytail: unfiltered, first page only (default limit 50) — max_total_sessions defaults to
  // 10, so a single owner-run adapter never comes close to needing cursor pagination here.
  listSessions() {
    return this.call<{ sessions: Session[]; next_cursor: number | null }>("GET", "/v1/sessions");
  }
}
