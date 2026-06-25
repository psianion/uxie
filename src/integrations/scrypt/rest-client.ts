// Scrypt REST client. v1 write path is POST /api/ingest (added in Wave 2).
// Auth is Bearer ${SCRYPT_AUTH} (scrypt-contract §0); REST calls that carry an
// interaction send X-Correlation-Id: <client_tag> for tracing (scrypt-contract §0/§1.1).
// Timeouts via AbortSignal.timeout: 10s default for ingest, 500ms for the /ping health
// probe (ratified decision 5).
//
// IMPORTANT (contract vs plan): the deterministic client_tag is the X-Correlation-Id
// HEADER value, NOT a body field (scrypt-contract §1.1). The wire body is the
// contract-shaped { kind, title, content, frontmatter?, replace? }; success is 201 and
// returns { path, kind, created, side_effects? }. ingest() adapts that to the uxie-facing
// { path, permalink } shape (Design §5/§6.1), deriving the web-UI permalink from the path
// (scrypt-contract §3) and degrading to the raw path if no base URL is available.
import { z } from "zod";
import { ScryptError } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";

export type HealthReason = "unreachable" | "auth" | "server" | "timeout";

export interface HealthResult {
  ok: boolean;
  reason?: HealthReason;
}

// uxie-facing ingest params (Design §5). `clientTag` becomes the X-Correlation-Id header
// (scrypt-contract §1.1) — it is NOT placed in the body. `tz` is accepted for callers that
// want it but the server ignores tz for journal (scrypt-contract BLOCKER 1); /journal
// prepends local time into `content` instead.
export interface IngestParams {
  kind: string;
  content: string;
  clientTag: string;
  tz?: string;
  meta?: Record<string, unknown>;
}

// uxie-facing result (Design §5/§6.1). `permalink` is derived locally from the path.
export interface IngestResult {
  path: string;
  permalink: string;
}

// Contract success body (scrypt-contract §1.1 / §1.6). Parsed, never cast.
const IngestResponse = z.object({
  path: z.string(),
  kind: z.string(),
  created: z.boolean(),
  side_effects: z
    .object({
      thread_updated: z.string().optional(),
      research_run_id: z.number().optional(),
    })
    .optional(),
});

const JOURNAL_KIND = "journal";
const MAX_TITLE = 120;

// uxie-facing simplified daily context (Design §6.5 / plan Task 23). This is what
// briefEmbed + the /brief command consume — a flat projection of the rich contract body.
// `priority` is a string here because the simplified shape and the embed render it as text;
// the authoritative contract sends a numeric priority which we stringify on the way down.
export interface DailyContext {
  today_journal: string;
  recent_notes: Array<{ path: string; title: string }>;
  open_threads: Array<{ path: string; title: string; priority: string }>;
  active_memories: Array<{ name: string }>;
  tag_cloud: Array<{ tag: string; count: number }>;
}

// scrypt-contract §1.6 DailyContextResponse (authoritative, nested). Loosened with
// .passthrough()/optional so a forward-compatible server addition never fails the parse,
// but every field we PROJECT is validated (decision 2: parse, never cast).
const DailyContextContractSchema = z
  .object({
    today: z
      .object({
        journal: z.object({ content: z.string() }).passthrough(),
      })
      .passthrough(),
    recent_notes: z.array(z.object({ path: z.string(), title: z.string() }).passthrough()),
    open_threads: z.array(
      z.object({ path: z.string(), title: z.string(), priority: z.union([z.number(), z.string()]) }).passthrough(),
    ),
    active_memories: z.array(
      z.object({ title: z.string().optional(), slug: z.string().optional(), name: z.string().optional() }).passthrough(),
    ),
    tag_cloud: z.array(z.object({ tag: z.string(), count: z.number() }).passthrough()),
  })
  .passthrough();

