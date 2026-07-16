# scrypt

Integration with **Scrypt** (a notes/knowledge backend). Built by `buildScryptModule(env)`
(`index.ts`). Always on — `SCRYPT_SERVER_URL` + `SCRYPT_AUTH` are required env.

Contract source of truth: `docs/research/scrypt-contract.md` (verified against scrypt main).
**Plane rule (hard): uxie NEVER writes vault markdown directly — REST/MCP only.**

## Commands
- **`/ping`** — Components-V2 health panel (`commands/ping.ts` + `ping/model.ts`): gateway latency,
  uptime, and Scrypt reachability. Buttons (`ping/handler.ts`, `ping:*`): Refresh / Retry /
  Auto-retry / Details, plus an owner-only **Restart Scrypt** path when `ALLOW_SCRYPT_RESTART=1`.
- **`/capture <text>`** — files the text into the vault's unintegrated inbox
  (`projects/_inbox/other/<utc-stamp>-<slug>.md`) via the MCP `create_note` tool — the only write
  path that targets the `projects/` layout (`POST /api/ingest` routes to legacy folders and has no
  idempotency). Retry-safe: `client_tag` = deterministic interaction tag, deduped server-side.
- **`/journal <text>`** — appends an entry to today's (UTC) journal day file via
  `POST /api/journal/<date>/entries` (kind:journal was removed from `/api/ingest`).
- **`/search <query>`** — `GET /api/search/hybrid` (BM25 + embedding via RRF), rendered as a
  Components-V2 panel. Confidence-gated: unless the top hit was surfaced by BOTH rankers
  (`score > 1/61`, see `MIN_CONFIDENT_SCORE` in `commands/search.ts`), it answers
  "no confident match" and suggests `/raid` instead of showing junk.
- **`/brief`** — `GET /api/daily-context` (canonical hyphen path): journal presence, recent
  notes, open threads. Plain markdown, deliberately simple.

## Client (`rest-client.ts`)
- `health()` — 500 ms `GET /api/daily-context` probe that degrades-don't-crash (returns
  `{ ok, reason }`, never throws) so `/ping` always renders, with one-`warn`-per-flip
  connectivity logging (`scrypt connectivity lost` / `restored`).
- `createNote({ title, content, clientTag })` — MCP `create_note` over `POST ${base}/mcp`
  (JSON-RPC 2.0, stateless, bearer auth, double-parsed `result.content[0].text`).
- `journalEntry(body, clientTag)` / `hybridSearch(q, { limit, clientTag })` / `dailyContext(clientTag)`
  — REST, zod-parsed (`schemas.ts`), never cast.
- Timeouts: 500 ms health probe, 2.5 s search (`/search` replies un-deferred, so it must beat
  Discord's 3 s window), 5 s writes + `/brief` (para-raid client convention).
- Errors: typed `ScryptError` subclasses (`src/lib/errors.ts`) — timeout retryable, auth /
  bad-request not — funneled to the interaction-router's `scrypt error` branch.
- Message-sourced captures (future #inbox receiver) should pass `makeMessageClientTag(msg)`
  as the `clientTag`.

## Files
- `index.ts` — module factory (`buildScryptModule`)
- `commands/` — `ping.ts`, `capture.ts`, `journal.ts`, `search.ts`, `brief.ts`
- `ping/model.ts` — pure probe → `StatusModel` mapping; `ping/handler.ts` — `ping:*` buttons
- `rest-client.ts` — `ScryptRestClient` (health + capture/journal/search/daily-context)
- `schemas.ts` — zod schemas for the v2 contract responses
