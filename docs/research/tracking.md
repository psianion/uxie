# Deep Research: Tracking / Observability for uxie v1

**Dimension:** `tracking`
**Date:** 2026-06-03
**Status:** Research input for the upcoming build workflow. Builds ON the locked spec — does not override it.
**Author:** deep-research agent

---

## 1. Context recap (what the spec already locks)

uxie is the **User plane** of the SUP three-plane system. It is a **stateless translation layer**: Discord input -> Scrypt REST writes (`POST /api/ingest`) + Scrypt MCP reads (`searchNotes`, `semanticSearch`, `getNote` via `POST /mcp` bearer). No persistent state, no business logic, no LLM calls of its own.

The "tracking" surface that already exists in the locked docs:

- **Logging is the observability primitive (Guidelines §18).** Structured JSON to stdout, one line = one event. Keys: `ts`, `level` (`debug|info|warn|error`), `msg`, plus event fields. `error` includes a stack. `interaction_id` is on **every** in-command log line so you can grep one invocation end-to-end. **No telemetry exporters in v1.** Observability is journald + `journalctl -u uxie -f` (SUP §4). Histogram/metric aggregation is explicitly deferred to Para-RAID.
- **`src/lib/log.ts`** is the locked file: structured JSON logger + `child({...})` scoping; redacts any field-key substring matching `BOT_TOKEN` / `AUTH` / `SECRET` / `KEY` to `[REDACTED]` (Plan File-Responsibility Map; Design §5.2).
- **Correlation, not metrics.** `src/lib/client-tag.ts` exports `makeClientTag(i)` -> `uxie-<id>` and `makeMessageClientTag(m)` -> `uxie-msg-<id>`. Deterministic, so Scrypt's server-side dedup handles retries. The bot keeps **no** local idempotency state.
- **Health already has a home.** `src/integrations/scrypt/rest-client.ts` (`ScryptRestClient`) is specced to expose `health()` -> `{ ok: boolean, reason?: string }`. Design §5.2 verbatim: *"If scrypt exposes `GET /api/health`, uses it directly. Otherwise falls back to a 500 ms `GET /api/daily_context` — cheap and end-to-end. Same timeout + error shape as the MCP client."*
- **`/ping` is the only health-facing command in v1** — `src/integrations/scrypt/commands/ping.ts` = "health + uptime".
- **The SUP-level health/cost surface lives elsewhere.** SUP §4 synergies: `GET /v1/ops/status` returns combined health for Scrypt + Uxie + Para-RAID; **cost telemetry is collected by Para-RAID** (it brokers Claude turns, records token spend per session/worker/Uxie command — "single metric source"); "shared healthcheck loop — one cron, one health endpoint, one alert path."
- **`#notifications` / `vault:embedding` WebSocket bridge (FC-09) is a v2 Non-Goal.** The WS exists on Scrypt and is reachable over Tailscale, but v1 does not consume it.
- **Allowed uxie-local state is enumerated** (Ideation §9): *"The only uxie-local state is an idempotency dedup table + notification mute registry + last-known correlation ids."* Everything else persistent lives in Scrypt. **Note:** even these three are forward-looking — v1's locked stance is that dedup is server-side (deterministic `client_tag`) and the mute registry / notifications are v2.

### Drift found during research (flag for the doc-owner)

The **design-spec body (§ around line 268)** still says: *"v1 uses `crypto.randomUUID()` for slash commands and `msg.id` for `#inbox`"* for `client_tag`. This **contradicts** the locked `client-tag.ts` (`uxie-<id>` deterministic) in both the Plan's File-Responsibility Map and the baseline decisions. This matters for tracking because **non-deterministic `client_tag` breaks server-side idempotency on retry** and breaks the "grep one tag end-to-end across planes" story. Recommendation R8 below resolves it; the doc must be updated before code is written (SUP §13: docs are source of truth, fix the doc first).

---

## 2. The core question, answered up front

> Should v1 add metrics / tracing / health endpoints / error-tracking?

**No new subsystem in v1.** The spec is right: for a single-owner bot whose entire job is translate-and-forward, the highest-value observability is **structured logs with a correlation id**, which is already specced. Everything beyond that either (a) duplicates what Para-RAID is explicitly chartered to own (metrics aggregation, cost, the unified `/v1/ops/status`), or (b) adds a stateful counter store that brushes against the stateless rule.

