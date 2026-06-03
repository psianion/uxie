# Deep Research — Dimension: **Logging**

> Scope: best-in-class structured logging for `uxie`, the Bun User-plane bot that is one tributary of a single SUP `journald` log stream.
> Status: research input for the upcoming build workflow. Builds **on** the locked spec, not against it.
> Date: 2026-06-03

---

## 1. Context recap (what is already locked)

From the source-of-truth docs (Design §5.2, Guidelines §17–§18, Plan Task 4, SUP §3/§9):

- **Structured JSON to stdout, one line = one event.** No file logging, no exporters, no transports. (Guidelines §18; Design §5.2)
- **`lib/log.ts` is a `createLogger()` factory** with `.child(scope)` that merges scoped fields per request. Interface in Plan Task 4:
  ```ts
  export interface Logger {
    info(msg: string, fields?: Fields): void;
    warn(msg: string, fields?: Fields): void;
    error(msg: string, fields?: Fields): void;
    child(scope: Fields): Logger;
  }
  ```
- **Levels:** Plan Task 4 + Design §5.2 ship `info | warn | error`. (Baseline mentions `debug` as aspirational; the locked test does not exercise it — see §4.)
- **Mandatory redaction:** any field **key** containing the substrings `BOT_TOKEN`, `AUTH`, `SECRET`, `KEY` (case-insensitive) → value replaced with `"[REDACTED]"` **before** serialisation. Locked by the Task 4 test. (Guidelines §17.2; Design §5.2)
- **Error serialisation:** `error()` must serialise an `Error` so `line.err` contains the message/stack. Locked by the Task 4 test (`expect(line.err).toContain("root")`).
- **Output sink is `console.log`** — the Task 4 test spies on `console.log` and `JSON.parse`s `spy.mock.calls[0][0]`. The logger MUST call `console.log(JSON.stringify(line))` exactly once per event.
- **Wiring:** the interaction-router creates `log.child({ interactionId: i.id })` and passes it into `cmd.execute(i, { clientTag, log })` (Design §5.2 router snippet). `client-tag.ts` produces `uxie-<id>` / `uxie-msg-<id>` (Design §5.2).
- **Three error catch sites only:** interaction-router boundary, message-router boundary, `index.ts` top-level `process.on('uncaughtException'|'unhandledRejection')`. No try/catch in command bodies. (Guidelines §14.2; Design §7.2; consistency report rows 4–5)
- **SUP aggregation:** Docker `journald` driver → `journalctl -u scrypt -u uxie -u para-raid -f` is the single system log. SUP §9.7 = "single journald surface"; SUP §3 = "log to journald with structured JSON, one log surface for the whole box." Uxie just writes JSON to stdout; the host aggregates.

### The locked field schema (from the Task 4 test, non-negotiable)
```jsonc
{ "t": "2026-06-03T12:00:00.000Z", "level": "info", "msg": "hello", "k": 1 }
```
The timestamp key is **`t`** (string ISO). `level` and `msg` are mandatory. Everything else is event/scope fields, merged flat (not nested).

---

## 2. The headline finding: **ship a thin custom logger, not pino (for v1)**

Design §5.2 leaves the choice open ("hand-rolled or `pino`"). The research resolves it decisively in favour of **hand-rolled** for v1.

