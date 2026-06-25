# scrypt

Integration with **Scrypt** (a notes/knowledge backend). Built by `buildScryptModule(env)`
(`index.ts`).

## Live today
- **`/ping`** — a Components-V2 health panel (`commands/ping.ts` + `ping/model.ts`): gateway latency,
  uptime, and Scrypt reachability. Buttons (`ping/handler.ts`, `ping:*`): Refresh / Retry /
  Auto-retry / Details, plus an owner-only **Restart Scrypt** path when `ALLOW_SCRYPT_RESTART=1`.
- **Health probe** — `ScryptRestClient.health()` (`rest-client.ts`): a 500 ms `GET /api/daily_context`
  probe that degrades-don't-crash (returns `{ ok, reason }`, never throws), so `/ping` always renders.
- **Connectivity logging** — `health()` logs one `warn` on each up↔down flip (`scrypt connectivity
  lost` / `scrypt connectivity restored`), mirrored to the log channel. Repeat-down probes (e.g. the
  auto-retry loop) stay silent.

## Deferred — Scrypt integration v2 (rebuild against the new contract)
The capture/query surface (`/capture`, `/journal`, `/brief`, `/search`, `/ask`) and its clients (REST
`ingest()` / `getDailyContext()`, the MCP client) were **removed** (commit `e963939`) and are **not**
maintained — Scrypt's ingestion is being reworked. On the Scrypt side, `feat/ingestion-rework` has
merged (new ingest `router` + `kinds` + a `batch-ingest` MCP tool) and `feat/journal-rework` is still
in progress. **Do not re-wire against the old contract.** When the rework lands, rebuild targeting the
new `POST /api/ingest`, `/api/journal`, `/api/daily-context`, and the `batch-ingest` MCP tool.
Reference: `docs/research/scrypt-contract.md`.

The typed-error seam is intentionally kept for that rebuild: `ScryptError` (`src/lib/errors.ts`) + the
router's `scrypt error` branch (`src/bot/interaction-router.ts`).

> Note: the health probe still hits `/api/daily_context` (underscore), which predates the rework —
> revisit its path/endpoint as part of v2 (see the `ponytail:` note in `rest-client.ts`).

## Files
- `index.ts` — module factory (`buildScryptModule`)
- `commands/ping.ts` — `/ping` command (probe + render)
- `ping/model.ts` — pure probe → `StatusModel` mapping
- `ping/handler.ts` — `ping:*` button handlers (refresh/retry/auto-retry/details/restart)
- `rest-client.ts` — `ScryptRestClient` (health probe + connectivity tracking only)