What v1 *should* do is make the **already-locked logging and `health()` surfaces excellent and consistent**, and add exactly one tiny, stateless enhancement: a richer `/ping` that does an end-to-end Scrypt reachability probe (REST + MCP) and reports it in one ephemeral embed. That is the v1 "tracking" deliverable. Concrete counters/histograms/tracing/error-tracking are designed here but deferred to v1.5/v2 with explicit triggers.

Guiding principle: **logs are the source of truth; metrics are a derived view that belongs to the Ops plane (Para-RAID).** uxie emits well-shaped events; Para-RAID (or `journalctl | jq`) aggregates them. This keeps uxie stateless and keeps the plane boundary intact.

---

## 3. Recommended approach (v1)

### 3.1 Logging contract — make `interaction_id` a first-class, structured field

Lock the per-event log schema so the logs are machine-parseable (by `jq`, by Para-RAID later) without an exporter. This is the backbone of all tracking.

```ts
// src/lib/log.ts (shape — fits the locked "structured JSON + child() + redact" spec)
type Level = "debug" | "info" | "warn" | "error";

interface LogEvent {
  ts: string;            // new Date().toISOString()
  level: Level;
  msg: string;
  // correlation
  interaction_id?: string;   // i.id           — slash commands
  message_id?: string;       // msg.id         — #inbox
  client_tag?: string;       // uxie-<id> / uxie-msg-<id> — ties uxie log -> scrypt note
  // event-specific (examples)
  command?: string;          // "capture" | "search" | ...
  scrypt_op?: string;        // "ingest" | "searchNotes" | "semanticSearch" | "getNote" | "health"
  duration_ms?: number;      // end - start, computed inline, NOT stored
  outcome?: "ok" | "empty" | "error";
  err_kind?: string;         // ScryptError | ConfigError | NotOwnerError | DiscordAPIError
  http_status?: number;
}

export interface Logger {
  debug(msg: string, fields?: Partial<LogEvent>): void;
  info(msg: string, fields?: Partial<LogEvent>): void;
  warn(msg: string, fields?: Partial<LogEvent>): void;
  error(msg: string, fields?: Partial<LogEvent>): void;
  child(bound: Partial<LogEvent>): Logger;   // child({ interaction_id, command, client_tag })
}
```

**Convention:** the interaction-router and message-router (the two non-top-level catch sites) each create a `child` logger bound with the correlation fields at the boundary and pass it down via the command context. Every command and every Scrypt call logs through that child, so `interaction_id` + `client_tag` appear automatically — **without** any `try/catch` inside command bodies and without command authors having to remember to attach the id.

**`duration_ms` is computed inline and emitted, never accumulated.** `const t = performance.now(); ... log.info("scrypt ingest", { scrypt_op: "ingest", duration_ms: Math.round(performance.now() - t), outcome: "ok" })`. This gives you per-call latency in the logs (you can `jq` a p50/p95 after the fact) with **zero in-memory state** — fully stateless-compliant.

**Why this beats a metrics library in v1:** for one user, the volume is tiny; a structured log line per Scrypt call already contains everything a histogram would (latency, op, outcome, status). You aggregate on demand with `journalctl -u uxie -o cat | jq` rather than running a counter store. This is the standard "logs-first, derive-metrics-later" posture for low-volume single-tenant services.

### 3.2 `Scrypt reachability` — fold health() into a single probe used by `/ping`

Keep the specced `health()` shape and add a symmetric MCP probe so `/ping` can report **both** transports (the two things that can independently break: REST ingest path and MCP read path).

```ts
// src/integrations/scrypt/rest-client.ts  (health() is already specced)
async health(): Promise<{ ok: boolean; reason?: string; ms: number }> {
  const t = performance.now();
  try {
    // prefer GET /api/health; fall back to a cheap GET /api/daily_context, 500ms budget
    const res = await fetch(`${this.serverUrl}/api/health`, {
      headers: { Authorization: `Bearer ${this.auth}` },
      signal: AbortSignal.timeout(500),
    });
    const ms = Math.round(performance.now() - t);
    return res.ok ? { ok: true, ms } : { ok: false, reason: `HTTP ${res.status}`, ms };
  } catch (e) {
    return { ok: false, reason: shortReason(e), ms: Math.round(performance.now() - t) };
  }
}
```