// The simplified flat shape (used by /brief tests + when scrypt is configured to return it
// pre-flattened). Distinct from the contract shape by `today_journal` being a top-level
// string with no nested `today` object.
const DailyContextFlatSchema = z
  .object({
    today_journal: z.string(),
    recent_notes: z.array(z.object({ path: z.string(), title: z.string() }).passthrough()),
    open_threads: z.array(
      z.object({ path: z.string(), title: z.string(), priority: z.union([z.number(), z.string()]) }).passthrough(),
    ),
    active_memories: z.array(
      z.object({ name: z.string().optional(), title: z.string().optional(), slug: z.string().optional() }).passthrough(),
    ),
    tag_cloud: z.array(z.object({ tag: z.string(), count: z.number() }).passthrough()),
  })
  .passthrough();

// Project either accepted server shape down to the simplified uxie-facing DailyContext.
// Memory name resolves title -> name -> slug -> "" so both contract and flat rows map.
function toDailyContext(raw: unknown): DailyContext | null {
  const flat = DailyContextFlatSchema.safeParse(raw);
  if (flat.success) {
    const d = flat.data;
    return {
      today_journal: d.today_journal,
      recent_notes: d.recent_notes.map((n) => ({ path: n.path, title: n.title })),
      open_threads: d.open_threads.map((t) => ({ path: t.path, title: t.title, priority: String(t.priority) })),
      active_memories: d.active_memories.map((m) => ({ name: m.name ?? m.title ?? m.slug ?? "" })),
      tag_cloud: d.tag_cloud.map((t) => ({ tag: t.tag, count: t.count })),
    };
  }
  const nested = DailyContextContractSchema.safeParse(raw);
  if (nested.success) {
    const d = nested.data;
    return {
      today_journal: d.today.journal.content,
      recent_notes: d.recent_notes.map((n) => ({ path: n.path, title: n.title })),
      open_threads: d.open_threads.map((t) => ({ path: t.path, title: t.title, priority: String(t.priority) })),
      active_memories: d.active_memories.map((m) => ({ name: m.title ?? m.name ?? m.slug ?? "" })),
      tag_cloud: d.tag_cloud.map((t) => ({ tag: t.tag, count: t.count })),
    };
  }
  return null;
}

// Derive the required contract `title` from content for non-journal kinds (the contract
// requires title.min(1) but ignores it for journal). First non-empty line, trimmed/capped.
function deriveTitle(content: string): string {
  const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? content;
  const trimmed = firstLine.trim();
  const t = trimmed.length > MAX_TITLE ? trimmed.slice(0, MAX_TITLE) : trimmed;
  return t.length > 0 ? t : "untitled";
}

// Web-UI permalink from a vault-relative path (scrypt-contract §3): strip trailing .md and
// join to the base URL. Presumed scheme (flagged BLOCKER in the contract) — degrade to the
// raw path when no base URL is configured so the embed always has something to show.
function toPermalink(baseUrl: string, path: string): string {
  const noExt = path.endsWith(".md") ? path.slice(0, -3) : path;
  if (!baseUrl) return path;
  return `${baseUrl.replace(/\/+$/, "")}/${noExt.replace(/^\/+/, "")}`;
}

export class ScryptRestClient {
  constructor(
    private baseUrl: string,
    private bearer: string,
  ) {}

