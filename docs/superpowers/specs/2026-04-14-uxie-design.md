# Uxie Discord Bot — v1 Design Spec

**Date:** 2026-04-14
**Last revised:** 2026-04-27
**Status:** v1.1 — aligned with SUP/UXIE/discord.js spec layer 2026-04-26
**Scope:** v1 — single-user Discord bot with one active module (`scrypt`), running on Docker Desktop for development. Production deployment (Oracle / AWS) deferred.

## 1. Purpose

Uxie is the user's unified Discord front-end for their personal applications. It is a single long-lived Bun process hosting one or more **modules**, where each module is an outward-facing adapter that talks to a dedicated backend service (possibly on a different host). Modules are first-class but there is no central registry abstraction in v1.

**v1 ships with exactly one module: `scrypt`**, a thin wrapper over the Scrypt Wave 8 MCP surface (12 tools, bearer auth, streamable-http) plus two REST endpoints (`/api/daily_context`, `/api/ingest`). Future modules (para-raid, others) slot in as sibling folders under `src/integrations/`.

The bot's role is to let the user capture, query, and review Scrypt vault content from Discord mobile without needing a terminal. It intentionally owns no persistent state of its own — Scrypt (and later backends) are authoritative.

## 2. Non-Goals

The following are explicitly out of scope for v1 and must not creep back during implementation:

- Tier 2 commands: `/threads`, `/state`, `/link`, `#notifications` WebSocket bridge.
- Tier 3 orchestrator-dependent features: LLM-summarised `/brief`, `/enrich`, gateway-channel intent classification. A dead-code seam (`orchestrator-stub.ts`) exists so para-raid can plug in later without schema changes.
- Voice (`@discordjs/voice`). Blocked under Bun and not needed.
- Scheduled/cron push. `/brief` is manual-only.
- Pagination, message-edit workflows, reaction menus beyond the `#inbox` ✅/❌ ack.
- Multi-user, roles, permission tiers beyond a single-owner allowlist.
- Second integration module. `para-raid` is a documented v2 slot.
- Production deployment. v1 runs only on Docker Desktop; prod is a later config change via `SCRYPT_SERVER_URL` / `SCRYPT_MCP_URL`.
- Local idempotency or queue state. Scrypt writes are idempotent server-side via `client_tag`.

## 3. Architecture

### 3.1 High-level layout

```
                  ┌──────────────────────────────┐
                  │   L1: You (Discord client)   │
                  └──────────────┬───────────────┘
                                 │ slash / DM / channel msg
                  ┌──────────────▼───────────────┐
                  │   L2: uxie (single Bun proc) │
                  │   dev = Docker Desktop       │
                  │                              │
                  │  ┌────────────────────────┐  │
                  │  │  bot/ shell            │  │
                  │  │  discord.js v14        │  │
                  │  └──────────┬─────────────┘  │
                  │  ┌──────────▼─────────────┐  │
                  │  │  integrations/ (slots) │  │
                  │  │   scrypt  (v1)         │  │
                  │  │   para-raid (v2)       │  │
                  │  │   <future> (v3+)       │  │
                  │  └───────────┬────────────┘  │
                  │  ┌───────────▼────────────┐  │
                  │  │  lib/ (shared)         │  │
                  │  └────────────────────────┘  │
                  └───────┬───────┬──────────┬───┘
                          │       │          │
                          ▼       ▼          ▼
          ┌──────────────┐  ┌─────────┐  ┌─────────┐
          │  scrypt      │  │ para-   │  │ future  │
          │  (host A)    │  │ raid    │  │ app     │
          │  MCP + REST  │  │ (host B)│  │ (host C)│
          └──────────────┘  └─────────┘  └─────────┘
```

### 3.2 Key properties

- **uxie is the long-lived bot process.** Modules are folders inside it, not separate services. One Discord connection, one command tree, one logger.
- **Modules are outward-facing adapters.** Each module owns (a) its slash commands + event handlers, (b) its HTTP client(s) to its backend, (c) its own env namespace (`SCRYPT_*`, `PARARAID_*`, etc.). A module does not reach into another module's files.
- **Backends live anywhere.** Dev: scrypt is a sibling Docker container on a shared network, reached at `http://scrypt:3000`. Prod: Tailscale or public URL via the same env var. No code change between environments.
- **No registry abstraction yet.** "Module" is a folder convention and a naming discipline, not an `Integration` interface. When module #2 reveals real duplication, shared concerns move from `integrations/` into `core/`. Not before.
- **Backend failure is module-local.** Scrypt unreachable → scrypt commands fail cleanly with a user-facing message, other modules and `/ping` keep working.
- **Bun runtime.** Matches scrypt's stack. Built-in `.env` loading, `bun test`, zero-config TS/ESM. Voice stays out, so the known Bun/opus incompatibility does not apply.