```ts
// src/integrations/scrypt/mcp-client.ts  (add a tiny read-only liveness probe)
// v1 MCP client is read-only and per-call. The cheapest liveness probe that
// exercises the real auth + transport is a bounded searchNotes("", 1) or a
// dedicated lightweight tool if scrypt exposes one. Reuse the same 500ms budget.
async ping(): Promise<{ ok: boolean; reason?: string; ms: number }> { /* same shape */ }
```

`/ping` then renders one ephemeral embed (classic embed — Components V2 stays v1.5+):

```ts
// src/integrations/scrypt/commands/ping.ts  (sketch — owner-gate is line 1, no try/catch)
export async function execute(i: ChatInputCommandInteraction, ctx: Ctx) {
  assertOwner(i.user);                                   // FIRST line, throws NotOwnerError
  const sent = await i.reply({ content: "Pinging…", withResponse: true,
                               flags: MessageFlags.Ephemeral });
  const wsPing = i.client.ws.ping;                        // -1 before first heartbeat — guard it
  const roundtrip = sent.resource!.message.createdTimestamp - i.createdTimestamp;
  const [rest, mcp] = await Promise.all([ctx.scrypt.rest.health(), ctx.scrypt.mcp.ping()]);
  const uptime = Math.round(process.uptime());           // process-level, stateless
  await i.editReply({ embeds: [pingEmbed({ wsPing, roundtrip, rest, mcp, uptime })] });
}
```

Reported fields: WS heartbeat (`client.ws.ping`, shown as "warming up" when `-1`), Discord roundtrip (`createdTimestamp` delta), Scrypt REST reachability + ms, Scrypt MCP reachability + ms, process uptime. This is the entire v1 health surface and it is **stateless** (uptime is `process.uptime()`, not a stored counter).

> discord.js note: `client.ws.ping` returns `-1` until the first HEARTBEAT_ACK (~tens of ms after connect). `/ping` must render that as "warming up", not "-1ms". On the v15 path this moves to `Client#ping`; flag the symbol so migration is mechanical (discord.js-surface §6 Observability bucket).

### 3.3 Health *signal* for orchestration: rely on the process + the log stream, not an HTTP endpoint

v1 runs on Docker Desktop; prod is a single VPS. The spec already says crashes rely on Docker/systemd restart. For v1 the right "health for the supervisor" is:

- **Liveness = the process is up** (`Client#isReady()` true after `Events.ClientReady`). Docker `HEALTHCHECK` / systemd can treat process-alive as liveness. No HTTP endpoint needed for one bot.
- **Readiness/health-of-dependencies = `/ping`** (owner-invoked) and the **structured log stream** (auto, continuous). The aggregated `GET /v1/ops/status` that SUP §4 wants is **Para-RAID's** job to assemble — it can shell `journalctl -u uxie` or (v2) hit a uxie endpoint.

**Recommendation:** do **not** add an HTTP server to uxie in v1 just to expose `/healthz` or `/metrics`. uxie has no HTTP server today (it is a gateway client), and adding `Bun.serve` introduces a new ingress surface, a new port, and a new thing to secure on the Tailscale mesh — for a single-owner bot whose owner can type `/ping`. If/when Para-RAID needs to scrape uxie programmatically, expose it then (v2, see R6) behind the Tailscale/Unix-socket boundary SUP §4 already prefers.

---

## 4. Deferred designs (v1.5 / v2) — designed now so the seam is right

### 4.1 In-process counters / latency view (`/status`) — v1.5, stateless-bounded

If, after living with logs, you want an at-a-glance "since boot" view without `jq`, the **minimal stateless-compatible** option is **process-lifetime in-memory counters** (reset on restart, never persisted). This does **not** violate "no custom storage" because nothing is written to disk and nothing crosses a request boundary as cached *business* data — it is pure process telemetry, the same category as `process.uptime()`.