  // Base headers for every REST call. `correlationId` is the deterministic client_tag;
  // omitted on the health probe (no interaction context). Authorization is redacted
  // by the logger before any of this reaches stdout.
  private headers(correlationId?: string): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.bearer}`,
      "Content-Type": "application/json",
    };
    if (correlationId !== undefined) h["X-Correlation-Id"] = correlationId;
    return h;
  }

  // Last observed connectivity (null = not yet probed). Scrypt's reachability is only ever
  // observed through this probe, so up↔down transitions are logged here — once each — rather
  // than on every probe; repeat-down probes (e.g. the /ping auto-retry loop) stay silent.
  private lastHealthy: boolean | null = null;

  // REST health probe used by /ping (Design §6.7). Scrypt exposes no /api/health, so we
  // hit the shallow GET /api/daily_context. Degrade-don't-crash: returns {ok,reason}
  // and never throws, so /ping always replies even when scrypt is down.
  async health(): Promise<HealthResult> {
    const result = await this.probeHealth();
    this.noteTransition(result);
    return result;
  }

  private async probeHealth(): Promise<HealthResult> {
    try {
      const res = await fetch(`${this.baseUrl}/api/daily_context`, {
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

  // The single v1 write primitive — POST /api/ingest (scrypt-contract §1.1). Used by
  // /capture and /journal. The clientTag rides the X-Correlation-Id header
  // (decision 3); the body is contract-shaped. Throws a typed ScryptError on any non-201
  // so the interaction-router's catch site maps it to a user-facing ephemeral message —
  // there is no try/catch upstream of here in command bodies (decision 10).
  async ingest(p: IngestParams): Promise<IngestResult> {
    const body: Record<string, unknown> = {
      kind: p.kind,
      title: deriveTitle(p.content),
      content: p.content,
    };
    if (p.meta !== undefined) body.frontmatter = p.meta;
    // tz is accepted by uxie but the server ignores it for journal (contract BLOCKER 1);
    // forward it as frontmatter so it is harmless when ignored and visible otherwise.
    if (p.tz !== undefined && p.kind !== JOURNAL_KIND) {
      body.frontmatter = { ...(body.frontmatter as Record<string, unknown> | undefined), tz: p.tz };
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/ingest`, {
        method: "POST",
        headers: this.headers(p.clientTag),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      const name = (e as Error).name;
      if (name === "TimeoutError") throw new ScryptError("scrypt_timeout", "scrypt timed out", e);
      throw new ScryptError("scrypt_unreachable", "scrypt unreachable", e);
    }

    if (res.status === 201 || res.status === 200) {
      const json = await res.json().catch(() => null);
      const parsed = IngestResponse.safeParse(json);
      if (!parsed.success) {
        throw new ScryptError("scrypt_bad_response", "scrypt returned an unexpected ingest body");
      }
      return { path: parsed.data.path, permalink: toPermalink(this.baseUrl, parsed.data.path) };
    }
    if (res.status === 401 || res.status === 403)
      throw new ScryptError("scrypt_auth", "scrypt auth rejected");
    if (res.status >= 500) throw new ScryptError("scrypt_server", "scrypt server error");
    const msg = await res.text().catch(() => "");
    throw new ScryptError("scrypt_bad_request", `scrypt: ${msg || res.statusText}`);
  }

  // GET /api/daily_context — the read that drives /brief (scrypt-contract §1.2). Full 10s
  // timeout (this is the manual-brief read path, not the 500ms health probe). The body is
  // zod-parsed and projected to the simplified DailyContext (decision 2: never cast). Throws
  // a typed ScryptError on any non-200 / unparseable body so the router maps it to a
  // user-facing message — no try/catch upstream in the command body (decision 10).
  async getDailyContext(): Promise<DailyContext> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/daily_context`, {
        method: "GET",
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      const name = (e as Error).name;
      if (name === "TimeoutError") throw new ScryptError("scrypt_timeout", "scrypt timed out", e);
      throw new ScryptError("scrypt_unreachable", "scrypt unreachable", e);
    }
    if (res.status === 401 || res.status === 403)
      throw new ScryptError("scrypt_auth", "scrypt auth rejected");
    if (res.status >= 500) throw new ScryptError("scrypt_server", "scrypt server error");
    if (res.status !== 200) {
      const txt = await res.text().catch(() => "");
      throw new ScryptError("scrypt_bad_request", `scrypt: ${txt || res.statusText}`);
    }
    const json = await res.json().catch(() => null);
    const ctx = toDailyContext(json);
    if (ctx === null) {
      throw new ScryptError("scrypt_bad_response", "scrypt returned an unexpected daily_context body");
    }
    return ctx;
  }
}

// Re-export so callers needing to narrow on scrypt faults import from the client module
// alongside the client itself; the taxonomy itself lives in lib/errors.ts.
export { ScryptError };