### 3.3 Deployment shape (v1)

- `docker-compose.yml` brings up two containers on a shared bridge network: `uxie` and `scrypt`.
- `uxie` container: `FROM oven/bun:1-alpine`, copies `src/`, runs `bun run src/index.ts`.
- `uxie` reaches `scrypt` via container DNS (`http://scrypt:3000`).
- `SCRYPT_MCP_URL` and `SCRYPT_SERVER_URL` are env vars. Prod is a later config flip, not a code change.

## 4. File Layout

```
uxie/
├── src/
│   ├── index.ts                      # boot: load env, build client, register commands, login
│   │
│   ├── bot/
│   │   ├── client.ts                 # Client factory (intents, partials)
│   │   ├── command-loader.ts         # globs integrations/*/commands/*.ts into a Collection
│   │   ├── deploy-commands.ts        # standalone REST PUT, guild-scoped
│   │   ├── interaction-router.ts     # interactionCreate → dispatch → error boundary
│   │   └── message-router.ts         # messageCreate → #inbox handler only (v1)
│   │
│   ├── lib/
│   │   ├── env.ts                    # zod schema, parseEnv(), typed export
│   │   ├── auth.ts                   # assertOwner(interaction|message) throws if not owner
│   │   ├── client-tag.ts             # makeClientTag(interaction) → "uxie-<interactionId>"
│   │   ├── log.ts                    # structured JSON logger, correlation id, redacts BOT_TOKEN/AUTH/SECRET/KEY
│   │   ├── errors.ts                 # UxieError, ScryptError, NotOwnerError, ConfigError
│   │   ├── embed.ts                  # capture/search/semantic/brief embed builders
│   │   ├── tz.ts                     # USER_TZ helpers (nowInZone, journalDateKey)
│   │   └── command-builder.ts        # withOwnerGate(builder) — owner-only builder shape
│   │
│   └── integrations/
│       ├── README.md                 # "modules go here — one folder per backend"
│       ├── scrypt/
│       │   ├── index.ts              # registers commands + message handlers with bot shell
│       │   ├── mcp-client.ts         # POST /mcp streamable-http, bearer auth, tool wrappers
│       │   ├── rest-client.ts        # GET /api/daily_context, POST /api/ingest
│       │   ├── channels.ts           # INBOX_CHANNEL_ID constant + isInboxChannel()
│       │   └── commands/
│       │       ├── capture.ts        # /capture <text> [kind]
│       │       ├── ask.ts            # /ask <query>
│       │       ├── search.ts         # /search <query>
│       │       ├── journal.ts        # /journal <text>
│       │       ├── brief.ts          # /brief
│       │       └── ping.ts           # /ping (meta; lives here until core/ exists)
│       └── para-raid/
│           ├── README.md             # placeholder for the v2 module
│           └── orchestrator-stub.ts  # dispatch(job) → throws NotImplemented; seam for para-raid
│
├── tests/
│   ├── lib/
│   │   ├── env.test.ts
│   │   ├── client-tag.test.ts
│   │   └── embed.test.ts
│   ├── integrations/scrypt/
│   │   ├── mcp-client.test.ts
│   │   ├── rest-client.test.ts
│   │   └── commands/
│   │       ├── capture.test.ts
│   │       ├── ask.test.ts
│   │       ├── search.test.ts
│   │       ├── journal.test.ts
│   │       └── brief.test.ts
│   └── helpers.ts                    # fakeInteraction / fakeMessage
│
├── .env.example
├── .env                              # gitignored
├── Dockerfile
├── docker-compose.yml
├── bunfig.toml
├── tsconfig.json
├── package.json
└── README.md
```

## 5. Components

### 5.1 `bot/` — discord.js glue

