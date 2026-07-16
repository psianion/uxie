# Scrypt Contract (authoritative)

> Single source of truth for uxie's writes (Scrypt REST) and reads (Scrypt MCP).
> **Reflects scrypt as of `feat/journal-rework-v2` (2026-07-16), pending merge.**
> Synthesized from source inspection of the scrypt worktree (`src/server/...`).
> The build consumes this doc verbatim. Every response is zod-parsed, never cast.
>
> Conventions that apply everywhere:
> - Timeout: `AbortSignal.timeout(10000)` for all REST + MCP calls; `AbortSignal.timeout(500)` for the `/ping` REST health probe only.
> - Auth header: `Authorization: Bearer ${SCRYPT_AUTH}` (REST and MCP share the same token).
> - Correlation: send `X-Correlation-Id: <client_tag>` on every REST request. `client_tag` is deterministic: `uxie-<interaction.id>` for slash commands, `uxie-msg-<msg.id>` for #inbox. Same value is the log scope field.
> - Base URLs come from env: `SCRYPT_SERVER_URL` (REST), `SCRYPT_MCP_URL` (MCP). No hard-coded hosts.

---

## 0. Auth model (all REST + MCP + /ws)

Source: `src/server/auth.ts`.

- The gate covers `/api/*`, `/ws`, and `/mcp` (same loopback-or-token rule). The static SPA shell is public.
- **Loopback trust is by the real TCP socket peer address** (`server.requestIP()`): `127.0.0.1`, `::1`, `::ffff:127.0.0.1`, `127.*`. A `Host: localhost` header does NOT bypass auth anymore — this applies in production too. No peer info → fail closed.
- Everything non-loopback needs `Authorization: Bearer <SCRYPT_AUTH_TOKEN>`.
- If the server has **no token configured**, every remote request gets `401` (reason `no_token_configured` internally; the wire response is identical).
- `401` responses are **empty-body, no `WWW-Authenticate` header**. A misconfigured scrypt (no token) is indistinguishable from a bad uxie token at the 401 level — uxie surfaces 401 distinctly in error replies and requires `SCRYPT_AUTH` at boot.
- uxie always sends the token regardless of where it runs.

---

## 1. REST endpoints (writes + read-only vault fetches)

### 1.1 POST /api/ingest — kind-routed write path

- **Method / path**: `POST /api/ingest`
- **Request body** (`IngestRequest`):
  - `kind: Kind` — one of `thread | research_run | memory | spec | plan | note | log | thought | idea`. **`journal` is GONE** — journal writes go through `/api/journal/*` (§1.2).
  - `title: string` (min 1)
  - `content: string` (min 1)
  - `frontmatter?: Record<string, unknown>` — server strips `created`/`modified`/`source` and stamps `title`, `kind`, `source: "claude"`.
  - `replace?: boolean` — overwrite a conflicting file (default false).
- **Destination routing** (`src/server/ingest/kinds.ts` `destinationFor`; dates UTC):
  - `frontmatter.domain` (+ optional `subdomain`), lowercase slugs `/^[a-z0-9][a-z0-9-]*$/`, override the path: `<domain>/<subdomain>/<slug>.md`. Not applied to `research_run`.
  - Else by kind: `thread → notes/threads/<slug>.md` · `research_run → notes/research/<YYYY-MM-DD-HHMM>-<slug>.md` · `memory → memory/<slug>.md` · `spec → docs/specs/<YYYY-MM-DD>-<slug>.md` · `plan → docs/plans/<YYYY-MM-DD>-<slug>.md` · `note → notes/inbox/<slug>.md` · `log → notes/logs/<YYYY-MM-DD>-<slug>.md` · `thought → notes/thoughts/<YYYY-MM-DD-HHMM>-<slug>.md` · `idea → notes/ideas/<slug>.md`.
- **Per-kind rules**:
  - `research_run`: `frontmatter.thread` (string, required) must be an existing thread slug (validated against `notes/threads/{slug}.md` BEFORE any write). Missing/unknown thread → **`400`** with `field: "frontmatter.thread"` (was 404 in the old contract — it is `bad_request` now).
