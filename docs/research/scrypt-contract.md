# Scrypt Contract (authoritative)

> Single source of truth for uxie's writes (Scrypt REST) and reads (Scrypt MCP).
> Synthesized from REST source-file inspection (`/Users/admin/Desktop/Files/scrypt/src/server/...`)
> and MCP wire-protocol inspection (`/Users/admin/Desktop/Files/scrypt/src/server/mcp/...`).
> The build consumes this doc verbatim. Every response is zod-parsed, never cast.
>
> Conventions that apply everywhere:
> - Timeout: `AbortSignal.timeout(10000)` for all REST + MCP calls; `AbortSignal.timeout(500)` for the `/ping` REST health probe only.
> - Auth header: `Authorization: Bearer ${SCRYPT_AUTH}` (REST and MCP share the same token).
> - Correlation: send `X-Correlation-Id: <client_tag>` on every REST request. `client_tag` is deterministic: `uxie-<interaction.id>` for slash commands, `uxie-msg-<msg.id>` for #inbox. Same value is the log scope field.
> - Base URLs come from env: `SCRYPT_SERVER_URL` (REST), `SCRYPT_MCP_URL` (MCP). No hard-coded hosts.

---

## 1. REST endpoints (writes + read-only vault fetches)

Auth model for ALL REST endpoints: `Authorization: Bearer <SCRYPT_AUTH>`. Localhost callers
(`127.0.0.1`, `::1`, or `localhost` Host header) bypass auth entirely even in production;
remote callers MUST send the token. If no token is configured server-side, remote requests get `401`.
uxie always sends the token regardless.

### 1.1 POST /api/ingest — the only write path

- **Method / path**: `POST /api/ingest`
- **Auth**: Bearer (as above)
- **Request body** (`IngestRequest`):
  - `kind: Kind` — one of `thread | research_run | memory | spec | plan | note | log | thought | idea | journal`
  - `title: string` (min 1) — *ignored for `journal`*
  - `content: string` (min 1)
  - `frontmatter?: Record<string, unknown>` — *ignored for `journal`*
  - `replace?: boolean` — overwrite a conflicting file; *ignored for `journal`*
- **Per-kind rules**:
  - `journal`: appends an entry (`hh:mm` UTC heading + content) to `journal/YYYY-MM-DD.md`. Creates the file on first write of the day. Uses `content` ONLY — `title`, `frontmatter`, `replace` are ignored. Timestamp is **UTC server time**; there is **no `tz` field** (see BLOCKERS).
  - `research_run`: `frontmatter.thread` (string, required) must be an existing thread slug (validated against `notes/threads/{slug}.md`). Missing thread → `404` with `field: "frontmatter.thread"`.
  - all non-journal kinds: optional `frontmatter.domain` and `frontmatter.subdomain` are lowercase slugs matching `/^[a-z0-9][a-z0-9-]*$/`; when present they override the computed file path. Invalid slug → `400`.
- **Success (201)** (`IngestResult`): `{ path, kind, created, side_effects? }` where `side_effects?` = `{ thread_updated?: string, research_run_id?: number }`.
- **Errors**: `400` bad_request · `409` conflict (file exists, `replace` not set) · `404` not_found (thread missing) · `500` internal. Error body (`IngestError`): `{ error: string, field?: string }`.
- **Source**: `src/server/api/ingest.ts`, `src/server/ingest/router.ts`

### 1.2 GET /api/daily_context — drives /brief

- **Method / path**: `GET /api/daily_context`
- **Auth**: Bearer · **Request**: no body, no query params. Always returns context for **UTC today**.
- **Response** (`DailyContextResponse`): `{ generated_at, today: { date, journal }, recent_notes[], open_threads[], active_memories[], tag_cloud[], related }`.
  - `recent_notes`: non-journal notes modified in last 24h, sorted by `modified` desc, max 20; each has a `snippet` capped at 200 chars.
  - `open_threads`: status in `open|in-progress|blocked`, sorted by `priority` desc.
  - `active_memories`: notes under `memory/` with `active !== false`, sorted by `priority` desc.
  - `tag_cloud`: max 20.
  - `related`: `{ notes (max 5, last 7d, domain/tag match), memories (max 3, tag overlap), draft_prompts (max 3) }`.