- **`client.ts`** — constructs the `Client` with exactly the minimum intents per UXIE-DISCORD-GUIDELINES §5: `Guilds`, `GuildMessages`, `MessageContent`. Partials: `Channel` and `Message` (both required for `#inbox` capture). DM capture is deferred to v1.5; `DirectMessages` intent is intentionally **not** added in v1 to keep attack surface minimal.
- **`command-loader.ts`** — at boot, globs `src/integrations/*/commands/*.ts`, imports each, and populates a `Collection<string, Command>` keyed by command name. Each command file exports `{ data: SlashCommandBuilder, execute: (i, ctx) => Promise<void> }`. Every `data` builder is shaped via `lib/command-builder.ts`'s `withOwnerGate()` helper, which applies `setContexts(InteractionContextType.Guild)`, `setIntegrationTypes(ApplicationIntegrationType.GuildInstall)`, and `setDefaultMemberPermissions(0n)` per UXIE-DISCORD-GUIDELINES §6.2.
- **`deploy-commands.ts`** — standalone script (`bun run deploy`) that PUTs the command definitions to Discord's REST API, **guild-scoped** to `DISCORD_DEV_GUILD_ID`. Guild-scoped is instant to update; global is not used in v1.
- **`interaction-router.ts`** — the `interactionCreate` handler. One function:
  ```ts
  async function handleInteraction(i: Interaction) {
    if (!i.isChatInputCommand()) return;
    const cmd = commandRegistry.get(i.commandName);
    if (!cmd) return;
    try {
      assertOwner(i);
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await cmd.execute(i, { clientTag: makeClientTag(i), log: log.child({ interactionId: i.id }) });
    } catch (err) {
      await replyWithError(i, err);
    }
  }
  ```
  All ephemeral replies use `{ flags: MessageFlags.Ephemeral }` per UXIE-DISCORD-GUIDELINES §7/§8. The boolean `{ ephemeral: true }` form is deprecated in v14.26 and removed on the v15 path — never use it.
- **`message-router.ts`** — `messageCreate` handler. Gate: owner-only, not-a-bot, non-empty, channel matches `INBOX_CHANNEL_ID`. Delegates to `integrations/scrypt/index.ts`'s inbox handler. Same single error boundary as interactions; on error reacts with ❌ and logs.

### 5.2 `lib/` — shared primitives

- **`env.ts`** — a single zod schema covering every required variable. `parseEnv()` is called exactly once at boot from `src/index.ts`. A `ConfigError` at startup is a fatal `process.exit(1)` printing the failed field name. **No `process.env` access outside this module** (UXIE-DISCORD-GUIDELINES §17). Field names match UXIE-DISCORD-GUIDELINES §17.1 verbatim:
  ```
  DISCORD_BOT_TOKEN          DISCORD_APP_ID         DISCORD_DEV_GUILD_ID
  DISCORD_OWNER_ID           INBOX_CHANNEL_ID       USER_TZ
  SCRYPT_SERVER_URL          SCRYPT_MCP_URL         SCRYPT_AUTH
  ```
- **`auth.ts`** — `assertOwner(actor)` where `actor` is an interaction or a message. Throws `NotOwnerError` otherwise. No role checks, no allowlist file.
- **`client-tag.ts`** — `makeClientTag(i)` returns `` `uxie-${i.id}` ``. For inbox messages, `uxie-msg-${msg.id}`. Deterministic, so scrypt's server-side dedup handles retries naturally.
- **`log.ts`** — structured JSON logger (hand-rolled or `pino`). `log.child({ interactionId, command })` scopes per request. Levels: `info`, `warn`, `error`. Output: stdout only. **Redacts** any field whose key contains `BOT_TOKEN`, `AUTH`, `SECRET`, or `KEY` substrings (UXIE-DISCORD-GUIDELINES §17.2) — the value is replaced with `"[REDACTED]"` before serialisation.
- **`errors.ts`** — `UxieError` base class with `code` and `toUserMessage()`. Subclasses: `NotOwnerError`, `ScryptError`, `ConfigError`. No other error types in v1.
- **`embed.ts`** — small library of builders: `captureEmbed`, `searchResultEmbed`, `semanticResultEmbed`, `briefEmbed`. Each enforces Discord's 4096-char description cap and 25-field cap by truncating deterministically. v1 uses **classic embeds only**. Components V2 (`ContainerBuilder`, `SectionBuilder`, `TextDisplayBuilder`) is explicitly an upgrade path for v1.5+ and **must not** be mixed with `embeds` in the same message (Discord rejects it; see `discordjs-api-surface.md` §6 + UXIE-DISCORD-GUIDELINES §8).
- **`tz.ts`** — small helpers around `USER_TZ`: `nowInZone(tz)` returns a `{ date, time }` pair in IANA tz; `journalDateKey(tz, date?)` returns the `YYYY-MM-DD` key for the user's local day. Used by `/journal` reply text and `/brief` title.
- **`command-builder.ts`** — exports `withOwnerGate(builder: SlashCommandBuilder): SlashCommandBuilder`. Applies the three mandatory setters from UXIE-DISCORD-GUIDELINES §6.2 (`setContexts`, `setIntegrationTypes`, `setDefaultMemberPermissions(0n)`) so every command file gets owner-gated builder shape from one source of truth.