```ts
// src/lib/metrics.ts  (v1.5 — in-memory, process-lifetime, NO persistence)
interface Counters {
  commands: Record<string, { ok: number; err: number; empty: number }>;
  scrypt:  Record<string, { count: number; errs: number; ms_sum: number; ms_max: number }>;
  bootedAt: number;
}
// expose via a /status command embed: per-command counts, error rate,
// scrypt op avg/max latency, uptime. Reset on restart — that's fine for one user.
```

Honest caveat: this is a **soft edge** of the stateless rule. It is in-memory only and telemetry-only, so it is defensible, but it is the first thing that grows a heartbeat the bot doesn't strictly need. Gate it behind a real desire to not type `jq`. **A full Prometheus `prom-client` + `/metrics` HTTP endpoint is over-engineering for one user and is rejected for v1/v1.5** — that is exactly the aggregation job SUP charters to Para-RAID. If you ever want Prometheus, expose counters to Para-RAID and let *it* run the scrape target.

### 4.2 Distributed tracing across SUP planes — v2, reuse the correlation id, NOT OpenTelemetry-in-uxie

The single most valuable cross-plane tracing primitive **already exists**: the deterministic `client_tag` (`uxie-<id>`). It flows uxie -> Scrypt note frontmatter -> (later) Para-RAID enrichment job. To trace one capture end-to-end across all three planes, grep the tag in `journalctl -u scrypt -u uxie -u para-raid` (SUP §4.7: single journald surface). **That is distributed tracing for this system** — correlation-id propagation over a shared log stream, which is the pragmatic 90% of what OTel buys you, at zero runtime cost.

