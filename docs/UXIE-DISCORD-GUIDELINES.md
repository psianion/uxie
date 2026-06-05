# Uxie — Discord Bot Guidelines (v1, SUP integration)

> **Status:** Living. Lock decisions here *before* code. Implementation deviations require updating this doc first.
> **Last updated:** 2026-04-26
> **Maintainer:** sainayan.mahto@goveva.com
> **Audience:** anyone writing or reviewing uxie code, slash commands, or integration modules.
> **Inputs:** `docs/SUP-GUIDELINES.md` (system-wide rules), `docs/discordjs-research.md` (discord.js v14.26.2 facts), `docs/superpowers/specs/2026-04-14-uxie-design.md` (design spec), `docs/superpowers/plans/2026-04-14-uxie.md` (task plan).

---

## 1. Purpose & scope

Uxie is the **User plane** of SUP. One Bun process, one Discord bot, one operator. Its only job is to translate Discord input into:

- **writes** to Scrypt's REST (`POST /api/ingest`)
- **reads** from Scrypt's MCP (`searchNotes`, `semanticSearch`, `getNote`)
- *(future)* **ops calls** to Para-RAID's `/v1/ops/*`

It owns no persistent state. It runs no business logic. It is a **translation layer with an error boundary**, nothing more.

These guidelines turn the design spec and SUP rules into concrete code-shaped conventions every PR must obey.

---

## 2. Plane membership

| Rule | Why |
|---|---|
| Uxie writes to `/vault` only via Scrypt's `POST /api/ingest`. | Scrypt owns the SQLite index. Direct writes break it. |
| Uxie never holds vault content beyond the current interaction. | Stateless. Persistence belongs to Scrypt or Para-RAID. |
| Uxie restarts itself; it does not restart Scrypt or Para-RAID. | Plane separation. Ops belongs to Para-RAID. |
| Uxie may *read* Para-RAID `/v1/ops/*` to surface status, but does not call ops mutations until the explicit ops-console feature ships (see SUP §11 future ideas). | Scope discipline. |

A plane violation is a blocker, not a nit.

---

## 3. Runtime & dependency lock