### 5.3 `integrations/scrypt/` — the sole v1 module

- **`index.ts`** — the module's registration surface. Exports `registerScryptIntegration(bot)`. Called once from `src/index.ts`:
  ```ts
  export function registerScryptIntegration(bot: BotShell) {
    bot.registerCommands(loadCommandsFrom("./commands"));
    bot.onMessage(isInboxChannel, handleInboxCapture);
  }
  ```
  When a second integration arrives, a sibling `registerPararaidIntegration(bot)` sits beside this. `src/index.ts` calls both. No central registry needed.
- **`mcp-client.ts`** — `ScryptMcpClient` class. Constructor takes URL + bearer. **v1 is read-only**: uxie wraps only the three MCP tools the read commands need.
  - `searchNotes(query, limit)` → `SearchHit[]`
  - `semanticSearch(query, limit)` → `SemanticHit[]`
  - `getNote(path)` → `Note`

  **All writes in v1 go through `rest-client.ts` / `POST /api/ingest`**, not through MCP `create_note`. Rationale: scrypt's ingest router already owns folder routing, slugging, and frontmatter construction by `kind`. Letting uxie build paths locally would duplicate scrypt's slugger and drift. The ideation brief states this explicitly for `/journal`; v1 generalises the same pattern to every write kind.

  The remaining MCP tools (`create_note`, `find_similar`, `update_note_metadata`, `add_section_summary`, `add_edge`, `remove_edge`, `walk_graph`, `get_report`, `cluster_graph`) are **not** wrapped in v1. Each one gets added when a v1.x command needs it — one method, one test, one line in §6.
  All MCP calls go through one internal `post(tool, args)` that owns bearer auth, `AbortSignal.timeout(10_000)`, JSON parsing, and error mapping into `ScryptError`.
- **`rest-client.ts`** — `ScryptRestClient` class. Three methods:
  - `getDailyContext()` → `DailyContext` (for `/brief`).
  - `ingest(params)` → `{ path, permalink }` where `params = { kind, content, clientTag, tz?, meta? }`. The single write primitive used by `/capture`, `/journal`, and `#inbox`. `kind` values used in v1: `note` (default for inbox capture), `thought`, `idea`, `journal`. Scrypt's ingest router owns folder routing, slug, and frontmatter.
  - `health()` → `{ ok: boolean, reason?: string }`. If scrypt exposes `GET /api/health`, uses it directly. Otherwise falls back to a 500 ms `GET /api/daily_context` — cheap and end-to-end.

  Same timeout + error shape as the MCP client.
- **`channels.ts`** — `isInboxChannel(msg)` checks `msg.channelId === env.INBOX_CHANNEL_ID`.
- **`commands/*.ts`** — one file per slash command, each exporting `{ data, execute }`. Command logic is strictly an adapter: read options, call client, build embed, `editReply`. No business logic lives here — if it can't be expressed as "call this one method, render this one embed", it's wrong. Every command body is `try/catch`-free; the interaction-router boundary is the only catch site (UXIE-DISCORD-GUIDELINES §14.2 + §22 anti-pattern).

### 5.4 `integrations/para-raid/` — placeholder for module #2

- **`orchestrator-stub.ts`** — the v1 placeholder for the para-raid module; exports `dispatch(job)` that throws `new UxieError("not_implemented_v1", "para-raid not wired in v1")`. No command calls it in v1. Living under `integrations/para-raid/` (rather than under `scrypt/`) preserves the module boundary required by UXIE-DISCORD-GUIDELINES §11 and the SUP cross-module-import anti-pattern; when the para-raid integration is built out, the file becomes its real entry point with no directory churn.
- **`README.md`** — one paragraph: "module #2 lands here when para-raid's outward surface is spec'd. Do not import from `integrations/scrypt/`."

## 6. Data Flow

Every command follows the same pattern: `defer → assertOwner → call backend → render embed → editReply`. The error boundary in `interaction-router.ts` is the only place exceptions are caught.

### 6.1 `/capture <text> [kind=note|thought|idea]`

1. `deferReply()` within 3s.
2. `restClient.ingest({ kind, content: text, clientTag })` → `POST /api/ingest` with the chosen kind. Default `kind=note` (scrypt routes it into `notes/inbox/`).
3. `editReply(captureEmbed({ path, permalink }))` using the `path`/`permalink` scrypt returns.

