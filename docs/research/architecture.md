# Uxie Architecture — Deep Research

**Dimension:** architecture
**Date:** 2026-06-03
**Status:** research input for the upcoming build workflow (repo is docs-only today)
**Scope:** Best-in-class architecture for a Bun + discord.js v14.26 stateless single-owner bot built as a pluggable multi-integration host.

---

## 0. Context recap

Uxie is the **User plane** of the SUP three-app system (Scrypt = Data plane, Para-RAID = Ops/Control plane, Uxie = User plane). It is a **stateless translation layer**: Discord input → Scrypt REST writes (`POST /api/ingest`) + Scrypt MCP reads (`search_notes`, `semantic_search`, `get_note` via `POST /mcp` bearer). No persistent state, no business logic, no LLM calls of its own.

Runtime: Bun + TypeScript + `discord.js@^14.26.2`, single long-lived process, single shard, single-owner allowlist, Docker (v1 = Docker Desktop; prod = VPS on Tailscale). v1 ships exactly one module (`scrypt`); para-raid is a documented v2 slot. v1 commands: `/ping`, `/capture` (+ `#inbox` passive capture), `/search`, `/ask`, `/journal`, `/brief`.

**The single most important architectural finding of this research:** the Design Spec (`2026-04-14-uxie-design.md` §3.2, §4, §5.3) has **already resolved** the central architecture question against the earlier Feature Ideation Brief (`scrypt-feature-ideation.md` §7). The ideation brief proposed a `core/` directory with `registry.ts`, `notifier.ts`, `idempotency.ts`, `auth.ts`, `channels.ts` and a formal `Integration` interface. The Design Spec **deliberately rejects this** ("No registry abstraction yet. 'Module' is a folder convention and a naming discipline, not an `Integration` interface. When module #2 reveals real duplication, shared concerns move from `integrations/` into `core/`. Not before." — §3.2). This research **endorses the Design Spec's decision** and treats the ideation brief's `core/` proposal as the historical alternative it superseded. Every recommendation below builds on the spec, not against it.

---

## 1. Recommended approach (with rationale)

### 1.1 Module shape: folder convention + per-module `register*(bot)`, NOT a registry

**Recommendation (v1, endorse spec):** keep the spec's pattern. Each integration is a folder under `src/integrations/<name>/` exporting a single registration function:

```ts
// src/integrations/scrypt/index.ts
export function registerScryptIntegration(bot: BotShell): void {
  bot.registerCommands(loadScryptCommands());   // returns LoadedCommand[]
  bot.onMessage(isInboxChannel, handleInboxCapture);
}
```

`src/index.ts` calls `registerScryptIntegration(bot)` directly. When para-raid arrives, a sibling `registerPararaidIntegration(bot)` is added and `index.ts` calls both. There is no central `registry.ts` map, no `Integration` interface object, no plugin discovery of integrations.

**Rationale.** At a count of one integration, a registry is pure ceremony — it adds an interface, an indirection table, and a lifecycle contract to satisfy a polymorphism requirement that does not exist yet. The YAGNI / "rule of three" boundary is explicit in the spec: extract shared concerns into `core/` only when **module #2 reveals real duplication**. A direct `register*(bot)` call list in `index.ts` is the simplest thing that preserves the module boundary (no cross-module imports) while costing nothing. discord.js's own command-handler guide uses the same flat "scan files → `Collection.set(name, cmd)`" pattern with no registry abstraction ([discord.js guide — command handling](https://discordjs.guide/creating-your-bot/command-handling.html)).

**The "module #2 duplication threshold" — concrete extraction triggers.** Promote a concern from `integrations/scrypt/` (or `lib/`) into a new `src/core/` directory **only when para-raid is actually being built** AND at least one of these holds:

- Both modules need an outbound push pipeline into Discord (the ideation brief's `notifier.ts`) — i.e. the `#notifications` WS bridge ships. This is a Tier-2 v2 feature today.
- Both modules need the **same** channel-context resolver beyond `isInboxChannel` (ideation's `channels.ts`).
- The `register*(bot)` boilerplate becomes genuinely identical across ≥2 modules such that a `for (const reg of [registerScrypt, registerPararaid]) reg(bot)` loop is cleaner than two explicit calls — this is a 5-line refactor, not an architecture.

Until then, `core/` does not exist. Do not pre-create it. (Conflicts-with-spec: none — this is the spec's own rule.)

### 1.2 The `BotShell` type — the seam that replaces a registry

The spec names `registerScryptIntegration(bot: BotShell)` but does not fully define `BotShell`. This research proposes the concrete contract. `BotShell` is the **minimal surface a module needs to plug into the bot**, owned by `bot/`:

```ts
// src/bot/shell.ts (or co-located in command-loader.ts / interaction-router.ts)
export interface BotShell {
  /** Adds module commands to the global Collection (keyed by command name). Throws on duplicate name. */
  registerCommands(commands: LoadedCommand[]): void;
  /** Registers a message predicate + handler for messageCreate dispatch (v1: one inbox handler). */
  onMessage(match: (msg: Message) => boolean, handle: MessageHandler): void;
}
```

This is **not** the rejected `Integration` interface — it is the inverse. The `Integration` interface would make each module implement a uniform shape the host calls polymorphically. `BotShell` instead exposes host capabilities the module calls imperatively. The host stays module-agnostic; the module stays in control of what it registers. This is the lighter-weight pattern and the one that matches the spec's `register*(bot)` signature.

### 1.3 Directory layout (authoritative — from Design Spec §4)

The spec's layout is correct and complete. Reproduced here as the build target:

```
src/
├── index.ts                     # boot: parseEnv → createClient → load+register → deploy?→ login; process.on handlers
├── bot/
│   ├── client.ts                # createDiscordClient(): minimal intents + partials
│   ├── command-loader.ts        # buildCommandCollection(mods): Collection<string, LoadedCommand>
│   ├── deploy-commands.ts       # standalone `bun run deploy`: REST PUT guild-scoped
│   ├── interaction-router.ts    # interactionCreate → owner gate → defer → dispatch → ERROR BOUNDARY #1
│   └── message-router.ts        # messageCreate → #inbox gate → handler → ERROR BOUNDARY #2 (❌ react)
├── lib/
│   ├── env.ts                   # zod schema, parseEnv() once at boot, typed export
│   ├── auth.ts                  # assertOwner(interaction|message) → throws NotOwnerError
│   ├── client-tag.ts            # makeClientTag(i) → "uxie-<id>"; makeMsgTag(m) → "uxie-msg-<id>"
│   ├── log.ts                   # structured JSON logger, child(), redaction
│   ├── errors.ts                # UxieError + NotOwnerError/ScryptError/ConfigError ONLY
│   ├── embed.ts                 # captureEmbed/searchResultEmbed/semanticResultEmbed/briefEmbed
│   ├── tz.ts                    # nowInZone(tz), journalDateKey(tz, date?)
│   └── command-builder.ts       # withOwnerGate(builder) — the three mandatory setters
└── integrations/
    ├── README.md
    ├── scrypt/
    │   ├── index.ts             # registerScryptIntegration(bot: BotShell)
    │   ├── mcp-client.ts        # ScryptMcpClient: searchNotes/semanticSearch/getNote
    │   ├── rest-client.ts       # ScryptRestClient: getDailyContext/ingest/health
    │   ├── channels.ts          # isInboxChannel(msg)
    │   └── commands/            # ping/capture/ask/search/journal/brief — {data, execute}
    └── para-raid/
        ├── README.md
        └── orchestrator-stub.ts # dispatch(job) → throws UxieError("not_implemented_v1", …)
```

**Decision on `core/` vs `lib/` vs `bot/`:** there is no `core/` in v1. The three top-level concerns are: `bot/` (discord.js glue — host-side, module-agnostic), `lib/` (pure shared primitives — no discord.js event wiring, importable by anything), `integrations/<name>/` (outward adapters — own their HTTP clients + commands + handlers + env namespace). This is a clean three-layer separation. `core/` is the deferred fourth layer that appears only at module #2.

**One note on `ping.ts` placement.** The spec parks `/ping` under `integrations/scrypt/commands/ping.ts` "until `core/` exists" (§4 comment). `/ping` is a meta command that also probes Scrypt health (`restClient.health()`, §6.7), so living in `scrypt/` is defensible in v1 — it does call the scrypt rest-client. When `core/` is extracted, `/ping` moves there. Flag this as a known, intentional smell; do not over-engineer a `bot/commands/` directory just for one command in v1.

### 1.4 Dependency injection: `ctx` object, NOT module-level singletons

**Recommendation (v1):** inject the Scrypt clients (and `log`, `clientTag`, `env`) into commands via a per-interaction **`ctx` object**, constructed at the router boundary. Do **not** import a module-level singleton client into each command file.

The spec already points here: `command-loader.ts` defines `CommandContext` and the interaction-router calls `cmd.execute(i, { clientTag, log: log.child({ interactionId: i.id }) })` (§5.1). Extend that `ctx` to carry the scrypt clients:

```ts
// src/bot/command-loader.ts
export interface CommandContext {
  clientTag: string;
  log: Logger;                 // already scoped via log.child({ interactionId })
  scrypt: {
    mcp: ScryptMcpClient;
    rest: ScryptRestClient;
  };
}

export interface LoadedCommand {
  data: SlashCommandBuilder;   // already shaped via withOwnerGate()
  execute(i: ChatInputCommandInteraction, ctx: CommandContext): Promise<void>;
}
```

The clients themselves are constructed **once at boot** (they are cheap stateless wrappers over `fetch` — see §1.8) and passed by reference into each `ctx`. So "construct once, inject per call" — not a new client per interaction, not a global import.

**Rationale.**
- **Testability is the decisive factor.** The spec's testing plan (§8.2) tests each command "with `fakeInteraction` and a mocked client" asserting "client called with correct args". DI via `ctx` makes the mock a one-line object literal: `execute(fakeInteraction(), { clientTag: "t", log: noopLog, scrypt: { mcp: mockMcp, rest: mockRest } })`. A module-level singleton would force `mock.module()` / import interception per test file — brittle under `bun test` and fighting ESM.
- **Statelessness.** `ctx` is created and discarded per interaction; nothing accumulates. It carries the per-request correlation id (`clientTag`, `log` child) cleanly.
- **The boundary owns construction.** The router is already the place where `clientTag` and the log child are made (§5.1). Adding `scrypt` to that same object keeps construction in one place. The router holds the long-lived client instances (created in `index.ts`, passed to the router factory).

**Wiring shape** (router as a factory closing over the boot-time clients):

```ts
// src/index.ts (boot)
const env = parseEnv();
const mcp = new ScryptMcpClient(env.SCRYPT_MCP_URL, env.SCRYPT_AUTH);
const rest = new ScryptRestClient(env.SCRYPT_SERVER_URL, env.SCRYPT_AUTH);
const client = createDiscordClient();
const commands = buildCommandCollection(loadAllCommands());
client.on(Events.InteractionCreate, makeInteractionRouter({ commands, mcp, rest, log }));
client.on(Events.MessageCreate, makeMessageRouter({ rest, log }));
```

This keeps `bot/` module-agnostic in spirit (it receives `mcp`/`rest` as opaque deps) while v1 hardwires the scrypt clients. When module #2 arrives, the router's dep bag grows or the `ctx` gains a per-module sub-object; no command rewrite needed.

### 1.5 The exactly-three catch sites (verbatim from spec §7.2; one critical hardening)

| # | Site | Catches | User-visible result |
|---|------|---------|---------------------|
| 1 | `bot/interaction-router.ts` boundary | all slash dispatch; wraps `assertOwner` + `cmd.execute` | maps `UxieError` subclasses → ephemeral text (§7.3 table); `NotOwnerError` → `"not for you"`; unknown → `"uxie crashed, check logs"` |
| 2 | `bot/message-router.ts` boundary | all `#inbox` handling | react `❌` on failure, `✅` on success; no reply message |
| 3 | `src/index.ts` top-level | `process.on('uncaughtException')` + `process.on('unhandledRejection')` → log + `process.exit(1)`; also boot-time `ConfigError` from `parseEnv()` | process dies, Docker/systemd restarts |

**No `try/catch` inside command bodies.** Commands throw the right error class; the router decides the message. This is a hard rule (Guidelines §22).

**Critical v15-readiness hardening for site #1 and #2 (open question §7-Q1 in the surface doc).** In discord.js v15, `BaseClient` extends `AsyncEventEmitter` instead of Node's `EventEmitter` ([discord.js v15 migration notes](https://v15.discordjs.guide/additional-info/updating-from-v14); WebSearch synthesis, June 2026). Under v14.26 today, a Promise rejected inside an `async` listener body that is *not* awaited by the emitter becomes an **unhandled rejection** — it would hit catch site #3 and kill the process, not catch site #1. **Therefore the router listeners must be `async` functions whose entire body is inside the `try/catch`**, so every rejection is caught locally before it can escape to the emitter. Concretely:

```ts
// src/bot/interaction-router.ts — the listener IS the boundary
export function makeInteractionRouter(deps: RouterDeps) {
  return async (i: Interaction): Promise<void> => {   // listener returns a Promise
    if (!i.isChatInputCommand()) return;
    const cmd = deps.commands.get(i.commandName);
    if (!cmd) return;
    try {
      assertOwner(i);                                  // throws NotOwnerError
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await cmd.execute(i, makeCtx(i, deps));
    } catch (err) {
      await replyWithError(i, err, deps.log);          // never re-throws
    }
  };
}
```

The `try` must wrap **everything after the early returns**, and `replyWithError` must itself never throw (wrap its own `editReply`/`reply` in a defensive `.catch(() => {})` — replying to an already-failed interaction can itself fail, e.g. unknown-interaction 10062). This is the one place a nested defensive catch is justified, and it lives in the boundary, not a command. This satisfies both the v14.26 contract and the v15 `AsyncEventEmitter` migration with zero code change.

### 1.6 Client factory config (verbatim from spec §5.1 / plan Task 9)

```ts
// src/bot/client.ts
import { Client, GatewayIntentBits, Partials, Events } from "discord.js";

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,          // interactionCreate
      GatewayIntentBits.GuildMessages,   // #inbox messageCreate
      GatewayIntentBits.MessageContent,  // PRIVILEGED — toggle in dev portal
    ],
    partials: [Partials.Channel, Partials.Message],
    allowedMentions: { parse: [], repliedUser: false },
  });
}
```

**Confirmed correct and minimal.** `DirectMessages` is intentionally absent (DM capture is v1.5; keeps attack surface minimal — Consistency Report drift #1 already fixed this). `GuildMembers` is absent (no multi-user). `Partials.Message` is required so the `#inbox` `messageCreate` handler receives uncached payloads; `Partials.Channel` likewise. Adding any intent requires a doc bump in Guidelines §5 — this is a hard rule.

**v15-readiness notes for the Client:**
- Use the **`Events` enum members**, never string event names: `client.on(Events.ClientReady, …)`, `Events.InteractionCreate`, `Events.MessageCreate`, `Events.Error`, `Events.Warn`. v15 renames the *strings* but keeps the enum members stable (`Events.ClientReady === 'clientReady'` in v14.26). The `message`/`interaction` bare events were already removed in v14 ([djs v14 changes — Events](https://discordjs.guide/legacy/additional-info/changes-in-v14)).
- `allowedMentions` set on the Client is inherited by `reply`/`editReply` (surface doc §7-Q5 — confirm in smoke; the default `{ parse: [] }` means no accidental @-pings even when echoing user content into embeds).
- `ws.ping` is used for `/ping` today; v15 moves it to `Client#ping`. Flag as a one-line migration.

### 1.7 Command loader / dynamic discovery — Bun glob, not `fs.readdirSync`

The spec says command-loader "globs `src/integrations/*/commands/*.ts`". discord.js's guide uses Node `fs.readdirSync` recursion ([guide — command handling](https://discordjs.guide/creating-your-bot/command-handling.html)), but **under Bun, prefer `Bun.Glob`** which is first-class and async:

```ts
// src/bot/command-loader.ts
import { Glob } from "bun";

export async function loadAllCommands(): Promise<LoadedCommand[]> {
  const glob = new Glob("integrations/*/commands/*.ts");
  const mods: LoadedCommand[] = [];
  for await (const path of glob.scan({ cwd: `${import.meta.dir}/..` })) {
    const mod = await import(`../${path}`);
    if ("data" in mod && "execute" in mod) mods.push(mod as LoadedCommand);
  }
  return mods;
}

export function buildCommandCollection(mods: LoadedCommand[]): Collection<string, LoadedCommand> {
  const c = new Collection<string, LoadedCommand>();
  for (const m of mods) {
    if (c.has(m.data.name)) throw new ConfigError("duplicate_command", `duplicate command: ${m.data.name}`);
    c.set(m.data.name, m);
  }
  return c;
}
```

**Design call: glob vs explicit list.** The spec mandates glob. A glob is fine for v1 (6 files, one module) and matches discord.js convention. The one risk is that a malformed/half-written command file silently fails the `"data" in mod` check and disappears — so `buildCommandCollection` must also be the place that throws on duplicates (the plan's Task 11 test already asserts this). An **explicit barrel** (`commands/index.ts` re-exporting each command) is the more deterministic alternative and is worth considering as a v1.5 hardening if glob ordering or silent-drop ever bites; for v1, honor the spec's glob. Keep `buildCommandCollection` (pure, list-in → Collection-out) separate from `loadAllCommands` (I/O, glob) so the collection logic stays unit-testable without touching the filesystem — the plan already structures it this way.

### 1.8 Scrypt clients: two classes, per-call `fetch`, no long-lived MCP connection

**Recommendation (v1, endorse spec):** split into `mcp-client.ts` (reads) and `rest-client.ts` (writes + health), both thin classes over Bun's global `fetch`, both per-call (no persistent connection, no SDK session).

**MCP streamable-http under Bun — concrete client pattern.** The MCP streamable-http transport (spec 2025-03-26, refined 2025-11-25) uses a **single `POST /mcp` endpoint** with JSON-RPC 2.0 messages; for a single-message response the server returns plain JSON, and it *can* upgrade to SSE for streaming ([MCP transports explained](https://chatforest.com/guides/mcp-transports-explained/); [MCP transport future, modelcontextprotocol.io](https://blog.modelcontextprotocol.io/posts/2025-12-19-mcp-transport-future/)). For uxie's three read tools, responses are small and single-shot — **do not pull in `@modelcontextprotocol/sdk`**; hand-roll the POST. This keeps deps at exactly `discord.js` + `zod` (hard constraint) and avoids the SDK's session/transport lifecycle (which assumes a long-lived client — the opposite of the per-call rule).

```ts
// src/integrations/scrypt/mcp-client.ts — sketch
export class ScryptMcpClient {
  constructor(private url: string, private auth: string) {}

  private async post(tool: string, args: unknown): Promise<unknown> {
    const body = { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call",
                   params: { name: tool, arguments: args } };
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",   // streamable-http requires both
          "Authorization": `Bearer ${this.auth}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") throw new ScryptError("scrypt_timeout", "scrypt timed out", e);
      throw new ScryptError("scrypt_unreachable", "scrypt unreachable", e);
    }
    if (res.status === 401 || res.status === 403) throw new ScryptError("scrypt_auth", "scrypt auth rejected");
    if (res.status >= 500) throw new ScryptError("scrypt_server", "scrypt server error");
    const json = await res.json();                            // parse JSON-RPC envelope
    if (json.error) throw new ScryptError("scrypt_tool_error", json.error.message ?? "tool failed");
    return json.result;                                       // unwrap result.content[] per MCP
  }

  searchNotes(query: string, limit = 10): Promise<SearchHit[]> { /* parse this.post("search_notes", …) */ }
  semanticSearch(query: string, limit = 5): Promise<SemanticHit[]> { /* … */ }
  getNote(path: string): Promise<Note> { /* … */ }
}
```

All five HTTP-failure mappings funnel through `post()` → exactly the `ScryptError` codes in spec §7.3. This is the single error-mapping site for MCP; `rest-client.ts` mirrors it. **Every wrapped tool response must be `zod`-parsed** (Guidelines: "zod for every external boundary parse — Discord input, Scrypt response") — the `SearchHit[]`/`Note` types come from a zod schema, not a cast.

**Open wire-format gaps (flag to scrypt-side spec, see §6):** the docs confirm transport (`POST /mcp`, `Authorization: Bearer`) and tool names, but do **not** pin (a) whether the server requires an `initialize` handshake / `Mcp-Session-Id` header before `tools/call` (some streamable-http servers are stateful and reject a cold `tools/call`; uxie's per-call model needs a **stateless** server that accepts `tools/call` directly), (b) the exact `tools/call` result envelope shape (`result.content[].text` JSON vs structured), (c) the `/api/ingest` request body field names and the `/api/daily_context` response shape. These are integration contracts to confirm against the live Scrypt Wave 8 server before coding the parsers.

**`/ping` health probe (spec §6.7) is correct:** probe `restClient.health()` (REST `GET /api/health` or shallow `GET /api/daily_context` with a 500ms timeout), **not** the MCP endpoint — streamable-http MCP endpoints do not answer unauthenticated probes and a `tools/call` is heavier than a REST GET.

### 1.9 Graceful degradation when Scrypt is down

The spec's design makes this fall out naturally and correctly — **no extra machinery needed**:

- Backend failure is **module-local** (§3.2): a `ScryptError` thrown from a command is caught at boundary #1 and rendered as `"scrypt unreachable"` (ephemeral). `/ping` keeps working (it reports `scrypt: unreachable`). The bot process stays up. No other module is affected (there are none in v1, but the boundary is preserved for v2).
- **No retries** (§7.4). Idempotency via `client_tag` means the user re-running the command *is* the retry. Automatic retries would create double-capture races and mask outages. Endorse.
- `#inbox` failures react `❌` (fire-and-forget) — the user sees the failure and can re-drop. The deterministic `uxie-msg-<id>` tag means the re-drop dedupes server-side.

The only enhancement worth a v1.5 note: a **boot-time non-fatal Scrypt reachability check** — `index.ts` could call `rest.health()` after login and `log.warn` (not exit) if Scrypt is unreachable, so the operator sees it immediately rather than on first `/capture`. Keep it non-fatal: uxie must boot even if Scrypt is down (plane independence).

### 1.10 Statelessness enforcement + idempotency

**How statelessness is enforced architecturally (not just by convention):**
- No `db`, no cache map, no queue module exists in the file layout — the layout itself is the enforcement. There is no `lib/cache.ts`, no `core/idempotency.ts` (the ideation brief's `idempotency.ts` with a "dedup store" is **rejected** — uxie holds no dedup store; Scrypt owns dedup via `client_tag`).
- `ctx` is per-interaction and discarded; nothing survives a request.
- discord.js caching: the surface doc forbids `Client#sweepers`/`makeCache`/`LimitedCollection`. The default Client cache is unavoidable in discord.js, but uxie **must not read from it as a source of truth** — every command re-fetches from Scrypt. This is the meaningful statelessness rule (no in-memory cache of *results* between interactions).
- **`client_tag` is the entire idempotency story.** `lib/client-tag.ts`: `makeClientTag(i) → "uxie-" + i.id` for interactions, `"uxie-msg-" + msg.id` for inbox. Deterministic, derived only from the Discord id, so retries (user re-runs) produce the same tag and Scrypt dedupes. Uxie implements **zero** local idempotency. (Note: the Scrypt integration context §6 says "generate a **UUID** client_tag", but the Design Spec §5.2 mandates the **deterministic id-derived** form — the deterministic form is correct and is the locked decision; a random UUID would break the retry-dedupe property. This is a real contradiction between docs; the Design Spec wins. Flag in §6.)

### 1.11 Sharding & discord.js v15 readiness

- **Sharding: none in v1, and correctly so.** Single shard until ~2,500 guilds (uxie is single-guild). `ShardingManager`, `Shard`, `Client#shard` are all forbidden. v15 moves `shardCount`/`shards` from `ClientOptions` to `ws.shardIds`/`ws.shardCount` — irrelevant to uxie but noted.
- **v15 migration is designed to be mechanical.** The codebase should be written v15-ready from day one (cheap now, painful later). Concrete v15-safe choices to bake in:
  - `Events` enum members everywhere (not strings).
  - `MessageFlags.Ephemeral` on every reply (never the deprecated `{ ephemeral: true }` boolean — removed on the v15 path; spec §5.1 already mandates this).
  - `setContexts(InteractionContextType.Guild)` + `setIntegrationTypes(ApplicationIntegrationType.GuildInstall)` instead of the removed `setDMPermission`.
  - Named `@discordjs/formatters` functions (`codeBlock`, `bold`, `time`, …) over the legacy `Formatters` aggregate (gone in v15).
  - `AsyncEventEmitter` rejection handling in the router (§1.5) — the single most important v15 prep.
  - `Client#destroy()` for shutdown (supports `Symbol.asyncDispose` in v14.26 — see §1.12).

### 1.12 Boot sequence + graceful shutdown (`src/index.ts`)

The spec's boot sequence is "load env, build client, register commands, login" (§4). Concretely, and adding the shutdown half that the surface doc flags as open (§7-Q3):

```ts
// src/index.ts
const log = createLogger();

process.on("uncaughtException", (e) => { log.error("uncaughtException", { err: e }); process.exit(1); }); // CATCH SITE #3
process.on("unhandledRejection", (e) => { log.error("unhandledRejection", { err: e }); process.exit(1); }); // CATCH SITE #3

let env;
try { env = parseEnv(); }                          // throws ConfigError naming the failed field
catch (e) { log.error("config", { err: e }); process.exit(1); }  // boot-time ConfigError → fatal

const mcp = new ScryptMcpClient(env.SCRYPT_MCP_URL, env.SCRYPT_AUTH);
const rest = new ScryptRestClient(env.SCRYPT_SERVER_URL, env.SCRYPT_AUTH);
const client = createDiscordClient();
const commands = buildCommandCollection(await loadAllCommands());

client.once(Events.ClientReady, (c) => log.info("ready", { tag: c.user.tag }));
client.on(Events.Error, (e) => log.error("client_error", { err: e }));
client.on(Events.InteractionCreate, makeInteractionRouter({ commands, mcp, rest, log }));
client.on(Events.MessageCreate, makeMessageRouter({ rest, log, env }));

const shutdown = async (sig: string) => {          // graceful shutdown — Bun SIGTERM/SIGINT
  log.info("shutdown", { sig });
  await client.destroy();                          // v14.26 Client supports Symbol.asyncDispose
  process.exit(0);
};
process.once("SIGTERM", () => shutdown("SIGTERM")); // Docker stop sends SIGTERM
process.once("SIGINT", () => shutdown("SIGINT"));   // Ctrl-C in dev

await client.login(env.DISCORD_BOT_TOKEN);
```

**Bun graceful shutdown** is the standard `process.once("SIGTERM"/"SIGINT")` → cleanup → `exit(0)` pattern ([Bun OS signals guide](https://bun.sh/guides/process/os-signals); [Hono+Bun SIGTERM discussion](https://github.com/orgs/honojs/discussions/3731)). `client.destroy()` cleanly closes the gateway; because uxie holds no in-flight queue/state, no drain timeout is needed (unlike an HTTP server). Docker `stop` sends SIGTERM then SIGKILL after the grace period — handling SIGTERM lets the bot log a clean exit and close the WS rather than being killed mid-heartbeat. This is the answer to surface-doc open question §7-Q3.

**Command deployment is a separate script, not in the boot path.** `deploy-commands.ts` runs via `bun run deploy` (REST `PUT` to `Routes.applicationGuildCommands(appId, devGuildId)` — instant, per-guild). It is **not** called on every boot — registering commands on each start risks rate limits and is unnecessary since guild commands persist. v1 ships exactly 6 guild commands; the 100-command cap is ample headroom.

### 1.13 The para-raid orchestrator-stub seam

**Recommendation (v1, endorse spec):** `integrations/para-raid/orchestrator-stub.ts` exports a single `dispatch(job)` that throws `new UxieError("not_implemented_v1", "para-raid not wired in v1")`. **No command calls it in v1** — it is dead code whose only job is to (a) reserve the directory + module boundary and (b) prove the boundary holds (no cross-module import). Concrete shape:

```ts
// src/integrations/para-raid/orchestrator-stub.ts
import { UxieError } from "../../lib/errors";

export interface OrchestratorJob {           // the seam shape para-raid will implement
  kind: string;                              // job type discriminator
  payload: unknown;                          // job-specific args (zod-parsed by the real impl)
}
export interface OrchestratorResult { ok: boolean; detail?: string; }

export async function dispatch(_job: OrchestratorJob): Promise<OrchestratorResult> {
  throw new UxieError("not_implemented_v1", "para-raid not wired in v1");
}
```

Defining `OrchestratorJob`/`OrchestratorResult` now (the gap the baseline flags: "seam shape is named but not defined") costs nothing and means para-raid plugs in "without schema changes" (the spec's stated goal, §2). The stub must **not** import from `integrations/scrypt/` — that cross-module import is an explicit anti-pattern. It may import from `lib/` (errors). When para-raid is built, this file becomes its real `dispatch`, and a `registerPararaidIntegration(bot)` is added beside `registerScryptIntegration` — no directory churn.

### 1.14 Config / env loading

The spec's `lib/env.ts` is correct and is the **only** place `process.env` is read. Concrete shape:

```ts
// src/lib/env.ts
import { z } from "zod";

const Schema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APP_ID: z.string().min(1),
  DISCORD_DEV_GUILD_ID: z.string().min(1),
  DISCORD_OWNER_ID: z.string().min(1),
  INBOX_CHANNEL_ID: z.string().min(1),
  USER_TZ: z.string().min(1),                    // IANA tz; could refine with Intl check
  SCRYPT_SERVER_URL: z.string().url(),
  SCRYPT_MCP_URL: z.string().url(),
  SCRYPT_AUTH: z.string().min(1),
});
export type Env = z.infer<typeof Schema>;

let cached: Env | null = null;
export function parseEnv(): Env {
  if (cached) return cached;                      // parseEnv called once at boot; cache for safety
  const r = Schema.safeParse(process.env);        // the ONLY process.env read in the codebase
  if (!r.success) {
    const field = r.error.issues[0]?.path.join(".") ?? "unknown";
    throw new ConfigError("config", `invalid/missing env: ${field}`);  // boot-time fatal
  }
  return (cached = r.data);
}
```

Field names are **verbatim** from Guidelines §17.1 (hard constraint). Bun loads `.env` automatically — **no `dotenv`** (forbidden). The `ConfigError` names the failed field and is fatal at boot (`process.exit(1)` in `index.ts`). Env is then passed explicitly (to client factory, clients, routers) — modules do not re-read `process.env`.

### 1.15 `log.ts` — pick hand-rolled, not pino (resolving the spec's open choice)

The spec leaves it open: "structured JSON logger (**hand-rolled or pino**)". **Recommendation: hand-rolled, ~40 lines.** Rationale:
- **Dependency budget.** The hard constraint is `discord.js` + `zod` as the *only* runtime deps. `pino` (and its transports) would be a third runtime dep for a single-user bot logging to stdout only. Not worth it.
- **Requirements are tiny:** JSON to stdout, three levels (`info`/`warn`/`error`), `child({ interactionId, command })` scoping, and **redaction** of any key containing `BOT_TOKEN`/`AUTH`/`SECRET`/`KEY` → `"[REDACTED]"`. All trivial to hand-roll and trivial to unit-test (redaction needs a test).
- Bun's `console.log` already writes to stdout; the logger is a thin formatter + redactor + child-context merger.

```ts
// src/lib/log.ts — sketch
const REDACT = /BOT_TOKEN|AUTH|SECRET|KEY/i;
function redact(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = REDACT.test(k) ? "[REDACTED]" : v;
  return out;
}
export interface Logger { info: Log; warn: Log; error: Log; child(ctx: object): Logger; }
type Log = (msg: string, fields?: Record<string, unknown>) => void;
export function createLogger(base: object = {}): Logger {
  const emit = (level: string) => (msg: string, fields = {}) =>
    console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...redact({ ...base, ...fields }) }));
  return { info: emit("info"), warn: emit("warn"), error: emit("error"),
           child: (ctx) => createLogger({ ...base, ...ctx }) };
}
```

If structured-log volume ever grows (multi-integration, prod observability), revisit pino at v2. (Conflicts-with-spec: none — the spec explicitly leaves this open.)

### 1.16 `command-builder.ts` — `withOwnerGate` resolves Consistency drift #2

The Consistency Report drift #2 (and baseline gap) is that no command applies the required builder shape. The spec §5.2 / §5.1 already names the fix: `lib/command-builder.ts` exports `withOwnerGate(builder)` applying the three mandatory setters from Guidelines §6.2. This research **endorses** it and gives the concrete signature (suggested plan Task 13.5):

```ts
// src/lib/command-builder.ts
import { SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType } from "discord.js";

export function withOwnerGate(b: SlashCommandBuilder): SlashCommandBuilder {
  return b
    .setContexts(InteractionContextType.Guild)                 // guild-only (v15-safe; replaces setDMPermission)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .setDefaultMemberPermissions(0n);                          // no member can invoke by default; owner gate is runtime
}
```

Every command's `data` is built through this: `data: withOwnerGate(new SlashCommandBuilder().setName("capture").setDescription("…"))`. This is the **defense-in-depth** layer (Discord-side: only guild-installed, default-no-permission) on top of the **runtime** `assertOwner` first-line check. Note the naming caveat: `setDefaultMemberPermissions(0n)` hides the command from non-admins but an admin could still see it — so `assertOwner` at runtime remains the real gate. The builder shape narrows the surface; `assertOwner` is the lock. (Conflicts-with-spec: none — this fills a gap the spec already anticipates.)

---

## 2. Prioritized recommendation table

| # | Recommendation | Priority | Effort | Conflicts spec? |
|---|----------------|----------|--------|-----------------|
| R1 | Keep folder-convention + `register*(bot)`; **no** `core/registry.ts`, **no** `Integration` interface in v1 | v1 | S | No (endorses §3.2) |
| R2 | Define `BotShell` interface (`registerCommands`, `onMessage`) as the host seam | v1 | S | No (names spec's `BotShell`) |
| R3 | DI via per-interaction `ctx` carrying `{ clientTag, log, scrypt: { mcp, rest } }`; clients built once at boot | v1 | M | No (extends §5.1 `CommandContext`) |
| R4 | Router listeners are `async` with whole-body `try/catch`; `replyWithError` never throws (AsyncEventEmitter/v15 prep) | v1 | M | No (hardens §7.2) |
| R5 | Client factory: minimal intents + `Partials.Channel/Message` + `allowedMentions {parse:[]}` | v1 | S | No (= §5.1) |
| R6 | Command loader: `Bun.Glob` for discovery; pure `buildCommandCollection` throws on duplicate | v1 | S | No (= §5.1, Task 11) |
| R7 | Two scrypt clients, per-call `fetch`, hand-rolled JSON-RPC POST (no MCP SDK); single error-map site each; zod-parse all responses | v1 | L | No (= §5.3) |
| R8 | `client_tag` deterministic id-derived (NOT random UUID); zero local idempotency | v1 | S | No re: spec; contradicts integration-context §6 "UUID" |
| R9 | `log.ts` hand-rolled (not pino) with redaction; unit-test redaction | v1 | S | No (spec left open) |
| R10 | `withOwnerGate` builder helper (the 3 mandatory setters) — fixes Consistency drift #2 | v1 | S | No (fills gap; needs plan Task 13.5) |
| R11 | `env.ts` zod schema, `parseEnv()` once, cached, only `process.env` reader; ConfigError names field | v1 | S | No (= §5.2) |
| R12 | Graceful shutdown: `process.once("SIGTERM"/"SIGINT")` → `client.destroy()` → exit(0) | v1 | S | No (fills §7-Q3 gap) |
| R13 | `deploy-commands.ts` standalone script, guild-scoped, NOT in boot path | v1 | S | No (= §5.1) |
| R14 | `orchestrator-stub.ts`: define `OrchestratorJob`/`OrchestratorResult`, `dispatch()` throws; no scrypt import | v1 | S | No (defines named seam) |
| R15 | Use `Events` enum members + `MessageFlags.Ephemeral` everywhere (v15 readiness) | v1 | S | No |
| R16 | Non-fatal boot-time `rest.health()` warn-if-down (operator visibility) | v1.5 | S | No |
| R17 | Confirm Scrypt MCP statelessness (cold `tools/call` w/o `initialize`/session header) + wire envelope before coding parsers | v1 | M | No (integration contract) |
| R18 | Extract `core/` (notifier/channels/registry-loop) ONLY when para-raid ships and duplication is real | v2 | M | No (= §3.2 threshold) |
| R19 | Consider explicit command barrel over glob if silent-drop/order ever bites | v1.5 | S | No (spec mandates glob for v1) |

---

## 3. Conflicts with spec

There are **no recommendations in this research that conflict with the locked Design Spec.** Every item endorses or fills a gap the spec already anticipated. The conflicts that exist are **between docs**, and in each case the Design Spec is the source of truth and wins:

1. **Registry/`core` (ideation brief §7) vs no-registry (Design Spec §3.2).** The Feature Ideation Brief proposed `core/registry.ts` + an `Integration` interface. The Design Spec deliberately overrode this. This research sides with the Design Spec. The ideation brief's shape is the rejected alternative, documented here for traceability — do not resurrect it in v1. (R1, R2, R18.)
2. **`client_tag` random UUID (Scrypt integration context §6) vs deterministic id-derived (Design Spec §5.2).** Integration context says "generate a UUID client_tag"; the Design Spec mandates `uxie-<interaction.id>` / `uxie-msg-<msg.id>`. The **deterministic** form is required for the retry-dedupe property (a random UUID would make every re-run a new write — breaking the "user re-run is the retry" rule in §7.4). Design Spec wins. (R8.) **This contradiction should be reconciled in the docs** (update integration-context §6 to say "deterministic id-derived, not random UUID") per the "update the doc before contradicting code" rule.
3. **`log.ts` hand-rolled vs pino** is not a conflict — the spec explicitly leaves it open ("hand-rolled or pino"). This research picks hand-rolled. (R9.)

The only items that touch the **plan** (not the design) are the two the Consistency Report already flagged: drift #1 (intents — already fixed: drop `DirectMessages`, add `Partials.Message`) and drift #2 (`withOwnerGate` builder shape — needs a new plan Task 13.5). Both are plan patches, not design conflicts.

---

## 4. Open questions

1. **Scrypt MCP statelessness.** Does the Wave 8 streamable-http server accept a cold `tools/call` POST, or does it require an `initialize` handshake + `Mcp-Session-Id` header first? Uxie's per-call model requires the former. If the server is session-stateful, uxie needs either a per-call init+call pair or a lightweight long-lived session — the latter conflicts with the "no long-lived MCP connection" rule and must be escalated. **Must confirm against the live server before coding `mcp-client.ts`.**
2. **MCP `tools/call` result envelope.** Exact shape of `result` — is it MCP-standard `{ content: [{ type: "text", text: "<json>" }] }` (requiring a double-parse), or a structured `result`? Determines the zod parser shape for `SearchHit[]`/`SemanticHit[]`/`Note`.
3. **`/api/ingest` + `/api/daily_context` contracts.** Request body field names for ingest (`kind`, `content`, `client_tag`, `tz`, `meta`?) and the daily-context response shape (`today_journal`, `recent_notes`, `open_threads`, `active_memories`, `tag_cloud`?). The Design Spec §6 assumes these names; confirm against Scrypt's actual REST surface.
4. **`tz` field on `/api/ingest?kind=journal`.** Design §6.5 flags that Scrypt's ingest may not yet accept a `tz` field and may need a scrypt-side change. Confirm whether the journal write must carry `tz`.
5. **`allowedMentions` inheritance.** Confirm in smoke that the Client-level `{ parse: [], repliedUser: false }` is inherited by `editReply` when echoing user content into embeds (surface §7-Q5).
6. **`MessageContent` privileged toggle for unverified bot.** Confirm the dev-portal toggle is sufficient for an unverified bot in ≤100 guilds (surface §7-Q2) — required for `#inbox`.
7. **`Bun.Glob` import-path resolution in the Docker `oven/bun:1-alpine` image.** Confirm `import.meta.dir`-relative dynamic `import()` of globbed `.ts` files works inside the container (vs. needing a build step). If flaky, fall back to the explicit-barrel approach (R19) — this is the one place the glob convention could bite in prod.
8. **Reconcile the two doc contradictions** (registry, client_tag UUID) by editing the source docs before code is written, per SUP §13.

---

## 5. Sources

- **Primary (repo, source of truth):**
  - Design Spec — `/Users/admin/Desktop/Files/uxie/docs/superpowers/specs/2026-04-14-uxie-design.md` (§2 Non-Goals, §3 Architecture, §4 File Layout, §5 Components, §6 Data Flow, §7 Error Handling, §8 Testing)
  - Implementation Plan — `/Users/admin/Desktop/Files/uxie/docs/superpowers/plans/2026-04-14-uxie.md` (Task 9 client, Task 11 command-loader)
  - UXIE-DISCORD-GUIDELINES — `/Users/admin/Desktop/Files/uxie/docs/UXIE-DISCORD-GUIDELINES.md` (§5 intents, §6.2 builder shape, §9 inbox, §14.2 catch sites, §17 env/redaction, §22 anti-patterns)
  - SUP-GUIDELINES — `/Users/admin/Desktop/Files/uxie/docs/SUP-GUIDELINES.md` (§3 plane boundaries, §13 docs-as-truth)
  - discord.js surface — `/Users/admin/Desktop/Files/uxie/docs/discordjs-api-surface.md` (§6 allow/forbid/use-later, §7 open questions)
  - Scrypt Integration Context — `/Users/admin/Desktop/Files/uxie/docs/scrypt-integration-context.md` (§3 12 MCP tools + transport, §6 constraints)
  - Feature Ideation Brief — `/Users/admin/Desktop/Files/uxie/docs/scrypt-feature-ideation.md` (§7 multi-integration — the **rejected** registry/Integration proposal)
  - Spec Consistency Report — `/Users/admin/Desktop/Files/uxie/docs/spec-consistency-report.md` (drift #1 intents, drift #2 builder shape)
- **External (cited):**
  - discord.js command-handling guide — https://discordjs.guide/creating-your-bot/command-handling.html (dynamic command Collection pattern, InteractionCreate + ephemeral error handling)
  - discord.js v14 changes — https://discordjs.guide/legacy/additional-info/changes-in-v14 (Events enum, `message`/`interaction` removed, Partials enum, PascalCase enums)
  - discord.js v15 migration — https://v15.discordjs.guide/additional-info/updating-from-v14 (BaseClient/Shard/Collector now extend `AsyncEventEmitter`; rejected-promise handling) [via WebSearch synthesis, June 2026; site returned 522 on direct fetch]
  - context7 `/discordjs/guide` query — dynamic command handler, InteractionCreate listener, `MessageFlags.Ephemeral` (June 2026)
  - MCP transports explained (stdio vs Streamable HTTP) — https://chatforest.com/guides/mcp-transports-explained/ (single `POST /mcp` endpoint, JSON-RPC, optional SSE upgrade, stateless-capable)
  - MCP transport future — https://blog.modelcontextprotocol.io/posts/2025-12-19-mcp-transport-future/ (streamable-http stateless per-request model)
  - Bun OS signals guide — https://bun.sh/guides/process/os-signals (SIGTERM/SIGINT handling)
  - Hono + Bun graceful shutdown discussion — https://github.com/orgs/honojs/discussions/3731 (`process.once("SIGINT")` → cleanup → exit pattern under Bun)