**OpenTelemetry feasibility under Bun (researched):** Bun runs the OTel Node SDK via its Node-compat layer, but with real caveats — you must initialize **programmatically** (the `--require` preload path is awkward under Bun's module resolution), and **Bun-native APIs (`Bun.serve`, native `fetch`, `bun:sqlite`) are NOT auto-instrumented** — you'd hand-write spans. uxie's only outbound calls are `fetch` to Scrypt (native, not auto-instrumented) and the discord.js gateway (no OTel instrumentation exists). So OTel in uxie would be **all manual spans for marginal gain over the correlation id we already have**, plus a collector to run, plus added deps (violates the "discord.js + zod are the only runtime deps" constraint). **Verdict: do not adopt OTel in uxie.** If the SUP system ever wants true span trees, the right place is Para-RAID (the orchestrator that fans out work), exporting to a collector it owns. uxie should at most **propagate a W3C `traceparent`-style header into Scrypt REST/MCP calls** if Para-RAID later mandates one — a one-line header add, no SDK.

### 4.3 Error tracking (Sentry / self-hosted GlitchTip) — v2, low priority for single-owner

For a single-owner bot the **three locked catch sites already log full stacks to journald**. Sentry/GlitchTip buys grouping, release tracking, and alerting — valuable for a fleet, marginal for one user who already tails the logs. GlitchTip is the right pick *if* you ever want it (Sentry-API-compatible, <512MB RAM, drop-in DSN, runs on the same VPS), and the Bun Sentry SDK exists. But it adds a runtime dep + a network sink + a service to host. **Defer to v2, and only if "the bot crashed and I didn't notice" becomes a real pain.** The cheaper interim (v1.5) is **DM-the-owner-on-fatal**: the top-level `process` catch site / `Events.Error` posts one ephemeral-style alert to a Discord channel before exit. That reuses the transport the bot already has (see R5).

### 4.4 `#notifications` alerting tie-in + self-rate-limiting — v2 (FC-09, already a Non-Goal)

The `vault:embedding` WS bridge and any "server down/up, auth rotated, rate-limit hit" alert feed are **FC-09, a documented v2 slot**. When built, the tracking-relevant design rules are:
- **Coalesce/debounce** (FC-09 MVP: one "indexed N notes in Ms" per batch; window TBD 5s–5min). Rejected pattern: rapid-fire editReply streaming — debounce ≥1s.
- **Self-rate-limit alerts** so a flapping Scrypt can't spam the channel: collapse repeats within a window, post "down" once and "recovered" once (state-machine, not per-event). This is the *one* place a tiny **mute registry / last-alert-state** (the allowed uxie-local state from Ideation §9) legitimately appears — and even that is in-memory + process-lifetime, not a DB.
- Discord rate-limit visibility: discord.js exposes `RESTEvents.RateLimited` / `RateLimitData` (surface §6 "useLater Observability"). Log these as `warn` in v1 (free, no new dep); act on them (backoff/alert) in v2.

### 4.5 Cost / quota telemetry from Para-RAID — consume-only, v2

SUP §4.8 makes Para-RAID the **single cost metric source** (it brokers Claude turns; records token spend per session/worker/**per Uxie command**). uxie must **not** compute or store cost. The future hook is **read-only**: a `/cost` or `/brief`-adjacent command that does `GET {PARARAID_URL}/v1/ops/cost` and renders the embed — exactly the same "dumb adapter, render one embed" pattern as the Scrypt commands, against the para-raid module's own client. This lands when the para-raid module lands (v2). v1 does nothing here.

---

## 5. Recommended concrete v1 surface (summary)

| Surface | v1 decision |
|---|---|
| Structured logs | **Yes** — locked. Enforce the `LogEvent` schema in §3.1; bind `interaction_id`/`message_id`/`client_tag` via `child()` at the router boundary. |
| `duration_ms` per Scrypt call | **Yes** — computed inline with `performance.now()`, emitted in the log line, never accumulated. Free latency data, fully stateless. |
| `rest.health()` + `mcp.ping()` | **Yes** — `{ ok, reason?, ms }`, 500ms `AbortSignal.timeout`, REST prefers `/api/health` else `/api/daily_context`. |
| `/ping` end-to-end | **Yes** — WS heartbeat (guard `-1`), Discord roundtrip, Scrypt REST + MCP reachability, process uptime. One ephemeral classic embed. |
| Docker/systemd liveness | **Yes** — process-alive == liveness. No HTTP `/healthz`. |
| In-process counters / `/status` | **v1.5** — in-memory, process-lifetime only. Soft edge of stateless; gate behind real need. |
| Prometheus `/metrics` endpoint | **No (v1/v1.5)** — Para-RAID's job; rejected as over-engineering for one user. |
| OpenTelemetry in uxie | **No** — manual-span-only under Bun; correlation-id-over-journald is the pragmatic equivalent. |
| Cross-plane tracing | **v1 via `client_tag` grep**; true spans = Para-RAID's job (v2). |
| Error tracking (GlitchTip/Sentry) | **v2** — interim: DM-on-fatal (v1.5). |
| `#notifications` / WS alerting | **v2** — FC-09 Non-Goal; design rules captured in §4.4. |
| Cost telemetry | **v2 consume-only** — `GET /v1/ops/cost` from para-raid module. |

---

## 6. Conflicts with spec

1. **`/status` in-process counters (R3, v1.5)** — `conflictsWithSpec: true` (soft). The locked stance is "no telemetry exporters; histograms belong to Para-RAID" and "no custom storage." In-memory process-lifetime counters are not an exporter and not persisted, so they are defensible, but they push on the stateless spirit. Flagged honestly; gated to v1.5; explicitly NOT a Prometheus endpoint.
2. **DM-on-fatal alert (R5, v1.5)** — `conflictsWithSpec: false` but adjacent: it reuses the existing top-level catch site and Discord transport; it does not add a dep or storage. Mild scope add over "crashes rely on Docker/systemd restart."
3. **All other v1 recommendations are spec-aligned** — they tighten or render existing locked surfaces (`log.ts`, `health()`, `/ping`, `client-tag.ts`).
4. **Drift to fix first (R8):** the design-spec body's `crypto.randomUUID()` for slash-command `client_tag` contradicts the locked deterministic `uxie-<id>`. The doc must be corrected before code (SUP §13). This is a correctness/tracking bug, not a new feature.

---

## 7. Open questions

1. **Does Scrypt expose `GET /api/health`?** The `health()` design branches on it. If absent, the `GET /api/daily_context` fallback is authoritative — confirm it is genuinely cheap (no heavy compute) so the 500ms budget holds.
2. **Cheapest MCP liveness probe?** Does Scrypt's MCP expose a no-op/ping tool, or must `mcp.ping()` piggyback on `searchNotes("", 1)`? A bounded empty search may still hit FTS5 — confirm cost.
3. **`client_tag` drift resolution** — confirm the doc-owner standardizes on deterministic `uxie-<id>` / `uxie-msg-<id>` everywhere (R8) and updates Design §line-268.
4. **Will Para-RAID scrape uxie, or shell journald?** Determines whether a v2 read-only `/metrics`/`/v1/ops` endpoint on uxie is ever needed, or whether `journalctl | jq` + the SUP-level aggregator suffices.
5. **Log destination in v1 Docker Desktop dev** — journald is the prod story (SUP §4); in Docker Desktop, stdout -> `docker logs`. Confirm the dev `jq`-over-`docker logs` workflow is acceptable as the v1 "metrics" view.
6. **Does uxie need a `traceparent` propagation header** into Scrypt calls now (cheap, future-proofs Para-RAID spans), or is `client_tag` sufficient until Para-RAID defines a tracing contract?
7. **Coalescing window for future `#notifications`** (FC-09 open question, restated): 5s / 30s / 5min — and is the down/up alert state machine in-memory-only (stays stateless) or does it need the mute registry persisted?

---

## 8. Sources

- uxie design spec — `/Users/admin/Desktop/Files/uxie/docs/superpowers/specs/2026-04-14-uxie-design.md` (§3.3 deploy, §5.2 `health()`, `client-tag.ts`, error classes, `log.ts`, §line-268 `client_tag` drift).
- uxie implementation plan — `/Users/admin/Desktop/Files/uxie/docs/superpowers/plans/2026-04-14-uxie.md` (File-Responsibility Map: `log.ts`, `client-tag.ts`, `rest-client.ts health()`, `commands/ping.ts`).
- UXIE-DISCORD-GUIDELINES §18 (Logging & observability), §5 (intents), §17 (env/redaction) — `/Users/admin/Desktop/Files/uxie/docs/UXIE-DISCORD-GUIDELINES.md`.
- SUP-GUIDELINES §4 (Co-location synergies: `/v1/ops/status`, cost telemetry = Para-RAID, single journald surface, shared healthcheck loop) — `/Users/admin/Desktop/Files/uxie/docs/SUP-GUIDELINES.md`.
- Scrypt integration context (idempotent `client_tag`, MCP streamable-http bearer, `vault:embedding` WS) — `/Users/admin/Desktop/Files/uxie/docs/scrypt-integration-context.md`.
- Scrypt feature ideation §7 (Integration interface draft), §9 (allowed uxie-local state), FC-09 (`#notifications` WS bridge) — `/Users/admin/Desktop/Files/uxie/docs/scrypt-feature-ideation.md`.
- discord.js surface — `/Users/admin/Desktop/Files/uxie/docs/discordjs-api-surface.md` (§6 Observability bucket: `ws.ping` today / `Client#ping` v15, `RESTEvents.RateLimited`, `RateLimitData`).
- discord.js guide — Measure Bot Latency / Checking Bot Ping (`client.ws.ping`, roundtrip via `withResponse:true` + `createdTimestamp`): https://github.com/discordjs/guide/blob/main/guide/popular-topics/faq.md
- discord.js issue #3654 / Answer Overflow — `bot.ws.ping` returns `-1` before first heartbeat: https://github.com/discordjs/discord.js/issues/3654 ; https://www.answeroverflow.com/m/1171379821637541908
- OpenTelemetry in Bun (programmatic init required; Bun-native APIs not auto-instrumented): https://oneuptime.com/blog/post/2026-02-06-opentelemetry-bun-without-nodejs-require-flag/view ; https://docs.datadoghq.com/opentelemetry/guide/instrument_unsupported_runtimes/
- Sentry for Bun (SDK exists, OTel custom setup): https://docs.sentry.io/platforms/javascript/guides/bun/opentelemetry/custom-setup/
- GlitchTip vs Sentry self-hosted (Sentry-API-compatible, <512MB RAM, drop-in DSN, good for small projects): https://earezki.com/ai-news/2026-03-14-glitchtip-vs-sentry/ ; https://glitchtip.com/sdkdocs/