Uxie does **not** construct the path or slug — scrypt's ingest router owns that. Retrying is safe because `clientTag` is deterministic per interaction and scrypt dedupes server-side.

**Kinds explicitly omitted from the `/capture` option list:**
- `thread` — needs `status`, `priority`, and a `prompt` body. Doesn't fit a one-line slash option. Add a dedicated `/thread` command in v1.x if wanted.
- `memory` — needs an `active: bool` flag and is a durable preference profile, not a quick capture. Same rationale.
- `journal` — has its own dedicated `/journal` command (§6.5).
- `research_run`, `spec`, `plan`, `log` — not daily-capture shapes; handled by other flows (orchestrator / editor / etc.).

### 6.2 `#inbox` channel passive capture

1. `messageCreate` fires.
2. Gate: owner, not-a-bot, non-empty, channel matches `INBOX_CHANNEL_ID`.
3. `restClient.ingest({ kind: "note", content: msg.content, clientTag: "uxie-msg-" + msg.id })`.
4. React `✅` on success, `❌` on failure.

No embed reply — minimises channel noise. This is a **deliberate v1 simplification** of the ideation brief, which wanted the bot to post back a permalink and live embedding-progress reactions. Permalink echo is trivial to add in v1.x if wanted (edit the message with a one-line reply); the embedding-progress part depends on the deferred `#notifications` WebSocket bridge.

**Discord prerequisites for this flow** (documented in README):
- `MessageContent` is a **privileged intent** and must be toggled on in the Discord developer portal for the application before `messageCreate` handlers see message bodies. Required for `#inbox` and for any future DM-capture flow.
- `INBOX_CHANNEL_ID` must be set in `.env` and point to a real guild channel the bot can read.

### 6.3 `/ask <query>`

1. `mcpClient.semanticSearch(query, limit=5)`.
2. `semanticResultEmbed(hits)` — up to 5 lines, each `**<title>** — <snippet, 200 chars>`.
3. Empty results → plain `"no matches"` text.

No pagination. 5 hits fit inside the 4096-char description cap with room to spare.

### 6.4 `/search <query>`

1. `mcpClient.searchNotes(query, limit=10)`.
2. `searchResultEmbed(hits)` — up to 10 results.
3. Empty results → plain `"no matches"` text.

FTS5 is exact and cheap; 10 is deliberate, more than `/ask`'s 5.

### 6.5 `/journal <text>`

1. `restClient.ingest({ kind: "journal", content: text, clientTag, tz: USER_TZ })` → `POST /api/ingest` with `kind=journal`.
2. Reply `"📓 appended to <YYYY-MM-DD>.md at HH:MM <tz>"` (plain text, no embed). Date and time strings come from `lib/tz.ts` so the wall-clock matches `USER_TZ`, not the bot host's local TZ.

Timezone math on the **storage** side is entirely scrypt's job. Uxie passes `USER_TZ` through verbatim via the `tz` field in the ingest request body. The `lib/tz.ts` helpers are used only for the **reply text** rendering (cosmetic), never to compute the file path. **Integration contract note:** if scrypt's current `/api/ingest?kind=journal` contract does not yet accept a `tz` field, the v1 plan must extend scrypt's ingest router to read it (falling back to server TZ if absent). This is a small scrypt change, flagged here so the uxie plan can include a scrypt-side task for it.

### 6.6 `/brief`

1. `restClient.getDailyContext()` → `{ today_journal, recent_notes, open_threads, active_memories, tag_cloud }`.
2. `briefEmbed(ctx)` renders:
   - Title: `"Daily brief — <YYYY-MM-DD>"`
   - Fields (each truncated to fit):
     - Today's journal (first 200 chars)
     - Open threads — top 5 by priority
     - Recent captures — last 5 in `notes/inbox/`
     - Active memories — names only
     - Tag cloud — top 10 tags
3. `editReply(embed)`.

Deterministic and LLM-free. No scheduled push in v1 — user types `/brief` when they want it.

### 6.7 `/ping`

1. `restClient.health()` with a 500ms timeout (uses `GET /api/health` if scrypt exposes it, otherwise a shallow `GET /api/daily_context`).
2. Reply `"🏓 uxie alive — uptime <N> — scrypt: <ok|unreachable>"`.

The manual health check in lieu of any in-Discord dashboard. Uxie does not probe the MCP endpoint directly because streamable-http MCP endpoints do not respond to unauthenticated probes; hitting the REST surface is both cheaper and a truer end-to-end signal (same process, same auth path).

### 6.8 Cross-cutting flow rules