- **Source**: `src/server/api/daily-context.ts`

### 1.3 GET /api/search — drives /search (REST fallback / link building)

- **Method / path**: `GET /api/search?q=<query>`
- **Auth**: Bearer · **Request**: query param `q` (string, optional → returns `[]` if empty).
- **Response**: `SearchResult[]` = `{ path, title, snippet, tags? }[]`. FTS5-backed.
- **Source**: `src/server/api/search.ts`

### 1.4 GET /api/notes — note listing (link building / web-UI)

- **Method / path**: `GET /api/notes?tag=<tag>&folder=<folder>&sort=<sort>`
- **Auth**: Bearer · **Request**: query params `tag?`, `folder?`, `sort?` (only `'modified'`).
- **Response**: `NoteMetadata[]` = `{ path, title, modified?, size }[]`.
- **Source**: `src/server/api/notes.ts`

### 1.5 GET /api/notes/:path — single note read

- **Method / path**: `GET /api/notes/*path` (path param is a vault-relative path)
- **Auth**: Bearer · **Request**: path param `path`; no body. `404` if not found.
- **Response** (`NoteDetail`): `{ path, title, content, frontmatter, backlinks[], incoming_edges[] }` where each edge = `{ source, target, tier: number, reason? }`.
- **Source**: `src/server/api/notes.ts`

### 1.6 Verbatim zod (REST) — copy into `src/scrypt/schemas.ts`

```ts
import { z } from 'zod';

// === INGEST REQUEST & RESPONSE ===

export const Kind = z.enum([
  'thread',
  'research_run',
  'memory',
  'spec',
  'plan',
  'note',
  'log',
  'thought',
  'idea',
  'journal',
]);

export type Kind = z.infer<typeof Kind>;

export const IngestRequest = z.object({
  kind: Kind,
  title: z.string().min(1, 'title is required'),
  content: z.string().min(1, 'content is required'),
  frontmatter: z.record(z.unknown()).optional(),
  replace: z.boolean().optional(),
});

export type IngestRequest = z.infer<typeof IngestRequest>;

export const IngestResult = z.object({
  path: z.string(),
  kind: Kind,
  created: z.boolean(),
  side_effects: z.object({
    thread_updated: z.string().optional(),
    research_run_id: z.number().optional(),
  }).optional(),
});

export type IngestResult = z.infer<typeof IngestResult>;

// Note: Journal ingest does NOT accept a tz field. The server uses UTC server time.
// For research_run, frontmatter.thread must be a valid thread slug.
// For domain/subdomain paths, validate with regex: /^[a-z0-9][a-z0-9-]*$/

// === DAILY_CONTEXT RESPONSE ===

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

export const Tag = z.object({
  tag: z.string(),
  count: z.number(),
});

export const RelatedNote = z.object({
  path: z.string(),
  title: z.string(),
  modified: z.string().datetime(),
});

export const RelatedMemory = z.object({
  path: z.string(),
  title: z.string(),
});

export const DraftPrompt = z.object({
  path: z.string(),
  title: z.string(),
  created: z.string().datetime().nullable(),
});

export const RelatedBundle = z.object({
  notes: z.array(RelatedNote),
  memories: z.array(RelatedMemory),
  draft_prompts: z.array(DraftPrompt),
});

export const JournalEntry = z.object({
  path: z.string(),
  content: z.string(),
  exists: z.boolean(),
});

export const DailyContextResponse = z.object({
  generated_at: z.string().datetime(),
  today: z.object({
    date: z.string(), // 'YYYY-MM-DD'
    journal: JournalEntry,
  }),
  recent_notes: z.array(DailyNote),
  open_threads: z.array(OpenThread),
  active_memories: z.array(ActiveMemory),
  tag_cloud: z.array(Tag),
  related: RelatedBundle,
});

export type DailyContextResponse = z.infer<typeof DailyContextResponse>;

// === SEARCH RESPONSE ===

export const SearchResult = z.object({
  path: z.string(),
  title: z.string(),
  snippet: z.string(),
  tags: z.array(z.string()).optional(),
});

export type SearchResult = z.infer<typeof SearchResult>;

// === NOTES LIST RESPONSE ===

export const NoteMetadata = z.object({
  path: z.string(),
  title: z.string(),
  modified: z.string().datetime().optional(),
  size: z.number(),
});

export type NoteMetadata = z.infer<typeof NoteMetadata>;

// === NOTES GET RESPONSE ===

export const IncomingEdge = z.object({
  source: z.string(),
  target: z.string(),
  tier: z.number(),
  reason: z.string().optional(),
});

export const NoteDetail = z.object({
  path: z.string(),
  title: z.string(),
  content: z.string(),
  frontmatter: z.record(z.unknown()),
  backlinks: z.array(z.string()),
  incoming_edges: z.array(IncomingEdge),
});

export type NoteDetail = z.infer<typeof NoteDetail>;

// === ERROR RESPONSES ===

export const IngestError = z.object({
  error: z.string(),
  field: z.string().optional(),
});

export type IngestError = z.infer<typeof IngestError>;
```