### Why not pino on Bun
- **pino's killer features are its worker-thread transports** (`pino-pretty`, `pino/file`, `pino.transport`), and these are exactly the parts that are broken or fragile under Bun. As of Sept 2025, `bun` does not work with `pino-pretty` ("unable to determine transport target") — oven-sh/bun#23062. Pino's v7+ transport architecture spawns a `Worker` + `thread-stream` + `real-require`, all of which are bundler/runtime-sensitive and have repeatedly broken across non-Node runtimes (pinojs/pino#1889; getsentry/sentry-javascript#16723; Bun Worker constructor bug oven-sh/bun#3757). ([nearform pino@7](https://nearform.com/insights/pino7-0-0-pino-transport-worker-thread-transport/), [bun#23062](https://github.com/oven-sh/bun/issues/23062))
- **Pino's perf advantage is irrelevant here.** Pino's 115ms/10k-ops number ([Better Stack](https://betterstack.com/community/guides/scaling-nodejs/pino-vs-bunyan/)) matters for high-throughput APIs. Uxie is **single-owner, single-shard, a handful of interactions/day**. Logging is never the bottleneck. Buying a worker-thread dependency to win microseconds we will never spend is a bad trade.
- **Pino without transports collapses to "JSON to stdout"** — which is exactly what ~40 lines of TypeScript give us, with zero deps, zero Bun-runtime risk, and a redaction model we fully control.
- **Dependency budget is locked:** Plan Task 1 pins runtime deps to **discord.js + zod only**. Adding pino (and `thread-stream`, `pino-abstract-transport`, `sonic-boom`, `real-require`, `quick-format-unescaped`, `on-exit-leak-free`, `process-warning`, `safe-stable-stringify`, `atomic-sleep`) violates that budget and the stateless/minimal posture. **A custom logger keeps the dep count at two.**

### Why custom is genuinely *better* here, not just "good enough"
- **Redaction is leak-proof by construction.** Pino's `redact` option is path-based (`req.headers.authorization`) and silently misses keys you didn't enumerate. The spec's rule is *substring-on-key* (`*AUTH*`, `*SECRET*`, `*KEY*`, `*BOT_TOKEN*`) applied to **every** field — a default-deny posture that catches `SCRYPT_AUTH`, `MY_API_KEY`, `SOMETHING_SECRET` without a per-field allowlist. Implementing this as the single serialisation path means a secret physically cannot reach `console.log`.
- **Bun's `console.log` is already fast and synchronous-to-stdout**, which is what journald wants (one process, one ordered stream, no async flush-loss on crash). pino's async worker transport can *lose the last buffered lines on a hard crash* — the worst possible moment. A synchronous `console.log(JSON.stringify(x))` cannot.

> **Recommendation:** v1 = thin custom logger (~40 lines, the Plan Task 4 skeleton, hardened per §3). Revisit pino only if/when uxie ever needs sampling, log rotation off-journald, or an OTel exporter (v2+, and only if a transport ships that is Bun-stable).

---

## 3. Recommended logger API + field schema (concrete, implementable)

### 3.1 The module (`src/lib/log.ts`) — hardened beyond the Plan skeleton

The Plan Task 4 skeleton is correct but minimal. Harden it on four axes **without breaking the locked test**:

1. **Recursive redaction** (the Plan skeleton only redacts top-level keys). A nested object — e.g. logging a parsed config or a Scrypt request body — can smuggle `{ headers: { Authorization: "Bearer …" } }` past a top-level-only check. Walk objects/arrays.
2. **Cycle-safe stringify.** discord.js objects are deeply circular. If anyone ever logs an interaction or client object, naive `JSON.stringify` throws *inside the logger* — and the logger is below the error boundary, so it could take down the catch site. Use a small `seen` set.
3. **Truncation guard.** Cap any string field (and the final line) so a pasted wall of text or a huge Scrypt payload cannot blow a journald line. Cap individual string values at ~2 KB and the whole line at ~8 KB, appending `…[truncated N chars]`.
4. **Stable error serialisation.** Keep the Plan's `name: message\nstack` string (the test asserts `line.err` is a string containing `"root"`).

```ts
// src/lib/log.ts
type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;   // see §4: gated; off unless min level = debug
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(scope: Fields): Logger;
}

// --- redaction (Guidelines §17.2): default-deny on KEY substring ---
const REDACT = ["BOT_TOKEN", "AUTH", "SECRET", "KEY"] as const;
const shouldRedact = (key: string) => {
  const u = key.toUpperCase();
  return REDACT.some((s) => u.includes(s));
};

const MAX_STR = 2_000;
const MAX_LINE = 8_000;

const clip = (s: string) =>
  s.length > MAX_STR ? `${s.slice(0, MAX_STR)}…[truncated ${s.length - MAX_STR} chars]` : s;

// recursive, cycle-safe, redacting serializer — the ONLY path to stdout
function sanitize(v: unknown, seen = new WeakSet<object>()): unknown {
  if (v instanceof Error) return clip(`${v.name}: ${v.message}\n${v.stack ?? ""}`);
  if (typeof v === "string") return clip(v);
  if (v === null || typeof v !== "object") return v;
  if (seen.has(v as object)) return "[Circular]";
  seen.add(v as object);
  if (Array.isArray(v)) return v.map((x) => sanitize(x, seen));
  const out: Fields = {};
  for (const [k, val] of Object.entries(v as Fields)) {
    out[k] = shouldRedact(k) ? "[REDACTED]" : sanitize(val, seen);
  }
  return out;
}

function emit(level: Level, scope: Fields, msg: string, fields: Fields = {}) {
  const merged: Fields = { t: new Date().toISOString(), level, msg };
  for (const [k, v] of Object.entries(scope))
    merged[k] = shouldRedact(k) ? "[REDACTED]" : sanitize(v);
  for (const [k, v] of Object.entries(fields))
    merged[k] = shouldRedact(k) ? "[REDACTED]" : sanitize(v);
  let line = JSON.stringify(merged);
  if (line.length > MAX_LINE) line = JSON.stringify({ t: merged.t, level, msg, _truncated: true });
  console.log(line); // single sink; Task 4 test spies here
}

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(scope: Fields = {}, min: Level = "info"): Logger {
  const at = (level: Level, msg: string, fields?: Fields) => {
    if (LEVELS[level] >= LEVELS[min]) emit(level, scope, msg, fields);
  };
  return {
    debug: (m, f) => at("debug", m, f),
    info: (m, f) => at("info", m, f),
    warn: (m, f) => at("warn", m, f),
    error: (m, f) => at("error", m, f),
    child: (s) => createLogger({ ...scope, ...s }, min),
  };
}
```

**Compatibility with the locked test:** `level/msg/k/t` all present; `child` merges scope; `err` serialises to a string containing `"root"`; all four `*AUTH*/*SECRET*/*KEY*/*BOT_TOKEN*` keys → `"[REDACTED]"`; `safe` survives. The hardening (recursion, clip, cycle-guard, level gate) is additive and does not change any asserted shape. ✅

### 3.2 The uxie field schema (the contract for `journalctl | jq`)

Base keys on **every** line (auto-injected): `t`, `level`, `msg`.
Process-scoped (set once at boot via the root logger's `child`): `svc:"uxie"`, `ver:<package.json version>`, `env:<"dev"|"prod">`.
Per-interaction scope (injected by the router's `child`): `interactionId`, `cmd` (command name), `clientTag`.
Per-inbox scope: `msgId`, `clientTag` (`uxie-msg-<id>`), `kind:"inbox"`.
Event-specific: `event`, `durationMs`, `scryptStatus`, `httpStatus`, `errCode`, `err`.

> **`svc:"uxie"` is load-bearing for SUP.** Three apps share the journald stream; `svc` lets you `journalctl | jq 'select(.svc=="uxie")'`. Honour SUP §3's "one log surface" by tagging which tributary every line came from. (SUP §9.7)

### 3.3 Recommended `event` vocabulary (closed enum, greppable)

| `event` | level | where | extra fields |
|---|---|---|---|
| `boot.start` / `boot.ready` | info | index.ts | `ver`, `intents` |
| `cmd.start` | info | router (post owner-gate, post-defer) | `cmd`, `interactionId` |
| `cmd.ok` | info | router (after execute resolves) | `cmd`, `durationMs` |
| `cmd.fail` | warn/error | router catch | `cmd`, `errCode`, `err`, `durationMs` |
| `owner.deny` | warn | router/auth | `actorId` (the rejected user id only) |
| `inbox.capture` | info | message-router | `msgId`, `clientTag` |
| `inbox.ack` / `inbox.fail` | info / error | message-router catch | `msgId`, `errCode` |
| `scrypt.req` / `scrypt.res` | debug / info | rest+mcp clients (via passed child logger) | `op`, `httpStatus`, `durationMs`, `clientTag` |
| `process.fatal` | error | index.ts process.on | `err`, `kind` |

---

## 4. Levels, level config, and the `t`-vs-`ts` reconciliation

### 4.1 Reconcile the field-name drift — **`t` wins**
Guidelines §18 says the timestamp key is `ts`; the **Plan Task 4 test asserts `line.t`**. The test is executable truth and will fail CI if violated. **Use `t`.** Then **fix the doc**: update Guidelines §18 to say `t` (per SUP §13 "update the doc before writing contradicting code"). This is a one-word doc edit, not a code change. (Gap #1 resolved.)

### 4.2 `debug` level + `LOG_LEVEL` — recommend adding, but as a tiny, spec-aligned addition
- Baseline lists `debug|info|warn|error`; Design §5.2 + the test only exercise `info|warn|error`. There is **no `LOG_LEVEL` env var** today (gap #3) and env §17.1 lists a fixed 9-field schema.
- **Recommendation (v1, S):** add `debug` to the `Level` union and a level gate (shown in §3.1), defaulting to `info`. This is free and lets `scrypt.req`/wire-level logs exist without flooding prod.
- **Recommendation (v1.5, S):** add `LOG_LEVEL` to `lib/env.ts` (`z.enum(["debug","info","warn","error"]).default("info")`) and thread it into `createLogger(scope, env.LOG_LEVEL)` at boot. **This requires a doc bump to Guidelines §17.1** (env schema is locked) — so it is explicitly a deviation (see §6). Until then, default `info`; `dev` may hardcode `debug`.
- **Per-environment guidance:** dev → `debug` (see Scrypt wire traffic); prod → `info` (journald keeps everything anyway; noise is the cost). Never log note bodies even at `debug` (§5).

---

## 5. Log hygiene — what must NOT enter the stream (uxie-specific)

Uxie handles the owner's **private knowledge vault**. Even though it is single-user on a Tailscale mesh, the journald stream is shared across three apps and persists. Treat note content as sensitive.

- **Never log note bodies.** `/capture`, `/journal`, `#inbox` text, and `/search`/`/ask` result content must **not** be logged. Log *metadata only*: `clientTag`, char length, `kind`, `scryptStatus`. This is the difference between "one invocation is greppable" (Guidelines §18) and "the vault is in the logs."
  - Concretely: log `{ event:"inbox.capture", msgId, len: msg.content.length }` — **not** `msg.content`.
- **Never log query strings verbatim** for `/search`/`/ask`. A query can itself be private. Log `{ cmd:"search", qLen: q.length, results: n }`. (If debugging needs the query, that is a `debug`-level, dev-only decision — and still passes through `clip()`.)
- **Redaction is keyed on field NAME, not value** — so naming matters. The owner-gate denial logs **only** `actorId` (the rejected snowflake), never a token, per Guidelines §6/§17. Snowflakes are not secrets.
- **No PII beyond Discord snowflakes.** Owner id / channel id / message id are fine (they are already in Discord). Don't log usernames, display names, or message URLs that embed content.
- **Truncation is mandatory** (built into `clip()` / `MAX_LINE`) so a pasted wall of text can't blow a journald entry or DoS the log.
- **Redaction recurses** (gap #4 resolved in §3.1) so a secret nested inside a logged config/request object is still caught.

---

## 6. Correlation-id propagation (uxie → scrypt → para-raid)

The spec already has the right primitive: the deterministic **`client_tag`** (`uxie-<interactionId>` / `uxie-msg-<msgId>`). Treat it as the **correlation id** that stitches a single request across planes. This aligns with the industry pattern of an `X-Request-Id`/`X-Correlation-Id` generated at ingress and propagated through every hop ([Last9](https://last9.io/blog/correlation-id-vs-trace-id/), [kindatechnical](https://kindatechnical.com/microservices-architecture/correlation-ids-and-request-context-propagation.html)).

**Concrete propagation plan:**
1. **Generate once, at the Discord edge.** The router computes `clientTag = makeClientTag(i)` and puts it in the child logger scope (`log.child({ interactionId, cmd, clientTag })`). Every uxie line for that invocation now carries `interactionId` + `clientTag`. (Guidelines §18 "grep one invocation end-to-end" — satisfied.)
2. **Send it on the wire to Scrypt.** Add a header on **every** Scrypt call (REST + MCP), so Scrypt can log the *same* id:
   - REST `POST /api/ingest`: header `X-Correlation-Id: <clientTag>` alongside the existing `client_tag` in the body. (The body `client_tag` already does idempotency/dedup; the header does *tracing*. Don't conflate — but reuse the same value.)
   - MCP `POST /mcp`: same `X-Correlation-Id` header on the StreamableHTTP transport request (via the transport's `requestInit.headers`).
   - **This is purely additive and does not change uxie's stateless posture** — one header derived from data already in hand, no new state.
3. **Para-RAID is a v2 stub.** When the orchestrator slot lands, the same `X-Correlation-Id` flows uxie → para-raid `/v1/...`. For v1, document the header contract so scrypt/para-raid can adopt it; no uxie code beyond the header above.
4. **Result:** `journalctl -u scrypt -u uxie -u para-raid | jq 'select(.clientTag=="uxie-123")'` returns the full cross-plane trace of one request. This is the single biggest observability win available and costs ~3 lines.

> Caveat / open coordination: this requires Scrypt to echo `X-Correlation-Id` into *its* log lines. That is a Scrypt-side change, documented here as a cross-plane contract (SUP §10 "new cross-app endpoints require a doc update"). Uxie sending the header is safe regardless; the value is only realised once Scrypt reads it.

---

## 7. What to log at each catch site (and avoiding double-logging)

Three catch sites, three responsibilities. The rule that prevents double-logging: **each error is logged at exactly ONE site, by the site that handles it.**

### Site 1 — interaction-router boundary (`bot/interaction-router.ts`)
- On **success path**: `cmd.start` (info, after owner-gate + defer) and `cmd.ok` (info, with `durationMs`). These are the only "happy path" logs — keep them to two per invocation.
- On **catch**: log **once** here. Map the error:
  - `NotOwnerError` → `owner.deny` at **warn** (`actorId` only), ephemeral "not authorized". (Guidelines §6: "no logging beyond level warn with the rejected user id.")
  - `ScryptError` / known `UxieError` → `cmd.fail` at **warn**, fields `{ cmd, errCode: err.code, httpStatus }`, ephemeral mapped message. Known operational failures are warn, not error.
  - Unknown `Error` → `cmd.fail` at **error** with full `err` (serialised stack), ephemeral "something broke. logs have details." (Guidelines §14.2 error table.)
- **Clients/commands MUST NOT log the error themselves** (no try/catch in bodies — the anti-pattern). They `throw`; the boundary logs. This is the whole point of "exactly three catch sites" — it also guarantees no double-logging.

### Site 2 — message-router boundary (`bot/message-router.ts`)
- Success: `inbox.capture` (info) then ✅ react → `inbox.ack` (info).
- Catch: log **once** → `inbox.fail` (error, `{ msgId, errCode, err }`), react ❌. Fire-and-forget: do not chase the message (no edit/delete — matches the forbidden surface).

### Site 3 — `index.ts` top-level (`process.on`)
- `process.on('uncaughtException'|'unhandledRejection')` → log `process.fatal` (error, `{ kind, err }`) **then `process.exit(1)`**. Docker/systemd restarts (`restart: unless-stopped`). (Consistency report rows 4–5; Guidelines §14.2.)
- **v15 note:** under discord.js v15 `AsyncEventEmitter`, a rejected promise *inside a listener body* may surface as an `unhandledRejection` rather than being caught by the router's sync try/catch (api-surface §7 open-question 1). The `process.on('unhandledRejection')` site is the backstop. To avoid double-logging, the router's catch handles awaited errors; only truly-escaped rejections reach Site 3. Add a test simulating an escaped rejection (consistency report fix #3).

**Double-logging guard summary:** boundary logs map-and-handle; deeper code throws and stays silent; the process handler only fires for what escaped the two boundaries. One error → one line.

---

## 8. stdout-only + Docker + SUP aggregation

- **`console.log` → stdout** is the entire transport. No `Bun.write(Bun.stdout, …)` needed (it works but the Task 4 test pins `console.log`; keep it). Synchronous write = no lost lines on crash.
- **Docker `journald` driver** (Design §20.2) forwards container stdout to journald. Set it in `docker-compose.yml`:
  ```yaml
  uxie:
    logging:
      driver: journald
      options:
        tag: uxie        # journald CONTAINER_TAG → reinforces svc field
  ```
- **No log files, no rotation, no exporters** in v1 — journald owns retention (`SystemMaxUse`, etc., are host config; SUP §11 disk-full runbook prunes `/var/log`). Uxie must not write to disk (also keeps the stateless posture).
- **`svc:"uxie"` in the JSON + journald `tag`** give two independent ways to filter uxie out of the shared stream. Belt and suspenders for the "one log surface for the whole box" goal (SUP §3/§9.7).
- **Color/pretty-printing:** none in the process. JSON only. For local dev readability, pipe through `jq` *as a CLI consumer* (`bun run dev | jq`) — never as an in-process transport (the broken-on-Bun path). This keeps prod and dev byte-identical.

---

## 9. Prioritized recommendation table

| # | Recommendation | Priority | Effort | Conflicts spec? |
|---|---|---|---|---|
| R1 | Ship thin custom logger (not pino) — pino transports broken on Bun, perf irrelevant, dep budget = discord.js+zod only | v1 | S | No |
| R2 | Use `t` as the timestamp key; fix Guidelines §18 (`ts`→`t`) to match the locked test | v1 | S | No (resolves drift; doc edit) |
| R3 | Harden serializer: recursive redaction + cycle-safe + per-value/line truncation (additive; passes Task 4 test) | v1 | S | No |
| R4 | Inject base scope `svc:"uxie"`, `ver`, `env` at boot via root `child` (SUP multi-app stream filtering) | v1 | S | No |
| R5 | Add `debug` level + level gate, default `info` (lets `scrypt.req` exist without prod noise) | v1 | S | No (extends levels; test unaffected) |
| R6 | Adopt closed `event` vocabulary (§3.3) + log `cmd.start`/`cmd.ok`/`cmd.fail` in the router | v1 | M | No |
| R7 | Log metadata only — never note bodies / query text; log lengths + clientTag (vault hygiene) | v1 | S | No (reinforces §17) |
| R8 | One-error-one-line discipline: boundaries log+map, deeper code throws silently (no try/catch in bodies) | v1 | S | No (is the spec) |
| R9 | Send `X-Correlation-Id: <clientTag>` header on every Scrypt REST + MCP call (cross-plane trace) | v1 | S | No (additive; document as cross-plane contract) |
| R10 | `process.fatal` log + `exit(1)` in `index.ts` process handlers; test an escaped rejection | v1 | M | No (completes §14.2 third catch site) |
| R11 | Add `LOG_LEVEL` to `lib/env.ts` + thread into `createLogger` | v1.5 | S | **Yes** — env schema §17.1 is locked at 9 fields; adding requires a doc bump |
| R12 | OTel / structured exporter, sampling, off-journald rotation | v2 | L | No (explicit non-goal until needed) |
| R13 | Scrypt echoes `X-Correlation-Id` into its own logs (realises R9's value) | v1.5 | S | No (Scrypt-side; doc contract here) |

---

## 10. Conflicts with spec (honest list)

- **R11 (`LOG_LEVEL` env var)** — the env schema (Guidelines §17.1 / Design §5.2) is a locked 9-field list with no log config. Adding `LOG_LEVEL` deviates and **requires updating §17.1 first** (SUP §13). Mitigation: ship R5 (in-code default `info`, `dev` can hardcode `debug`) in v1 with **no** env change; defer the env field to v1.5 with the doc bump. Marked `conflictsWithSpec=true`.
- **Everything else is additive or a drift-fix.** R2 is a doc-vs-test reconciliation (the test is authoritative; the fix is a one-word doc edit, fully spec-aligned per SUP §13). R3/R4/R5/R9 extend the Task 4 skeleton without changing any asserted field shape — verified line-by-line against the locked test in §3.1.

> Explicitly **not** recommended (would breach locked decisions): pino with worker transports (Bun-broken + dep budget); any file/disk sink (stateless + plane); try/catch inside command bodies (three-catch-site rule); logging note/query content (vault hygiene); a second log sink or exporter in v1 (non-goal).

---

## 11. Open questions

1. **Will Scrypt echo `X-Correlation-Id`?** R9 only realises end-to-end tracing once Scrypt reads the header into its own log lines. Needs a Scrypt-side commitment (cross-plane contract, SUP §10). Until then uxie sending it is harmless but inert.
2. **`LOG_LEVEL` env field — approve the §17.1 doc bump for v1.5?** Or keep level purely in-code (env stays frozen)? Decision gates R11.
3. **`debug` in the `Level` union now or later?** R5 says now (free, test-safe). Confirm the team wants `debug` lines to exist at all given the "info/warn/error" wording in Design §5.2.
4. **Truncation caps (2 KB value / 8 KB line)** — right journald-friendly limits, or track journald's `LineMax` (default 48 KB) more loosely? Pick numbers before Task 4 implementation.
5. **Should `cmd.start`/`cmd.ok` be `info` or `debug`?** Two info lines per invocation is fine at single-user scale, but if the owner wants a quiet prod stream, demote happy-path to `debug` and keep only `cmd.fail` at warn/error.
6. **v15 AsyncEventEmitter rejection behaviour** (api-surface §7 Q1) — confirm in code that the router's `try/catch` catches awaited rejections and only truly-escaped ones hit Site 3, so the one-error-one-line guarantee holds.

---

## 12. Sources

**Project docs (source of truth):**
- `docs/superpowers/specs/2026-04-14-uxie-design.md` §5.2, §7.2, §20
- `docs/superpowers/plans/2026-04-14-uxie.md` Task 4 (lib/log.ts + test)
- `docs/UXIE-DISCORD-GUIDELINES.md` §6, §14.2, §17.1, §17.2, §18
- `docs/SUP-GUIDELINES.md` §3, §9.5/§9.7, §10, §11
- `docs/scrypt-integration-context.md` (client_tag idempotency, bearer transport)
- `docs/spec-consistency-report.md` rows 4–5 (process handlers; logger redaction)
- `docs/discordjs-api-surface.md` §7 open-question 1 (v15 AsyncEventEmitter rejections)

**External (best practice, 2025–2026):**
- pino@7 worker-thread transport architecture — https://nearform.com/insights/pino7-0-0-pino-transport-worker-thread-transport/
- Bun ✕ pino-pretty broken — https://github.com/oven-sh/bun/issues/23062
- Bun Worker constructor bug — https://github.com/oven-sh/bun/issues/3757
- pino v7 transport flush/loss issue — https://github.com/pinojs/pino/issues/1889
- Sentry ✕ pino worker transport — https://github.com/getsentry/sentry-javascript/issues/16723
- Pino vs Bunyan (perf benchmarks) — https://betterstack.com/community/guides/scaling-nodejs/pino-vs-bunyan/
- Pino vs Winston — https://betterstack.com/community/guides/scaling-nodejs/pino-vs-winston/
- Node.js logging libraries 2025 — https://last9.io/blog/node-js-logging-libraries/
- Correlation ID vs Trace ID — https://last9.io/blog/correlation-id-vs-trace-id/
- Correlation IDs & request context propagation — https://kindatechnical.com/microservices-architecture/correlation-ids-and-request-context-propagation.html
- Correlation IDs in distributed systems — https://medium.com/engineering-excellence/correlation-ids-the-unrewarded-heroes-of-distributed-system-observability-40f564a0d7c7