- Every command calls `deferReply()` before any network I/O.
- Every command issues exactly one `editReply`. No `followUp` chains.
- Every outbound HTTP call uses `AbortSignal.timeout(10_000)`.
- Every error bubbles to the single boundary in `interaction-router.ts`.

## 7. Error Handling

### 7.1 Error taxonomy

```ts
class UxieError extends Error {
  constructor(public code: string, message: string, public cause?: unknown) { super(message); }
  toUserMessage(): string { return `${this.code}: ${this.message}`; }
}
class NotOwnerError extends UxieError   {} // code: "not_owner"
class ScryptError   extends UxieError   {} // code: "scrypt_<kind>"
class ConfigError   extends UxieError   {} // code: "config", boot-time only
```

### 7.2 Catch sites (exactly three, per UXIE-DISCORD-GUIDELINES §14.2)

1. **`bot/interaction-router.ts` boundary.** All slash-command dispatches. Maps known errors to ephemeral user messages; logs unknowns. Owner-gate failure replies `"not for you"`.
2. **`bot/message-router.ts` boundary.** All `#inbox` message handling. "Reply" is reacting `❌` instead of editing a message.
3. **`src/index.ts` top-level process.** Two `process.on` registrations — `'uncaughtException'` and `'unhandledRejection'` — log + `process.exit(1)`. Systemd / Docker restarts. The same file also handles the boot-time `ConfigError` from `parseEnv()` (log + `process.exit(1)` with the failed field name).

**No `try/catch` inside command bodies.** Throw with the right error class; the router decides the user-visible message (UXIE-DISCORD-GUIDELINES §22 anti-pattern).

### 7.3 User-facing messages

| Internal error       | User sees                                    |
|----------------------|----------------------------------------------|
| `NotOwnerError`      | `"not for you"` (ephemeral)                  |
| `ScryptError(unreachable)` | `"scrypt unreachable"`                 |
| `ScryptError(auth)`  | `"scrypt auth rejected"`                     |
| `ScryptError(bad_request)` | `"scrypt: <msg>"`                      |
| `ScryptError(server)`| `"scrypt server error"`                      |
| `ScryptError(timeout)` | `"scrypt timed out"`                       |
| `ScryptError(tool_error)` | `"scrypt tool failed: <msg>"`           |
| Anything else        | `"uxie crashed, check logs"` (full stack in logs only) |

### 7.4 Retry policy

**None.** Scrypt writes are idempotent via `client_tag`, so the user hitting a command again is the retry. Automatic retries add double-capture races and mask real outages in exchange for near-zero benefit at a single-user scale.

## 8. Testing

### 8.1 Runtime

`bun test`. No other test runner.

### 8.2 What is unit-tested

- `lib/env.ts` — schema happy path and each missing-variable error case.
- `lib/client-tag.ts` — stable format, derived only from interaction/message id.
- `lib/embed.ts` — length capping, snippet truncation, empty-result path.
- `integrations/scrypt/mcp-client.ts` — with `fetch` mocked, each wrapped tool's response parsing plus all six HTTP-failure mappings from §7.3.
- `integrations/scrypt/rest-client.ts` — same shape as MCP client tests.
- `integrations/scrypt/commands/*.ts` — with `fakeInteraction` and a mocked client, each command asserts: `deferReply` called, client called with correct args, `editReply` called with correct embed shape.

### 8.3 What is explicitly not tested in v1

- No real Discord gateway in CI. Interaction types are mocked with hand-rolled doubles cast as `any`.
- No real scrypt server in unit tests. A `test:integration` script exists in `package.json` with an empty suite — placeholder for later.
- No snapshot tests on embed markdown. Manual eyeballing during smoke.

### 8.4 Smoke ritual

Against a dev guild with `docker compose up` running both containers, manually run:

**Happy-path commands (all six + #inbox round-trip):**

1. `/ping` — expect "🏓 uxie alive — uptime Ns — scrypt: ok".
2. `/capture hello` — expect embed with `notes/inbox/...` path + permalink.
3. Post a message in `#inbox` — expect ✅ reaction; verify note appears in `notes/inbox/`.
4. `/ask something` — expect semantic-hits embed (or "no matches").
5. `/search something` — expect FTS5-hits embed (or "no matches").
6. `/journal smoke test` — expect "📓 appended to YYYY-MM-DD.md at HH:MM <tz>".
7. `/brief` — expect populated daily-context embed.

**Failure-mode checks (must also pass):**

8. From an alt account, run `/ping` — expect ephemeral `"not for you"`; main account interactions still work.
9. Stop scrypt container, run `/ping` — expect `"scrypt: unreachable"`; bot stays alive.
10. With scrypt down, post in `#inbox` — expect ❌ reaction; bot stays alive.

If all ten produce the expected response and no unhandled logs appear, v1 ships.

### 8.5 Test helpers

`tests/helpers.ts` exports `fakeInteraction(overrides)` and `fakeMessage(overrides)`. No TypeScript gymnastics — cast as `any`. `ChatInputCommandInteraction` is famously hostile to faithful construction; faithful construction is not the goal.

## 9. Phased Rollout

Five sequential phases. Each phase leaves the repo in a demo-able state.

### Phase 0 — Scaffolding
- `bun init`, `tsconfig.json`, `bunfig.toml`, `.gitignore`, `.env.example`
- `Dockerfile` (FROM `oven/bun:1-alpine`) + `docker-compose.yml` with `uxie` + `scrypt` on shared network
- Placeholder `src/index.ts` that logs `"uxie boot — env valid"` and exits
- `lib/env.ts` (zod schema, fail-fast `process.exit(1)` with field name), `lib/log.ts` (with redaction of `BOT_TOKEN`/`AUTH`/`SECRET`/`KEY` substrings), `lib/errors.ts`, `lib/tz.ts`, `lib/command-builder.ts` + tests for each
- `README.md` with a **Discord prerequisites** section: application created, bot token + app id + guild id captured, `MessageContent` **privileged intent** toggled on in the developer portal, `#inbox` channel created and its id captured into `.env`
- **Done when:** `docker compose up uxie` prints `"uxie boot — env valid"` and exits clean; README prerequisites are complete and copy-pasteable.

### Phase 1 — Discord shell + `/ping`
- `bot/client.ts` (intents `Guilds | GuildMessages | MessageContent`; partials `Channel + Message`), `bot/command-loader.ts`, `bot/interaction-router.ts` (uses `MessageFlags.Ephemeral`), `bot/deploy-commands.ts`
- `lib/auth.ts`, `lib/client-tag.ts`
- `integrations/scrypt/rest-client.ts` — first introduced here, with `health()` only
- `integrations/scrypt/index.ts` — stub that registers `/ping` only
- `integrations/scrypt/commands/ping.ts` — builder shaped via `withOwnerGate()`
- `integrations/para-raid/orchestrator-stub.ts` + `integrations/para-raid/README.md` — wire the v2 seam
- Top-level `process.on('uncaughtException' | 'unhandledRejection')` registered in `src/index.ts`
- Tests: router error-boundary cases, `assertOwner`, rest-client `health()` with mocked fetch covering all error mappings
- **Done when:** bot connects, `/ping` responds within 3s with live scrypt status, non-owner gets `"not for you"`.

### Phase 2 — `/capture` + `#inbox`
- Extend `integrations/scrypt/rest-client.ts` with `ingest(params)` — the single write primitive
- `integrations/scrypt/channels.ts`, `bot/message-router.ts`
- `integrations/scrypt/commands/capture.ts` (3 kind choices: `note`, `thought`, `idea`)
- Inbox message handler wired into `integrations/scrypt/index.ts`
- `lib/embed.ts` — `captureEmbed`
- Tests: rest-client `ingest` wrapper; capture command with fake interaction; inbox message handler with fake message
- **Done when:** `/capture hello world` creates a real note in dev scrypt and replies with its permalink (no uxie-side slugging); posting in `#inbox` creates a note and reacts ✅; scrypt down → `"scrypt unreachable"` and bot stays alive; retrying is safe (server-side dedup verified).

### Phase 3 — Read commands
- `integrations/scrypt/mcp-client.ts` — first introduced here, with `searchNotes`, `semanticSearch`, `getNote`
- `integrations/scrypt/commands/ask.ts`, `search.ts`
- `lib/embed.ts` — `searchResultEmbed`, `semanticResultEmbed`
- Tests: mcp-client error mappings for all 6 HTTP outcomes; both commands with fake interactions
- **Done when:** both commands return usable embeds against dev scrypt; empty-result path verified; embed length caps verified.

### Phase 4 — `/journal` + `/brief`
- Extend `integrations/scrypt/rest-client.ts` with `getDailyContext()`
- `integrations/scrypt/commands/journal.ts` (reuses existing `ingest` with `kind=journal`, `tz=USER_TZ`)
- `integrations/scrypt/commands/brief.ts`
- `lib/embed.ts` — `briefEmbed`
- **Scrypt-side dependency:** confirm `/api/ingest?kind=journal` accepts a `tz` field; if not, add the small router change as a tracked task on the scrypt repo before this phase can be marked done
- Tests for `getDailyContext` + both commands
- **Done when:** `/journal` appends to today's file with the correct wall clock; `/brief` renders a populated embed from `/api/daily_context`; `USER_TZ` respected; full smoke ritual passes.

## 10. Acceptance Criteria

v1 is accepted only when all of the following hold:

- ✅ Five slash commands (`/capture`, `/ask`, `/search`, `/journal`, `/brief`) + `/ping` registered and responding in the dev guild.
- ✅ Every command builder is shaped via `withOwnerGate()` (sets `setContexts`, `setIntegrationTypes`, `setDefaultMemberPermissions(0n)`).
- ✅ Every ephemeral reply uses `flags: MessageFlags.Ephemeral` (no boolean `ephemeral: true` anywhere).
- ✅ `#inbox` channel capture works and reacts ✅ / ❌.
- ✅ Owner allowlist blocks every non-owner interaction with `"not for you"`.
- ✅ Scrypt unreachable → every scrypt command fails with a clean user-facing message; bot stays alive.
- ✅ Scrypt bearer rejected → `"scrypt auth rejected"`.
- ✅ 10-second timeout enforced on every outbound HTTP call.
- ✅ Top-level `process.on('uncaughtException' | 'unhandledRejection')` registered; an unhandled reject in any handler logs + exits non-zero.
- ✅ `bun test` all green.
- ✅ Smoke ritual in §8.4 passes manually.
- ✅ `docker compose up` from a clean clone produces a running bot.
- ✅ `.env.example` is complete; zod boot validation catches every missing var and exits 1 with the failed field name.
- ✅ `src/integrations/README.md` explains how to add module #2; `src/integrations/para-raid/orchestrator-stub.ts` exists.

## 11. Open Questions Deferred to v2

These are intentionally parked. They are not blockers for v1 but should be revisited when module #2 lands or when para-raid becomes available:

- Does the `/brief` want a scheduled push once cron exists? What time, what timezone, what channel?
- When para-raid is live, does `/capture`'s enrichment run synchronously (slower UX) or as a background job (cheaper, eventual-consistent)?
- Should the orchestrator path use an outbound HTTP call (uxie → para-raid), a shared queue (both read/write the same backing store), or an event stream? Decide when para-raid's outward surface is spec'd.
- Where does the "module #2 arrived" duplication threshold sit — when does `core/` get pulled out, and which concerns move first? (Likely candidates: notifier, channel context resolver, health-check aggregator.)
- Testing strategy for a second module — does the fake-interaction helper stay as-is or graduate to something shared?

## 12. References

- `docs/discordjs-research.md` — discord.js v14 technical brief for uxie.
- `docs/scrypt-integration-context.md` — uxie's position in the Scrypt HLD.
- `docs/scrypt-feature-ideation.md` — full feature-card inventory and interaction models.
- `../scrypt/docs/superpowers/specs/2026-04-11-scrypt-design.md` — Scrypt design spec.
- `../para-raid/PRD.md` — para-raid Claude Execution Mesh PRD (future v2 module backend).
- `docs/SUP-GUIDELINES.md` — system-wide planes, boundary rules, secrets layout.
- `docs/UXIE-DISCORD-GUIDELINES.md` — uxie operating doc (intents, builder shape, lifecycle, error handling, anti-patterns).
- `docs/discordjs-api-surface.md` — symbol-level USE NOW / USE LATER / NEVER verdicts + v15 readiness matrix.

## 13. Revision Log

- **2026-04-27 — v1.1.** Aligned with SUP-GUIDELINES, UXIE-DISCORD-GUIDELINES, and discordjs-api-surface. Concrete changes: dropped `DirectMessages` intent (added `Partials.Message`); renamed env vars to match UXIE §17.1 (`DISCORD_DEV_GUILD_ID`, `DISCORD_OWNER_ID`, `SCRYPT_SERVER_URL`, `SCRYPT_AUTH`); moved orchestrator-stub from `integrations/scrypt/` to `integrations/para-raid/`; added `lib/tz.ts` and `lib/command-builder.ts` (`withOwnerGate()`); pinned ephemeral form to `MessageFlags.Ephemeral`; promoted top-level `process.on` to the third catch site; documented logger redaction substrings; extended smoke ritual with three failure-mode checks; corrected dev scrypt port reference from `:3777` to `:3000`.
- **2026-04-14 — v1.0.** Initial design approved for planning.