> NOTE: REST `incoming_edges[].tier` is a **number** (`z.number()`). MCP edges use a **string** tier
> (`z.string()`). They are different shapes — do not share one schema between REST and MCP.

---

## 2. MCP wire protocol (reads)

- **Transport**: `POST ${SCRYPT_MCP_URL}` (e.g. `.../mcp`), JSON-RPC 2.0 over HTTP. Bearer-token authenticated. Request-scoped and **stateless** — the server tracks no session.
- **COLD `tools/call` VERDICT: WORKS.** No `initialize` handshake and no session header are required. A bare `tools/call` is accepted directly. `initialize` is *optional* (only for strict MCP-spec compliance) and uxie SKIPS it to stay one round-trip per call.
- **Required headers** (exactly two):
  - `Authorization: Bearer ${SCRYPT_AUTH}`
  - `Content-Type: application/json`
  - No `Accept` header needed — the server always returns `application/json`, never SSE.
  - uxie additionally sends `X-Correlation-Id: <client_tag>` for tracing (server ignores it; harmless).
- **Hand-rolled per-call recipe** (one POST per read, no handshake):
  1. `POST ${SCRYPT_MCP_URL}` with the two required headers + `AbortSignal.timeout(10000)`.
  2. Body:
     ```json
     {
       "jsonrpc": "2.0",
       "id": 1,
       "method": "tools/call",
       "params": {
         "name": "search_notes | semantic_search | get_note",
         "arguments": { /* tool-specific input object */ }
       }
     }
     ```
  3. Response envelope: `{ jsonrpc: "2.0", id, result?, error? }`.
     - On `error` present → throw / log a Scrypt error; `error = { code: number, message: string }`.
  4. **DOUBLE-PARSE**: the tool payload is at `result.content[0].text`, which is a **stringified JSON**. `JSON.parse` it once to get the actual tool-result object, THEN zod-parse that object with the matching schema below.
- **Source**: `src/server/mcp/tools/*.ts`

### 2.1 Response-envelope parsing helper (shape to build)

```ts
import { z } from 'zod';

// JSON-RPC envelope (parse first; never cast)
const McpEnvelope = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string(), z.null()]),
  result: z.object({
    content: z.array(z.object({ type: z.string(), text: z.string() })).min(1),
  }).optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

// Step 1: McpEnvelope.parse(await res.json())
// Step 2: if (env.error) -> throw scrypt error
// Step 3: const inner = JSON.parse(env.result.content[0].text)
// Step 4: <ToolResult>.parse(inner)
```

### 2.2 The three read tools

#### search_notes
- **Input**: `{ query: string; limit?: number; tag?: string; folder?: string; project?: string; doc_type?: string; thread?: string }`
- **Source**: `src/server/mcp/tools/search-notes.ts`

#### semantic_search
- **Input**: `{ query: string; limit?: number; folder?: string; min_score?: number; project?: string; doc_type?: string; thread?: string }`
- **Source**: `src/server/mcp/tools/semantic-search.ts`

#### get_note
- **Input**: `{ path: string }`
- **Source**: `src/server/mcp/tools/get-note.ts`

### 2.3 Verbatim zod (MCP read-tool results)

