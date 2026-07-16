// Scrypt client: /ping health probe + connectivity tracking, plus the v2 capture/query
// surface (contract: docs/research/scrypt-contract.md, verified against scrypt main):
//   - createNote()    — MCP create_note (POST /mcp, JSON-RPC): the ONLY path that can file a
//                       capture into projects/_inbox (POST /api/ingest routes to the legacy
//                       notes/... folders and carries no client_tag). Idempotent server-side
//                       by client_tag (24h dedup cache), so a Discord retry is a no-op.
//   - journalEntry()  — POST /api/journal/<utc-today>/entries (kind:journal is GONE from ingest)
//   - hybridSearch()  — GET /api/search/hybrid (BM25 + embedding cosine via RRF)
//   - dailyContext()  — GET /api/daily-context (canonical hyphen path)
// uxie NEVER writes vault markdown directly — REST/MCP only (plane rule). Auth is Bearer
// ${SCRYPT_AUTH}; the bearer must stay off untrusted wire, enforced at boot by env.ts
// (UX-SEC-002). X-Correlation-Id carries the deterministic clientTag on every request.
import { log } from "../../lib/log.ts";
import {
  ScryptError,
  ScryptAuthError,
  ScryptBadRequestError,
  ScryptTimeoutError,
} from "../../lib/errors.ts";
import type { z } from "zod";
import {
  CreateNoteResult,
  DailyContextResponse,
  HybridSearchResponse,
  JournalDayBundle,
  McpEnvelope,
} from "./schemas.ts";

export type HealthReason = "unreachable" | "auth" | "server" | "timeout";

export interface HealthResult {
  ok: boolean;
  reason?: HealthReason;
}

// Writes + /brief run after the router's deferReply, so they get the same 5s budget as the
// para-raid client (loopback-or-LAN scrypt: slower than 5s means wedged, not slow network).
const WRITE_TIMEOUT_MS = 5000;
// /search replies un-deferred (Components V2 must be set at reply time), so the whole
// command must beat Discord's 3s initial-response window — cap the fetch at 2.5s.
const SEARCH_TIMEOUT_MS = 2500;

// Capture slug: UTC date-time stamp + slugified title, matching scrypt's own dated-note
// convention (destinationFor "thought"). The stamp makes accidental same-title overwrites
// structurally near-impossible (create_note is create-or-replace); retry idempotency comes
// from client_tag, not the path. Fits scrypt's SLUG_RE (lowercase a-z0-9, single hyphens)
// and its 40-char slug cap: 15 (stamp) + 1 + 24 (title part) = 40.
export function captureSlug(title: string, now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  return base ? `${stamp}-${base}` : stamp;
}

export class ScryptRestClient {
  constructor(
    private baseUrl: string,
    private bearer: string,
  ) {}

  // Last observed connectivity (null = not yet probed). Scrypt's reachability is only ever
  // observed through this probe, so up↔down transitions are logged here — once each — rather
  // than on every probe; repeat-down probes (e.g. the /ping auto-retry loop) stay silent.
  private lastHealthy: boolean | null = null;

  // REST health probe used by /ping (Design §6.7). Scrypt exposes no /api/health, so we hit
  // the shallow GET /api/daily-context (canonical hyphen path; the old underscore spelling is
  // a permanent alias but new code uses the canonical one). Degrade-don't-crash: returns
  // {ok,reason} and never throws, so /ping always replies even when scrypt is down.
  async health(): Promise<HealthResult> {
    const result = await this.probeHealth();
    this.noteTransition(result);
    return result;
  }

  // === v2 capture/query surface ===