- **Runtime:** Bun 1.x. No npm. No Node toolchain on the dev or prod machine.
- **Language:** TypeScript, `strict: true`.
- **Test runner:** `bun test`.
- **Discord.js:** `^14.26` (pinned to the v14.26 line). Do **not** adopt v15 pre-release.
- **MCP client:** hand-rolled per-call JSON-RPC `POST` over Bun `fetch` (no `@modelcontextprotocol/sdk`); one `tools/call` per read, `AbortSignal.timeout(10_000)`, zod-parse the response. Dep set stays `discord.js` + `zod`.
- **Validation:** `zod` for env + every external boundary parse (Discord input, Scrypt response).
- **No voice.** `@discordjs/voice` is incompatible with Bun (oven-sh/bun#11313). Voice features are deferred until either Bun fixes opus loading or a clear voice-into-scrypt requirement arrives.

**Forbidden:**
- `node-fetch`, `axios` — use Bun's global `fetch`.
- `dotenv` — Bun loads `.env` automatically; the env loader uses zod to validate.
- Native modules with prebuild ARM headaches (`zlib-sync`, `sodium-native`) until profiling proves a need.

**Why Bun and not Node 22 (against the research's recommendation):** the research's caution was about voice. v1 has no voice. Bun's startup speed and built-in TS execution remove a whole tooling layer (no `tsc`, no `ts-node`, no `tsx`). If voice ever becomes a feature, we re-evaluate.

---

## 4. Bot identity & install profile

- **One bot application.** No multi-bot fan-out. Future channels (Slack, Telegram) get their own translation layer; Uxie stays Discord-only.
- **Install type:** `GuildInstall` to your single dev guild during v1. Add `UserInstall` only when a clear need shows up (e.g., DMing the bot from anywhere).
- **Permissions:** invited with **Administrator** (`permissions=8`). Uxie is a personal, owner-only bot expected to grow to handle everything (including future Para-RAID ops). The security gate is enforced in code via the owner id check, not Discord permission bits.
- **Owner gate:** every interaction handler must check `interaction.user.id === env.DISCORD_OWNER_ID` before doing work. Non-owner → ephemeral "not authorized" reply, no logging beyond `level: warn` with the rejected user id.
- **Public surface = zero.** Bot does not respond to anyone but the owner. No "help everyone" pattern.

---

## 5. Gateway intents — minimum, with v1.5 path

**These intents are UNCHANGED** from the original `#inbox`-era design; only the `messageCreate` handler logic changed (from inbox-channel gate to owner @-mention gate).

```ts
// v1 — slash commands + owner @-mention server-wide
intents: [
  GatewayIntentBits.Guilds,           // required for interactionCreate
  GatewayIntentBits.GuildMessages,    // receive messageCreate for owner @-mention
  GatewayIntentBits.MessageContent,   // PRIVILEGED — must enable in dev portal
],
partials: [Partials.Channel, Partials.Message],
```

- **Drop `DirectMessages` from v1.** All capture happens in slash commands; the owner @-mention handler is guild-only. DMs add an attack surface and another partial.
- **`MessageContent` is privileged but free** for unverified bots (<100 guilds). Enable in the Discord Developer Portal once.
- **Do not add `GuildMembers`.** Single-user bot doesn't need member events.
- **Adding intents requires a doc bump here.** The privileged-intent set is part of the bot's security posture.

---

## 6. Command architecture

### 6.1 File layout

Every command lives at `src/integrations/<module>/commands/<verb>.ts` and exports:

```ts
export type LoadedCommand = {
  data: SlashCommandBuilder;            // declarative spec
  execute(i: ChatInputCommandInteraction): Promise<void>;
};
```

- Commands belong to **modules** (`integrations/scrypt/`, future `integrations/para-raid/`).
- A command never imports from another module. Cross-module needs go through `lib/`.
- The router in `src/bot/interaction-router.ts` is module-agnostic; it dispatches by `commandName`.

### 6.2 Required builder shape

```ts
new SlashCommandBuilder()
  .setName("capture")
  .setDescription("Capture a thought into scrypt")
  .setContexts(InteractionContextType.Guild)             // explicit
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setDefaultMemberPermissions(0n)                        // owner-only via runtime gate
  .addStringOption(o => o.setName("text").setDescription("the content").setRequired(true))
  .addStringOption(o => o.setName("kind").setDescription("note | thought | idea").setChoices(
    { name: "note", value: "note" },
    { name: "thought", value: "thought" },
    { name: "idea", value: "idea" },
  ));
```

- Always `setContexts` and `setIntegrationTypes`. Never rely on defaults — they have changed across discord API versions.
- `setDefaultMemberPermissions(0n)` hides the command from non-admins in the UI; the runtime owner check is the real authorization.

### 6.3 Registration

- **Dev:** guild-scoped via `Routes.applicationGuildCommands(appId, devGuildId)` — instant.
- **Prod:** still guild-scoped (single dev guild = your personal guild). Global registration is unnecessary and adds discoverability we don't want.
- Registration is a **separate script** (`bun run deploy`) that the bot process never executes at boot. Boot must not depend on Discord HTTP.

### 6.4 Autocomplete

- Use for `/search` and `/ask` once we have query history. Respond within 3s, ≤25 choices.
- Autocomplete handlers live next to the command in the same file, exported as `autocomplete(i)`.
- **No autocomplete for v1.** Add when query reuse pain shows up.

### 6.5 Modals

- Use for `/journal` if the input is multi-line or templated. v1 keeps `/journal` as a single-string command (one option). Modals are a v1.5 ergonomics improvement.

### 6.6 Context-menu commands

- Right-click "Capture to Scrypt" on any message is a future delight. v1 ships slash commands + owner @-mention only.

---

## 7. Interaction lifecycle — the 3s / 15min contract

| Step | Rule |
|---|---|
| First line of `execute` | `await interaction.deferReply({ flags: MessageFlags.Ephemeral })` for any handler that touches Scrypt. |
| Deferred response window | 15 minutes. Edit via `editReply`. Append via `followUp`. |
| Non-deferred reply | Only for `/ping` or trivially synchronous commands. Must complete in <3s. |
| Streaming progress | `editReply` with step text ("Searching scrypt…", "Got 12 hits, ranking…"). **Edits must be ≥1s apart** to stay under per-route rate budget. |
| Final attachment | If output >1500 chars or contains code fences, post as a `.md` file attachment. Mobile renders markdown attachments natively. |

**Rule:** the moment an interaction handler does anything non-trivially async, the first line is `deferReply`. No exceptions other than `/ping`.

---

## 8. Embed vs Components V2 — when to use each

### Default: classic embeds, ephemeral

- v1 ships every command with classic embeds + `flags: MessageFlags.Ephemeral`.
- Ephemeral replies don't count against rate limits and aren't visible to anyone else — perfect for personal tool output.
- Limits to remember: title 256, description 4096, fields per embed 25, total chars per message 6000.

### Upgrade to Components V2 when

- The output has clear "row + accessory" shape (a note title + an "Open" button).
- You need >6000 chars or want grid imagery.
- Required mental flip: V2 messages are **mutually exclusive** with `content` and `embeds`. Pick one world per message; you cannot mix.

```ts
await interaction.editReply({
  flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  components: [
    new ContainerBuilder().setAccentColor(0x5865f2).addTextDisplayComponents(
      new TextDisplayBuilder().setContent("**4 hits in scrypt**"),
    ).addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent("`projects/uxie/notes/idea-1.md`\n> First line preview…"))
        .setButtonAccessory(new ButtonBuilder().setLabel("Open").setStyle(ButtonStyle.Link).setURL("…")),
    ),
  ],
});
```

### Mobile rules

- **No 3-column inline embed fields** — phones collapse to 2-wide and they wrap badly.
- **Footer text is invisible at thumbnail size.** Don't put information there.
- **`setURL` on the embed title** gives a tappable header — use it whenever there's a canonical link.
- **Don't paste raw code blocks >40 lines** — attach as `.md` instead.

---

## 9. Owner @-mention trigger

Server-wide, owner-only mention handling via `messageCreate`.

- `messageCreate` handler: if the message is not a direct bot mention (`msg.mentions.has(client.user)`) → ignore. If the mention is `@everyone` or a role ping → ignore. If `msg.author.id !== env.DISCORD_OWNER_ID` → ignore silently.
- On a valid owner @-mention: reply in-channel with a help overview embed listing all six commands (`/ping`, `/capture`, `/search`, `/ask`, `/journal`, `/brief`), then delete that reply after ~30s using a transient `setTimeout`. No state is retained.
- There is no dedicated `#inbox` channel. Note capture uses the `/capture` slash command.
- **Future:** this handler becomes an agentic parser that interprets the owner's free-text message and routes it to the appropriate command or module.

---

## 10. Threads as conversations

For multi-turn flows (planned: `/research <topic>`, `/draft <intent>`):

- Slash command spawns a **private thread** off the invoking channel.
- `autoArchiveDuration: 10080` (7 days) so phone notifications die naturally.
- Thread title = task name, prefixed `[uxie]` for filtering.
- Bot posts progress as `channel.send` messages inside the thread; `editReply` is the initial ack only.
- Threads are not v1; document the pattern so we don't accidentally invent a different convention later.

---

## 11. Module pattern — pluggable integrations

```
src/
├── bot/                       # discord.js glue (router, client, deploy)
│   ├── client.ts
│   ├── command-loader.ts
│   ├── interaction-router.ts
│   └── message-router.ts
├── integrations/
│   ├── scrypt/                # v1 active module
│   │   ├── rest-client.ts     # ScryptRestClient: health, ingest, getDailyContext
│   │   ├── mcp-client.ts      # ScryptMcpClient: searchNotes, semanticSearch, getNote
│   │   ├── channels.ts        # isInboxChannel(id, env)
│   │   ├── inbox-handler.ts
│   │   ├── orchestrator-stub.ts  # dispatch() throws — seam for para-raid
│   │   └── commands/
│   │       ├── ping.ts
│   │       ├── capture.ts
│   │       ├── search.ts
│   │       ├── ask.ts
│   │       ├── journal.ts
│   │       └── brief.ts
│   └── para-raid/             # placeholder; populated when ops console ships
└── lib/                       # shared, integration-agnostic
    ├── env.ts                 # zod-validated config
    ├── errors.ts              # UxieError taxonomy
    ├── log.ts                 # structured JSON to stdout
    ├── tz.ts                  # USER_TZ helpers for /journal
    └── embed.ts               # render helpers
```

### Rules

- **`bot/` knows about `lib/`, never about a specific integration.**
- **Each integration owns its REST/MCP clients.** No shared "scrypt-or-paraRaid" client abstraction. Two integrations = two clients.
- **`lib/embed.ts`** holds renderers parameterized by data shape, not by integration. Renderers stay pure (no IO).
- **An integration is one folder.** Ripping out scrypt should mean deleting `integrations/scrypt/`, dropping its commands from the loader, and nothing else.

---

## 12. Scrypt integration contract

### 12.1 Writes — REST

- Endpoint: `POST {SCRYPT_SERVER_URL}/api/ingest`
- Auth: `Authorization: Bearer ${SCRYPT_AUTH}` over Tailscale (TCP).
- Body shape (per `/scrypt/src/server/api/ingest.ts`): `{ kind, content, client_tag, ...kindSpecific }`.
- **Every write carries a `client_tag`.** v1 uses a deterministic tag: `uxie-<interaction.id>` for slash commands; the `uxie-msg-<msg.id>` form (via the retained `makeMessageClientTag` helper) is reserved for owner @-mention-originated Scrypt writes (the future agentic path). The same value is the log scope field and `X-Correlation-Id`. Scrypt is idempotent on `client_tag`.
- **Path/slug ownership stays with Scrypt.** Uxie does not pass `path` or `slug`.
- Timeout: **10s default** for all Scrypt REST/MCP calls (per Design §304); the lightweight `/ping` health probe uses **500ms**. Over budget → `ScryptTimeoutError` → user-friendly ephemeral reply.

### 12.2 Reads — MCP

- Transport: hand-rolled `POST {SCRYPT_MCP_URL}` JSON-RPC `tools/call` with `Authorization: Bearer ${SCRYPT_AUTH}` + `Content-Type: application/json`. No SDK. (Pending Phase-0 confirmation that the server accepts a cold `tools/call` with no `initialize` handshake.)
- Tools allowed v1: `searchNotes`, `semanticSearch`, `getNote`.
- Tools forbidden v1: any write tool (`create_note`, `update_note_metadata`, `add_edge`, etc.) — writes go through REST. Mixing the two creates two write paths and breaks idempotency reasoning.
- Connection lifecycle: **lazy, per-call**. The MCP client opens the streamable-http stream when called and closes after the response. Do not keep a long-lived MCP connection — its failure modes are harder to reason about than reconnecting per call.

### 12.3 `/api/daily_context`

- Used by `/brief`. GET, no body. Response is `{ today_journal, recent_notes[], open_threads[], active_memories[], tag_cloud[] }`.
- This endpoint is the only Scrypt read that goes via REST (not MCP) because it's a composed projection that doesn't fit the MCP tool model.

### 12.4 Failure handling

- **Scrypt down → degrade, don't crash.** `/ping` reports degraded. Other commands ephemerally reply "scrypt is down — try again in a minute." Bot stays connected to Discord.
- **Token rejected (401) → loud failure.** Ephemeral reply naming the env var. This is a misconfiguration, not a transient.

---

## 13. Para-RAID integration (future)

Placeholder folder ships in v1 (`integrations/para-raid/orchestrator-stub.ts` exporting a `dispatch()` that throws `NotImplemented`). The seam is locked now to avoid retrofit later.

When the ops console feature lands:

- Module owns `OpsClient` (`/v1/ops/status`, `/v1/ops/rebuild`, `/v1/ops/logs`).
- Slash commands live under `integrations/para-raid/commands/`: `/sup status`, `/sup rebuild <service>`, `/sup logs <service>`.
- All ops mutations require **explicit confirmation modal** before firing — `rebuild` is destructive enough to deserve "are you sure" friction.
- Same auth model: bearer token over Tailscale.

This section is forward-looking. v1 ships only the stub.

---

## 14. Error handling

### 14.1 Taxonomy (in `src/lib/errors.ts`)

```ts
export class UxieError extends Error {}
export class ConfigError extends UxieError {}        // env / startup misconfig
export class NotOwnerError extends UxieError {}      // owner-gate failure
export class ScryptError extends UxieError {}        // any scrypt-side fault
export class ScryptTimeoutError extends ScryptError {}
export class ScryptAuthError extends ScryptError {}
export class ScryptBadRequestError extends ScryptError {}
```

Specific subclasses for retryability — `Timeout` is retryable, `Auth` is not.

### 14.2 Catch sites — exactly three

1. **`bot/interaction-router.ts`** — wraps `command.execute` in `try/catch`. Maps known errors to ephemeral user messages; logs unknowns.
2. **`bot/message-router.ts`** — wraps `messageCreate` handlers. Reacts ❌ on failure.
3. **`src/index.ts`** — top-level `process.on('uncaughtException' | 'unhandledRejection')` → log + exit non-zero. Systemd / Docker restarts.

**No `try/catch` inside command bodies.** Throw with the right error class; the router decides the user-visible message. Multi-catch within a command is a code smell.

### 14.3 User messages

| Error | User sees |
|---|---|
| `NotOwnerError` | "you're not the owner of this bot." |
| `ScryptTimeoutError` | "scrypt didn't respond in time. try again." |
| `ScryptAuthError` | "scrypt rejected my token — check `SCRYPT_AUTH` on the box." |
| `ScryptBadRequestError` | the upstream message from Scrypt, prefixed `scrypt:`. |
| Unknown `Error` | "something broke. logs have details." |

All ephemeral. Never expose stack traces to Discord.

---

## 15. Stateless rule & graceful degradation

- **No in-memory caches** of vault content, search results, or user state across interactions.
- **No on-disk storage** outside what Bun and discord.js need (the gateway sequence file).
- **No queue.** A capture either succeeds or fails via `/capture`; the user can retry.
- **No scheduler.** Cron lives in Para-RAID.
- **Carve-out:** the owner @-mention help reply uses a `~30s setTimeout` to self-delete. This is a transient UX timer scoped to a single Discord message object — not a scheduler, queue, or cron. It holds no application state and does not survive a restart.

If Scrypt is down for 10 minutes, Uxie should:
- Stay connected to Discord (keep gateway open).
- Reply "scrypt is down" to slash commands.
- Surface the state in `/ping`.
- **Not** crash, restart, or accumulate work. Just keep saying no until Scrypt comes back.

---

## 16. Rate limits & response hygiene

- Global budget: 50 req/sec across all routes per token. Trivial for v1.
- Invalid request budget: 10k 401/403/429 in 10 min → temp ban. Owner-gate failures don't count (handler returns early without an HTTP call).
- **Debounce `editReply` to ≥1s.** Rapid progress edits during streaming will eat the per-route budget.
- **Prefer ephemeral.** They don't count.
- **Don't hammer audit-log routes.** v1 doesn't touch audit log at all.

---

## 17. Secrets & config

### 17.1 Env loader

`src/lib/env.ts` — single source of truth. Zod schema. Validated at boot. Validation failure → process exits 1 with the failed field name. **No env access outside this module.**

Required fields:

```ts
DISCORD_BOT_TOKEN          // from Developer Portal
DISCORD_APP_ID             // application id
DISCORD_DEV_GUILD_ID       // your test guild
DISCORD_OWNER_ID           // your user id — owner gate
SCRYPT_SERVER_URL          // e.g. http://scrypt.tail-xxxx.ts.net:3000
SCRYPT_MCP_URL             // e.g. http://scrypt.tail-xxxx.ts.net:3000/mcp
SCRYPT_AUTH                // bearer token, 32-byte hex
USER_TZ                    // IANA tz, e.g. "Asia/Kolkata"
```

### 17.2 Loading

- Local dev: `.env` file at repo root, gitignored. Bun loads automatically.
- Prod: systemd `EnvironmentFile=/opt/secrets/uxie.env` per SUP §6.
- **Never** print env values to logs. The logger redacts on `BOT_TOKEN`, `AUTH`, `SECRET`, `KEY` substring keys.

### 17.3 Owner gate

```ts
// src/lib/auth.ts
function assertOwner(actorId: string, ownerId: string) {
  if (actorId !== ownerId) throw new NotOwnerError(`rejected user ${actorId}`);
}
```

**Router-located, not in command bodies.** `assertOwner` fires inside `bot/interaction-router.ts` and `bot/message-router.ts` BEFORE `deferReply`/`execute` — so a non-owner is rejected before any work and the command body never re-checks. The non-owner pre-defer path replies "not for you" ephemerally (`reply`, not `editReply`).

---

## 18. Logging & observability

- **Structured JSON to stdout.** One log line = one event. Keys: `t`, `level`, `msg`, plus event-specific fields.
- **Levels:** `debug | info | warn | error`. `error` includes a stack.
- **`interactionId` field** on every log line emitted within a command — lets you grep one user invocation end-to-end.
- **No telemetry exporters in v1.** Journald + `journalctl -u uxie -f` per SUP §4. If we ever need histograms, Para-RAID is the place to aggregate.

---

## 19. Testing posture

- **Unit-test pure functions:** env parser, embed renderers, channel filter, error mapping, tz helpers.
- **Mock at the seam:** `fetch` for REST, `Transport` for MCP. `tests/helpers.ts` exposes `withFetch(impl)` and `fakeInteraction()`.
- **Don't test discord.js itself.** No connecting a real client in tests.
- **Smoke ritual** is the v1 acceptance:
  1. Boot uxie locally against a real bot token.
  2. `/ping` → degraded if Scrypt down, healthy otherwise.
  3. `/capture` → note appears in vault.
  4. @-mention uxie in any channel → help overview reply appears, auto-deletes after ~30s.
  5. `/search`, `/ask`, `/journal`, `/brief` each return non-empty embeds.

Smoke is documented in `docs/superpowers/specs/2026-04-14-uxie-design.md` §8.4.

---

## 20. Deployment shape

### 20.1 Local dev

- Docker Desktop. `Dockerfile` based on `oven/bun:1`. `docker-compose.yml` exposes nothing (gateway is outbound-only).
- `bun run dev` outside Docker for fast iteration. Docker is the prod-shape rehearsal.

### 20.2 Prod (target: SUP VPS)

- Dockerized, run by `docker-compose` alongside Scrypt and Para-RAID.
- `restart: unless-stopped`. Uxie crashes are normal-recovery.
- Logs to journald via Docker's `journald` driver.
- Update flow: per SUP §7. `update-uxie.sh` runs the SUP update invariants.

### 20.3 Single shard

- v1 is single-shard. Sharding is irrelevant below ~2000 guilds. We have one.

---

## 21. Versioning & v15 readiness

- Pin `discord.js@^14.26`. Update on patch; review on minor.
- v15 is **not** for production. When it stabilizes, the lift is:
  - Rename `Events.ClientReady` listener (was `"ready"`, becomes `"clientReady"`).
  - Swap `Events.WebhooksUpdate` string.
  - Replace `ActionRow.from()` → `ActionRowBuilder.from()`.
  - Replace `ApplicationCommand#dmPermission` → `setContexts`.
- The codebase already follows v15-ready patterns: no `dmPermission`, explicit `setContexts`, `ActionRowBuilder.from()` only. Migration should be a few-line PR.

---

## 22. Anti-patterns — refuse to build

| Anti-pattern | Reason |
|---|---|
| Public bot mode (any non-owner can use commands) | Plane breach + threat model. |
| In-memory cache of search results between interactions | Stateless rule. |
| Long-lived MCP connection across interactions | Reconnection failure modes are harder than per-call. |
| Mixing classic content/embeds with Components V2 in one message | Discord rejects it; runtime error. |
| Direct vault writes (`fs.writeFile` on `/vault`) | Plane breach §3 of SUP-GUIDELINES. |
| Cross-module imports (`integrations/scrypt` ↔ `integrations/para-raid`) | Coupling that defeats the seam. |
| `try/catch` inside command bodies | Error-router boundary is the only catch site. |
| Reading env vars outside `lib/env.ts` | One source of truth. |
| Replying non-ephemerally for personal output | Ephemeral is the default; loud is opt-in. |
| `interaction.reply` >3s after receipt without `deferReply` | Discord drops the interaction. |
| Adding a privileged intent without updating §5 of this doc | Security posture must be tracked. |

---

## 23. Done-when

v1 is "done" when:

1. All 26 plan tasks ship per `docs/superpowers/plans/2026-04-14-uxie.md`.
2. Smoke ritual (§19) passes against a live Scrypt + Discord guild.
3. This guidelines doc has zero "TBD" markers.
4. `bun test` is green.
5. The seam for Para-RAID (`integrations/para-raid/orchestrator-stub.ts`) is in place.

After v1: open the v1.5 list — modals for `/journal`, autocomplete for `/search`, context-menu capture, threads-as-conversations. Each goes through brainstorming, design spec, plan — same loop.

---

## 24. Revision log

- 2026-04-26 — Initial draft. Locks v1 conventions: Bun + discord.js@^14.26, slash-first, owner-gated, stateless, two-client-per-module, three error catch-sites, ephemeral-by-default, `#inbox` passive capture, classic embeds primary with Components V2 as upgrade path.
- 2026-06-05 — Pivot to server-wide, owner-only, @-mention trigger. A mention returns a help overview (auto-deletes ~30s); agentic intent-routing is a later phase. Install profile is now Administrator. Removed the #inbox channel and INBOX_CHANNEL_ID; note capture stays via /capture.