```ts
import { z } from 'zod';

// search_notes result
export const SearchNotesResult = z.object({
  results: z.array(
    z.object({
      path: z.string(),
      title: z.string(),
      snippet: z.string(),
      score: z.number(),
      project: z.string().nullable(),
      doc_type: z.string().nullable(),
      thread: z.string().nullable(),
    })
  ),
});

// semantic_search result
export const SemanticSearchResult = z.object({
  results: z.array(
    z.object({
      path: z.string(),
      title: z.string(),
      score: z.number(),
      snippet: z.string(),
      chunk_id: z.string(),
      chunk_range: z.tuple([z.number(), z.number()]),
      project: z.string().nullable(),
      doc_type: z.string().nullable(),
      thread: z.string().nullable(),
    })
  ),
  model: z.string(),
});

// get_note result (sections & metadata are complex nested server types; keep loose)
export const GetNoteResult = z.object({
  path: z.string(),
  frontmatter: z.record(z.unknown()),
  body: z.string(),
  sections: z.array(z.unknown()),        // from SectionsRepo.listByNote()
  metadata: z.record(z.unknown()),       // ReturnType from MetadataRepo.get()
  outgoing_edges: z.array(
    z.object({
      source: z.string(),
      target: z.string(),
      tier: z.string(),                  // MCP tier is a STRING (REST tier is a number)
      reason: z.string().nullable(),
    })
  ),
  incoming_edges: z.array(
    z.object({
      source: z.string(),
      target: z.string(),
      tier: z.string(),
      reason: z.string().nullable(),
    })
  ),
});
```

> The MCP-findings sketch had two typos that are CORRECTED above: `target: string()` (missing `z.`)
> in `incoming_edges`, and the loosened `sections`/`metadata` use `z.array(z.unknown())` /
> `z.record(z.unknown())` instead of `z.any()` so the parse still fails closed on a non-array/non-object.

---

## 3. Note permalink scheme (web-UI links)

- A note's identity everywhere is its **vault-relative path** (e.g. `notes/inbox/my-note.md`,
  `journal/2026-06-03.md`). Both REST and MCP return this in a `path` field.
- Web-UI permalink construction is **NOT confirmed** by source inspection. The presumed scheme is:
  `${SCRYPT_SERVER_URL}/${path_without_.md}` (strip the trailing `.md`, join to base).
  This is uxie's best guess for `lib/embed.ts` permalinks and MUST be treated as a BLOCKER until
  confirmed against Scrypt's actual web router. Embeds should degrade gracefully (link or plain path).

---

## 4. BLOCKERS

1. **Journal tz unsupported (CONFIRMED).** `/api/ingest` for `kind: journal` ignores any tz hint and
   stamps entries with **UTC server time** (`hh:mm` UTC heading). There is no `tz` field on the
   request. uxie's `USER_TZ` / `lib/tz.ts` cannot influence the stored journal timestamp — it can only
   shape uxie's own reply text and `/brief` title. Decision needed: accept UTC-stamped journal entries,
   or prepend a local-time line into `content` before ingest. Recommend prepending local time into
   `content` so the vault entry carries the user's intended time.
2. **Permalink scheme unknown (CONFIRMED unknown).** The vault path is authoritative, but the web-UI
   URL mapping (`${BASE}/${path_without_.md}` vs some other route) is unverified. Confirm against
   Scrypt's web router before relying on clickable permalinks in embeds.
3. **`get_note` `sections` / `metadata` shapes are opaque.** They derive from `SectionsRepo.listByNote()`
   and `MetadataRepo.get()` and were not fully enumerated. Schemas are intentionally loose
   (`z.array(z.unknown())` / `z.record(z.unknown())`). If a future feature needs fields inside them,
   the exact server shapes must be captured first.
4. **REST vs MCP edge `tier` type mismatch.** REST `incoming_edges[].tier` is a **number**; MCP
   `incoming_edges[]/outgoing_edges[].tier` is a **string**. Not a blocker for building, but do NOT
   reuse one edge schema across the two transports — keep `IncomingEdge` (REST, number) and the MCP
   edge object (string) separate.
5. **Auth-not-configured returns 401 for remote.** If Scrypt has no token configured, every remote
   uxie call gets `401`. Boot-time env (`SCRYPT_AUTH`) must be present; a misconfigured Scrypt side is
   indistinguishable from a bad uxie token at the 401 level — surface 401 distinctly in error replies.