  /**
   * File a capture into the vault's unintegrated inbox: projects/_inbox/other/<slug>.md via
   * the MCP create_note tool (the projects/ layout writer; /api/ingest cannot target it).
   * Idempotent by clientTag — the server replays the cached response for a duplicate tag,
   * so Discord retries can't double-file. Frontmatter project/doc_type/slug must match the
   * path segments (create_note validates); doc_type "other" = unclassified capture.
   */
  async createNote(input: { title: string; content: string; clientTag: string }): Promise<{ path: string }> {
    const slug = captureSlug(input.title);
    const path = `projects/_inbox/other/${slug}.md`;
    const content = [
      "---",
      `title: ${JSON.stringify(input.title)}`,
      "project: _inbox",
      "doc_type: other",
      `slug: ${JSON.stringify(slug)}`,
      "---",
      "",
      input.content,
      "",
    ].join("\n");

    const data = await this.json("/mcp", {
      method: "POST",
      timeoutMs: WRITE_TIMEOUT_MS,
      clientTag: input.clientTag,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: input.clientTag,
        method: "tools/call",
        params: {
          name: "create_note",
          arguments: { path, content, client_tag: input.clientTag },
        },
      }),
    });

    const envelope = this.parse(McpEnvelope, data);
    if (envelope.error) {
      throw new ScryptError("scrypt_mcp", envelope.error.message);
    }
    const text = envelope.result?.content[0]?.text;
    if (!envelope.result || text === undefined) {
      throw new ScryptError("scrypt_bad_response", "mcp response carried no content");
    }
    if (envelope.result.isError) {
      // Tool-execution error: content[0].text is JSON of { code, message, ... }.
      let msg = text;
      try {
        const parsed = JSON.parse(text) as { message?: unknown };
        if (typeof parsed.message === "string") msg = parsed.message;
      } catch {
        // keep raw text
      }
      throw new ScryptError("scrypt_mcp_tool", msg);
    }
    // DOUBLE-PARSE: the tool payload is stringified JSON inside content[0].text.
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ScryptError("scrypt_bad_response", "mcp tool payload was not json");
    }
    const result = this.parse(CreateNoteResult, payload);
    return { path: result.note_path };
  }

  /** Append a journal entry to today's (UTC) day file. Returns the day bundle. */
  async journalEntry(body: string, clientTag: string): Promise<JournalDayBundle> {
    const date = new Date().toISOString().slice(0, 10); // UTC day key — matches scrypt todayKey()
    const data = await this.json(`/api/journal/${date}/entries`, {
      method: "POST",
      timeoutMs: WRITE_TIMEOUT_MS,
      clientTag,
      body: JSON.stringify({ body }),
    });
    return this.parse(JournalDayBundle, data);
  }

  /** Accuracy-first search: BM25 + embedding cosine fused via RRF (k=60). */
  async hybridSearch(q: string, opts: { limit?: number; clientTag?: string } = {}): Promise<HybridSearchResponse> {
    const params = new URLSearchParams({ q, limit: String(opts.limit ?? 5) });
    const data = await this.json(`/api/search/hybrid?${params}`, {
      method: "GET",
      timeoutMs: SEARCH_TIMEOUT_MS,
      clientTag: opts.clientTag,
    });
    return this.parse(HybridSearchResponse, data);
  }

  /** Today's journal presence + recent notes + open threads (drives /brief). */
  async dailyContext(clientTag?: string): Promise<DailyContextResponse> {
    const data = await this.json("/api/daily-context", {
      method: "GET",
      timeoutMs: WRITE_TIMEOUT_MS,
      clientTag,
    });
    return this.parse(DailyContextResponse, data);
  }

  // === plumbing ===

  private headers(clientTag?: string): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.bearer}`,
      "Content-Type": "application/json",
    };
    if (clientTag) h["X-Correlation-Id"] = clientTag;
    return h;
  }

  // fetch + status triage + JSON body. All faults surface as typed ScryptError subclasses
  // (timeout retryable, auth/bad-request not) which the interaction-router's `scrypt error`
  // branch renders to the owner. Command bodies stay try/catch-free.
  private async json(
    path: string,
    init: { method: "GET" | "POST"; timeoutMs: number; clientTag?: string; body?: string },
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: this.headers(init.clientTag),
        body: init.body,
        signal: AbortSignal.timeout(init.timeoutMs),
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") {
        throw new ScryptTimeoutError("scrypt_timeout", `scrypt timed out (${init.timeoutMs}ms)`, e);
      }
      throw new ScryptError("scrypt_unreachable", "scrypt unreachable", e);
    }
    if (res.status === 401 || res.status === 403) {
      // 401 bodies are empty by design (even when the server has no token configured).
      throw new ScryptAuthError("scrypt_auth", "auth rejected (401/403) — check SCRYPT_AUTH");
    }
    if (res.status === 400 || res.status === 409) {
      const serverMsg = await res
        .json()
        .then((b) => (b as { error?: unknown })?.error)
        .catch(() => undefined);
      throw new ScryptBadRequestError(
        "scrypt_bad_request",
        typeof serverMsg === "string" ? serverMsg : `rejected (${res.status})`,
      );
    }
    if (!res.ok) {
      throw new ScryptError("scrypt_server", `server error (${res.status})`);
    }
    try {
      return await res.json();
    } catch (e) {
      throw new ScryptError("scrypt_bad_response", "invalid json from scrypt", e);
    }
  }

  private parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
    const r = schema.safeParse(data);
    if (!r.success) {
      throw new ScryptError("scrypt_bad_response", "unexpected response shape from scrypt", r.error);
    }
    return r.data;
  }

  private async probeHealth(): Promise<HealthResult> {
    try {
      const res = await fetch(`${this.baseUrl}/api/daily-context`, {
        method: "GET",
        headers: this.headers(),
        signal: AbortSignal.timeout(500),
      });
      if (res.status === 200) return { ok: true };
      if (res.status === 401 || res.status === 403) return { ok: false, reason: "auth" };
      if (res.status >= 500) return { ok: false, reason: "server" };
      return { ok: false, reason: "server" };
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") {
        return { ok: false, reason: "timeout" };
      }
      return { ok: false, reason: "unreachable" };
    }
  }

  // Log only when reachability flips, so the operator's log channel (warn+error) shows Scrypt
  // going down and coming back without a line per probe. A first-ever healthy probe is no news.
  private noteTransition(result: HealthResult): void {
    if (result.ok === this.lastHealthy) return;
    const first = this.lastHealthy === null;
    this.lastHealthy = result.ok;
    if (!result.ok) {
      log.warn("scrypt connectivity lost", { reason: result.reason });
    } else if (!first) {
      log.warn("scrypt connectivity restored");
    }
  }
}