- **Idempotency**: this route has NO `client_tag` dedup. A retry that hits an existing path returns `409` unless `replace: true`. Treat `409` on retry as success-already-happened only if uxie wrote that exact path this interaction.
- **Success (201)** (`IngestResult`): `{ path, kind, created, side_effects? }` where `side_effects?` = `{ thread_updated?: string, research_run_id?: number }`.
- **Errors**: `400` bad_request (incl. unknown thread) · `409` conflict · `500` internal. Error body: `{ error: string, field?: string }`.
- **Captures / inbox convention**: the canonical vault layout is `projects/<project>/<doc_type>/<slug>.md`, with **`projects/_inbox/` as the reserved project for unintegrated captures**. That layout is written via the MCP `create_note` tool (`{ path, content, client_tag }` — idempotent by `client_tag`, replays within 24 h return the cached response), e.g. `projects/_inbox/other/<slug>.md`. Use MCP `create_note` for captures uxie wants filed into the projects layout; use `POST /api/ingest` for the legacy kind folders.
- **Source**: `src/server/api/ingest.ts`, `src/server/ingest/router.ts`, `src/server/ingest/kinds.ts`, `src/server/vocab/reserved-projects.ts`

### 1.2 /api/journal/* — replaces kind:journal (drives journal append + /brief detail)

One file per **UTC day** at `journal/<YYYY-MM-DD>.md`; each entry is a `## <UTC ISO timestamp>` heading + markdown body. The entry **id IS its exact UTC ISO timestamp** (e.g. `2026-07-16T09:30:00.000Z`), stamped server-side at write time. `:date` must be strict `YYYY-MM-DD` or the route returns `400 { "error": "invalid date" }`.

Every route returns the same **day bundle** (`JournalDayBundle`):

```json
{
  "date": "2026-07-16",
  "entries": [ { "id": "2026-07-16T09:30:00.000Z", "displayTime": "9:30 AM", "body": "..." } ],
  "tasks_due": [ /* Task rows due this date, ANY status */ ],
  "related": [ { "path": "projects/scrypt/plan/x.md", "title": "x", "score": 0.62 } ]
}
```

- A day with no file returns an **empty bundle, not 404**.
- `related` is embedding-based (nearest non-journal notes, max 5); `[]` when the embedder is down.

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/journal/today` | — | Bundle for UTC today |
| GET | `/api/journal/:date` | — | Bundle for that day |
| GET | `/api/journal/:date/tasks` | — | `Task[]` due that day, any status |
| GET | `/api/journal/calendar?from=&to=` | — | `[{ date, count }]` — days with journal files, inclusive range filter |
| POST | `/api/journal/:date/entries` | `{ "body": string }` | Append; server stamps UTC ISO id; returns bundle |
| PATCH | `/api/journal/:date/entries/:id` | `{ "body": string }` | Replace entry body; unknown `:id` is a no-op; returns bundle |
| DELETE | `/api/journal/:date/entries/:id` | — | Remove entry; returns bundle |

POST/PATCH with empty `body` → `400 { "error": "body required" }`.

**uxie journal append recipe**: `POST /api/journal/<utc-today>/entries` with `{ body }`. The stored timestamp is the server's UTC instant — render it in `USER_TZ` client-side from the returned entry `id`.

- **Source**: `src/server/api/journal.ts`, `src/server/journal/doc.ts`, `src/server/journal/related.ts`

### 1.3 GET /api/daily-context — drives /brief

- **Canonical path**: `GET /api/daily-context` (hyphen). **`GET /api/daily_context` (underscore) is a permanent alias** — same handler; uxie's deployed health probe keeps working. New code should use the hyphen.
- No body, no query params. Always UTC today.
- **Response** (`DailyContextResponse`): `{ generated_at, today: { date, journal }, recent_notes[], open_threads[], active_memories[], tag_cloud[] }`.
  - `recent_notes`: non-journal notes modified in last 24 h, sorted `modified` desc, max 20; `snippet` capped at 200 chars.
  - `open_threads`: status in `open|in-progress|blocked`, sorted priority desc then oldest `last_run`.
  - `active_memories`: `memory/` notes with `active !== false`, sorted priority desc.
  - `tag_cloud`: max 20.
  - **The `related` bundle is REMOVED** from this response (it moved to the journal day bundle, §1.2). Drop `RelatedBundle` from the zod schema.
- **Source**: `src/server/api/daily-context.ts`

### 1.4 GET /api/search/hybrid — the cheap-search surface for /search

- **Method / path**: `GET /api/search/hybrid?q=<query>&limit=<n>`
- `q` required (empty → `{ query, hits: [] }`); `limit` default 8, clamped 1–25.
- BM25 (FTS5) + embedding cosine fused via Reciprocal Rank Fusion (k=60); degrades to FTS-only when the embedder is unavailable.
- **Response** (`HybridSearchResponse`):

```json
{
  "query": "vault sync",
  "hits": [
    {
      "path": "projects/scrypt/spec/vault-sync-design.md",
      "title": "Vault Sync Design",
      "project": "scrypt",
      "doc_type": "spec",
      "description": "one-liner or null",
      "excerpt": "first ~200 chars of indexed body",
      "score": 0.0325,
      "fts_rank": 1,
      "sem_rank": 2
    }
  ]
}
```

- **`score` semantics (use for confidence gating)**: RRF sum where each ranker contributes `1/(60 + rank)`. Ceiling ≈ `2/61 ≈ 0.0328` (rank 1 in both); a single-ranker hit tops out at `1/61 ≈ 0.0164`. Gate: `score > 0.0164` ⇒ both rankers surfaced the note (high confidence); equivalently check `fts_rank !== null && sem_rank !== null`. `fts_rank`/`sem_rank` are 1-based, `null` when that ranker missed.
- `excerpt` is a body prefix, NOT a match-window snippet — don't bold-match against it.
- The old `GET /api/search?q=` (plain FTS5 `SearchResult[]`) still exists as a fallback.
- **Source**: `src/server/api/search.ts`, `src/server/graph/hybrid-search.ts`

### 1.5 GET /api/schema — vault conventions doc

- Returns the vault-root `SCHEMA.md` (layout, doc_types, edge vocabulary, workflows) as raw markdown, `content-type: text/markdown; charset=utf-8`. `404 { "error": "SCHEMA.md not found at vault root" }` if absent.
- The same document is served as the MCP `instructions` field on `initialize` — uxie can fetch it once at boot to ground vault-touching prompts.
- **Source**: `src/server/schema-doc.ts`

### 1.6 GET /api/notes and GET /api/notes/*path — unchanged surfaces

- `GET /api/notes?tag=&folder=&sort=` → `NoteMetadata[]`.
- `GET /api/notes/*path` → `NoteDetail` incl. `backlinks[]` and `incoming_edges[]`. **Edge `tier` is now a STRING enum** `"connected" | "mentions" | "semantically_related"` (same as MCP) — the old REST-number/MCP-string mismatch is gone; one edge schema can be shared.
- **Source**: `src/server/api/notes.ts`, `src/shared/types.ts` (`parseTier`, `NoteIncomingEdge`)

### 1.7 Verbatim zod (REST) — copy into `src/scrypt/schemas.ts`

```ts
import { z } from 'zod';

// === INGEST ===

export const Kind = z.enum([
  'thread', 'research_run', 'memory', 'spec', 'plan',
  'note', 'log', 'thought', 'idea',
]); // NO 'journal' — journal writes use /api/journal/*

export type Kind = z.infer<typeof Kind>;

export const IngestRequest = z.object({
  kind: Kind,
  title: z.string().min(1, 'title is required'),
  content: z.string().min(1, 'content is required'),
  frontmatter: z.record(z.unknown()).optional(),
  replace: z.boolean().optional(),
});

export const IngestResult = z.object({
  path: z.string(),
  kind: Kind,
  created: z.boolean(),
  side_effects: z.object({
    thread_updated: z.string().optional(),
    research_run_id: z.number().optional(),
  }).optional(),
});

export const IngestError = z.object({
  error: z.string(),
  field: z.string().optional(),
});

// === JOURNAL ===

export const JournalEntryItem = z.object({
  id: z.string(),           // exact UTC ISO timestamp; also the ## heading
  displayTime: z.string(),  // 12h render of id, e.g. "3:00 PM"
  body: z.string(),
});

export const JournalTask = z.object({
  id: z.number(),
  note_path: z.string().nullable(),
  title: z.string(),
  type: z.string(),
  status: z.string(),
  due_date: z.string().nullable(),
  priority: z.number(),
  metadata: z.record(z.unknown()).nullable(),
  client_tag: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

export const JournalRelated = z.object({
  path: z.string(),
  title: z.string(),
  score: z.number(),
});

export const JournalDayBundle = z.object({
  date: z.string(), // 'YYYY-MM-DD'
  entries: z.array(JournalEntryItem),
  tasks_due: z.array(JournalTask),
  related: z.array(JournalRelated),
});

export const JournalCalendar = z.array(
  z.object({ date: z.string(), count: z.number() })
);

// === DAILY-CONTEXT ===

export const DailyNote = z.object({
  path: z.string(),
  title: z.string(),
  modified: z.string().datetime(),
  tags: z.array(z.string()),
  snippet: z.string(),
});

export const OpenThread = z.object({
  slug: z.string(),
  title: z.string(),
  status: z.enum(['open', 'in-progress', 'blocked']),
  priority: z.number(),
  last_run: z.string().datetime().nullable(),
  prompt: z.string().nullable(),
  path: z.string(),
});

export const ActiveMemory = z.object({
  slug: z.string(),
  title: z.string(),
  category: z.string(),
  priority: z.number(),
  content: z.string(),
});

export const Tag = z.object({ tag: z.string(), count: z.number() });

export const TodayJournal = z.object({
  path: z.string(),
  content: z.string(),
  exists: z.boolean(),
});

export const DailyContextResponse = z.object({
  generated_at: z.string().datetime(),
  today: z.object({
    date: z.string(), // 'YYYY-MM-DD'
    journal: TodayJournal,
  }),
  recent_notes: z.array(DailyNote),
  open_threads: z.array(OpenThread),
  active_memories: z.array(ActiveMemory),
  tag_cloud: z.array(Tag),
  // NOTE: no `related` field anymore — moved to JournalDayBundle.related
});

// === HYBRID SEARCH ===

export const HybridHit = z.object({
  path: z.string(),
  title: z.string(),
  project: z.string().nullable(),
  doc_type: z.string().nullable(),
  description: z.string().nullable(),
  excerpt: z.string(),
  score: z.number(),          // RRF; > 1/61 ≈ 0.0164 ⇒ both rankers agree
  fts_rank: z.number().nullable(),
  sem_rank: z.number().nullable(),
});

export const HybridSearchResponse = z.object({
  query: z.string(),
  hits: z.array(HybridHit),
});

// === EDGES (shared REST + MCP — tier is a string on both now) ===

export const Tier = z.enum(['connected', 'mentions', 'semantically_related']);

export const Edge = z.object({
  source: z.string(),
  target: z.string(),
  tier: Tier,
  reason: z.string().nullable(),
});
```

---

## 2. MCP wire protocol (reads) — UNCHANGED

The read recipe is unchanged from the previous contract version:

- **Transport**: `POST ${SCRYPT_MCP_URL}`, JSON-RPC 2.0 over HTTP. Bearer-token authenticated (loopback-or-token rule, §0). Stateless.
- **COLD `tools/call` WORKS** — no `initialize` handshake or session header required. (`initialize` now returns the vault `SCHEMA.md` in `instructions` if you do call it.)
- **Required headers**: `Authorization: Bearer ${SCRYPT_AUTH}` + `Content-Type: application/json`. No `Accept` needed; responses are always `application/json`, never SSE.
- **DOUBLE-PARSE**: the tool payload is at `result.content[0].text` (stringified JSON) — `JSON.parse` it, then zod-parse.

```ts
const McpEnvelope = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string(), z.null()]),
  result: z.object({
    content: z.array(z.object({ type: z.string(), text: z.string() })).min(1),
  }).optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
```

### 2.1 The three read tools (inputs unchanged)

- `search_notes` — `{ query; limit?; tag?; folder?; project?; doc_type?; thread? }`
- `semantic_search` — `{ query; limit?; folder?; min_score?; project?; doc_type?; thread? }`. Journal files carry `doc_type: "journal"`, so `doc_type` can include/exclude journal hits.
- `get_note` — `{ path: string }`

### 2.2 get_note result — `sections`/`metadata` shapes now pinned

The formerly-opaque shapes are enumerable from `src/server/indexer/sections-repo.ts` and `metadata-repo.ts`:

```ts
export const NoteSection = z.object({
  id: z.string(),
  note_path: z.string(),
  heading_slug: z.string(),
  heading_text: z.string(),
  level: z.number(),
  summary: z.string().nullable(),
  start_line: z.number(),
  end_line: z.number(),
});

export const NoteMetadataBlock = z.object({
  note_path: z.string(),
  description: z.string().nullable(),
  entities: z.array(z.string()).nullable(),
  themes: z.array(z.string()).nullable(),
  doc_type: z.string().nullable(),
  summary: z.string().nullable(),
  updated_at: z.number(),
}).nullable(); // null when the note has no metadata row

export const GetNoteResult = z.object({
  path: z.string(),
  frontmatter: z.record(z.unknown()),
  body: z.string(),
  sections: z.array(NoteSection),
  metadata: NoteMetadataBlock,
  outgoing_edges: z.array(Edge), // Edge from §1.7 — tier is a string
  incoming_edges: z.array(Edge),
});
```

### 2.3 MCP write path for captures

`create_note` (`{ path, content, client_tag }`) is the idempotent write tool: replays of the same `(tool, client_tag)` within 24 h return the cached response. It enforces `projects/<project>/<doc_type>/<slug>.md`; `projects/_inbox/<doc_type>/<slug>.md` is the capture convention (`_inbox` is a reserved project). Frontmatter `project`/`doc_type` must match the path.

---

## 3. Note permalink scheme (web-UI links) — CONFIRMED

The SPA router (`src/client/App.tsx`) mounts the editor at `/note/*` and internal navigation uses `navigate(\`/note/${path}\`)` with the full vault-relative path **including `.md`**:

```
${SCRYPT_SERVER_URL}/note/<vault-relative-path>
e.g. ${SCRYPT_SERVER_URL}/note/projects/scrypt/spec/vault-sync-design.md
```

The journal view is `${SCRYPT_SERVER_URL}/journal` (day selection is in-app, not a URL param). Embeds may link `/note/journal/<YYYY-MM-DD>.md` for a specific day file.

---

## 4. BLOCKERS — resolutions (verified against feat/journal-rework-v2 code)

1. **Journal tz — RESOLVED.** `kind: journal` no longer exists; journal writes go through `POST /api/journal/:date/entries`. The server stamps each entry with a **full UTC ISO timestamp** (`nowIso()`), which is both the entry's `##` heading and its stable `id`. Still no client tz input, but the stored value is now an unambiguous instant — uxie renders it in `USER_TZ` from the returned `id` instead of prepending a local-time line into `content`. (`src/server/api/journal.ts`, `src/shared/date.ts`)
2. **Permalink scheme — RESOLVED.** `${SCRYPT_SERVER_URL}/note/<vault-path>` (path includes `.md`), confirmed against the SPA router (§3). Clickable permalinks in embeds are safe.
3. **`get_note` `sections`/`metadata` shapes — RESOLVED.** Enumerated in §2.2 from `SectionsRepo.listByNote()` / `MetadataRepo.get()`; replace the loose `z.array(z.unknown())` / `z.record(z.unknown())` schemas with `NoteSection[]` / `NoteMetadataBlock`.
4. **REST vs MCP edge `tier` type mismatch — RESOLVED.** REST `incoming_edges[].tier` is now a string enum (`"connected" | "mentions" | "semantically_related"` via `parseTier`), identical to MCP. One shared `Edge` schema (§1.7).
5. **Auth-not-configured returns 401 for remote — REMAINS (by design, per S7).** Confirmed unchanged in `src/server/auth.ts`: remote callers without a valid Bearer get an empty-body `401`, including when the server simply has no token configured. New in this branch: the loopback bypass is keyed on the real socket peer, so `Host: localhost` spoofing is closed, and `/ws` is behind the same gate. Operational requirement stands: `SCRYPT_AUTH` must be present at uxie boot and 401s must be surfaced distinctly.
