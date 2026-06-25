# Uxie — Discord Bot Guidelines (v1, SUP integration)

> **Status:** Living. Lock decisions here *before* code. Implementation deviations require updating this doc first.
> **Last updated:** 2026-06-25
> **Maintainer:** sainayan.mahto@goveva.com
> **Audience:** anyone writing or reviewing uxie code, slash commands, or integration modules.
> **Inputs:** `docs/SUP-GUIDELINES.md` (system-wide rules), `docs/discordjs-research.md` (discord.js v14.26.2 facts), `docs/superpowers/specs/2026-04-14-uxie-design.md` (design spec), `docs/superpowers/plans/2026-04-14-uxie.md` (task plan).

---

## 1. Purpose & scope

Uxie is the **User plane** of SUP. One Bun process, one Discord bot, one operator. Today it does two things:

- **onboarding** — event-driven guest onboarding (no slash commands): a guest role on `GuildMemberAdd`, a Components V2 welcome role-picker, and an owner-reviewed role-request flow. See `src/integrations/onboarding/README.md`.
- **server admin + Scrypt ops** — owner-gated slash commands (`/create-category`, `/create-channel`, `/create-role`) and `/ping`, a Scrypt health panel backed by a REST health probe.
- *(deferred)* **Scrypt capture/query** — pending Scrypt's ingestion rework; see §12 and `src/integrations/scrypt/README.md`.
- *(future)* **ops calls** to Para-RAID's `/v1/ops/*`.

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
- **MCP client:** *(removed — deferred)* the hand-rolled JSON-RPC MCP read client was deleted with the capture/query surface (commit `e963939`); the Scrypt v2 rebuild will re-decide its transport. Dep set stays `discord.js` + `zod`.
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

## 5. Gateway intents — minimum

The intent set is the bot's security posture; keep it minimal. Current set (`src/bot/client.ts`):

```ts
intents: [
  GatewayIntentBits.Guilds,        // interactionCreate (slash commands + buttons)
  GatewayIntentBits.GuildMembers,  // PRIVILEGED — guildMemberAdd for onboarding's guest role
],
allowedMentions: { parse: [], repliedUser: false }, // echoed text never pings
// No partials: onboarding state rides on button customIds, not reactions/messages.
```

- **`GuildMembers` is privileged** — enable **SERVER MEMBERS INTENT** in the Developer Portal once. It's the only privileged intent uxie uses, needed for `guildMemberAdd`.
- **No message intents.** `MessageContent` is **not** used and must **not** be enabled — uxie reads no message bodies. `GuildMessages`/`DirectMessages` are likewise off; sending DMs (onboarding grant notices) needs no intent.
- **No `Presence`.** Single-user bot doesn't need presence events.
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
  .setName("create-role")
  .setDescription("Create a role")
  .setContexts(InteractionContextType.Guild)             // explicit
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setDefaultMemberPermissions(0n)                        // owner-only via runtime gate
  .addStringOption(o => o.setName("name").setDescription("role name").setRequired(true));
```

- Always `setContexts` and `setIntegrationTypes`. Never rely on defaults — they have changed across discord API versions.
- `setDefaultMemberPermissions(0n)` hides the command from non-admins in the UI; the runtime owner check is the real authorization.

### 6.3 Registration

- **Dev:** guild-scoped via `Routes.applicationGuildCommands(appId, devGuildId)` — instant.
- **Prod:** still guild-scoped (single dev guild = your personal guild). Global registration is unnecessary and adds discoverability we don't want.
- Registration is a **separate script** (`bun run deploy`) that the bot process never executes at boot. Boot must not depend on Discord HTTP.

### 6.4 Autocomplete

- A candidate for the deferred Scrypt query commands (e.g. search) once they exist and we have query history. Respond within 3s, ≤25 choices.
- Autocomplete handlers live next to the command in the same file, exported as `autocomplete(i)`.
- **No autocomplete today.** Add when query reuse pain shows up.

### 6.5 Modals

- A candidate for any future multi-line/templated capture input. Not used today.

### 6.6 Context-menu commands

- Right-click "Capture to Scrypt" on any message is a future delight, part of the deferred Scrypt v2 surface. The current surface is slash commands + event-driven onboarding only.

---

## 7. Interaction lifecycle — the 3s / 15min contract

| Step | Rule |
|---|---|
| First line of `execute` | `await interaction.deferReply({ flags: MessageFlags.Ephemeral })` for any handler that does network I/O (incl. `/ping`'s Scrypt probe). A Components V2 reply must set `IsComponentsV2` at reply time, so defer first, then `editReply`. |
| Deferred response window | 15 minutes. Edit via `editReply`. Append via `followUp`. |
| Non-deferred reply | Only for a trivially synchronous handler that does no I/O and completes in <3s. |
| Streaming progress | `editReply` with step text. **Edits must be ≥1s apart** to stay under per-route rate budget. |
| Final attachment | If output >1500 chars or contains code fences, post as a `.md` file attachment. Mobile renders markdown attachments natively. |

**Rule:** the moment an interaction handler does anything non-trivially async, the first line is `deferReply`. A non-owner is rejected before the defer (§17.3).

---

## 8. Components V2 — the UI default

### Default: Components V2, ephemeral

- The UI is **Components V2 everywhere** — `/ping`'s health panel, the onboarding welcome role-picker and Approve/Deny cards, every owner-gated reply. Slash-command output is `flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral`.
- Ephemeral replies don't count against rate limits and aren't visible to anyone else — perfect for personal tool output.
- Required mental flip: V2 messages are **mutually exclusive** with `content` and `embeds`. Pick one world per message; you cannot mix (this is also an anti-pattern, §22).

### Shapes to reach for

- "Row + accessory" output (a title + an "Open"/action button) → `SectionBuilder` with a button accessory.
- Grouped panels with an accent bar → `ContainerBuilder`.

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

- **Don't pack wide multi-column layouts** — phones wrap them badly. Keep rows to title + one accessory.
- **Put information in text displays, not decoration** — small accent/footer-style trim is invisible at thumbnail size.
- **Use a Link-style button** when there's a canonical URL — it gives a tappable target on mobile.
- **Don't paste raw code blocks >40 lines** — attach as `.md` instead.

---

## 9. Owner @-mention trigger

**(Removed — commit `e963939`.)** The owner @-mention trigger and its help-overview reply no longer exist; the bot enables no message intents (§5) and reads no message bodies. The owner-facing surface is now slash commands (§6) plus event-driven onboarding. An agentic free-text router may return in a later phase, but it is not part of the current design.

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

Each module owns its folder and carries a `README.md` (the per-module source of truth). For specifics see `src/integrations/*/README.md`.

```
src/
├── bot/                       # discord.js glue (router, client, deploy)
│   ├── client.ts
│   ├── command-loader.ts
│   └── interaction-router.ts  # the one interaction catch-site (commands + buttons)
├── integrations/
│   ├── onboarding/            # event-driven; no slash commands (GuildMemberAdd + buttons)
│   ├── server/                # /create-category, /create-channel, /create-role
│   └── scrypt/                # /ping health panel + rest-client (capture/query deferred — §12)
│       ├── rest-client.ts     # ScryptRestClient: health() probe + connectivity tracking
│       ├── ping/              # ping model + button handler
│       └── commands/ping.ts
└── lib/                       # shared, integration-agnostic
    ├── env.ts                 # zod-validated config
    ├── errors.ts              # UxieError taxonomy
    ├── log.ts                 # structured JSON to stdout
    ├── discord-log-sink.ts    # mirrors warn+error to the owner log channel
    └── auth.ts                # assertOwner
```

### Rules

- **`bot/` knows about `lib/`, never about a specific integration.**
- **Each integration owns its clients.** No shared "scrypt-or-paraRaid" client abstraction. Two integrations = two clients.
- **Render helpers stay pure (no IO)** and are parameterized by data shape, not by integration.
- **An integration is one folder.** Ripping out scrypt should mean deleting `integrations/scrypt/`, dropping its commands from the loader, and nothing else.

---

## 12. Scrypt integration contract

> **Capture/query is DEFERRED.** The capture/query surface and its clients (REST `ingest()`/`getDailyContext()`, the MCP read client) were removed in commit `e963939` pending Scrypt's ingestion rework (Scrypt-side: `feat/ingestion-rework` merged, `feat/journal-rework` in progress). **Do not re-wire against the old contract.** The §12.1–12.3 contract below is retained as the *target* for the v2 rebuild; only the health probe (§12.1) and failure handling (§12.4) are live today. See `src/integrations/scrypt/README.md` and `docs/research/scrypt-contract.md`.
>
> What survives now: the health probe (`ScryptRestClient.health()`), the typed-error seam (`ScryptError` in `src/lib/errors.ts` + the router's `scrypt error` branch), and the auth/timeout rules below.

### 12.1 Writes — REST *(deferred — v2 target)*

- Live today: only the **health probe** — `GET {SCRYPT_SERVER_URL}/api/daily_context` with **500ms** `AbortSignal.timeout`, degrades-don't-crash (returns `{ ok, reason }`, never throws). (The `/api/daily_context` path predates the rework — revisit as part of v2.)
- Auth (all calls): `Authorization: Bearer ${SCRYPT_AUTH}`. The URL must be `https://` or `http://` to a loopback host only (boot-enforced, UX-SEC-002), so the bearer never leaks over plaintext.
- v2 target: writes go to `POST {SCRYPT_SERVER_URL}/api/ingest`, carry a deterministic idempotency `client_tag`, and leave **path/slug ownership with Scrypt** (uxie does not pass `path`/`slug`). Re-confirm the body shape against the new ingest `router`/`kinds` when rebuilding.

### 12.2 Reads — MCP *(removed — deferred)*

- The hand-rolled JSON-RPC MCP read client (`searchNotes`/`semanticSearch`/`getNote`) and `SCRYPT_MCP_URL` were removed with the capture/query surface. The v2 rebuild re-decides the read transport (Scrypt now exposes a `batch-ingest` MCP tool); the **reads-never-write** split (writes via REST, reads never mutate) stays the rule when it returns.

### 12.3 `/api/daily_context` *(deferred — v2 target)*

- The composed daily-context projection (a `/brief`-style read over REST, not MCP) is part of the deferred surface. When rebuilt it targets the new `/api/daily-context` endpoint.

### 12.4 Failure handling

- **Scrypt down → degrade, don't crash.** `/ping` reports degraded and always renders. The bot stays connected to Discord; it never crashes on a Scrypt fault.
- **Connectivity logging.** `health()` logs one `warn` on each up↔down flip (`scrypt connectivity lost` / `restored`), mirrored to the owner log channel (§18). Repeat-down probes stay silent.
- **Typed errors stay the seam.** Scrypt-side faults map to `ScryptError` subclasses (`ScryptTimeoutError` retryable, `ScryptAuthError` not); the router's `scrypt error` branch turns them into ephemeral replies. This seam is kept live for the v2 rebuild even though no command currently throws into it.

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

### 14.2 Catch sites

1. **`bot/interaction-router.ts`** — the single interaction catch-site. Wraps command `execute` and onboarding button handlers in `try/catch`; maps known errors to ephemeral user messages, logs unknowns.
2. **`src/index.ts`** — top-level `process.on('uncaughtException' | 'unhandledRejection')` → log + exit non-zero. Systemd / Docker restarts.

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
- **No queue.** Each interaction either succeeds or fails; the user can retry.
- **No scheduler.** Cron lives in Para-RAID. (The `/ping` auto-retry button uses a transient per-message timer scoped to a single Discord interaction — not a scheduler; it holds no application state and does not survive a restart.)

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
// Required (no default — boot fails if missing):
DISCORD_BOT_TOKEN          // from Developer Portal
DISCORD_APP_ID             // application id
DISCORD_DEV_GUILD_ID       // your test guild
DISCORD_OWNER_ID           // your user id — owner gate
SCRYPT_SERVER_URL          // https://… or http:// to a loopback host only (UX-SEC-002); e.g. http://localhost:3777
SCRYPT_AUTH                // bearer token, 32-byte hex

// Optional (have defaults):
UXIE_ENV                   // deployment label in /ping's Host row; default "local"
ALLOW_SCRYPT_RESTART       // gate the /ping Restart Scrypt button; default false
SCRYPT_RESTART_CMD         // fixed-argv restart command; default "docker compose restart scrypt"
```

### 17.2 Loading

- Local dev: `.env` file at repo root, gitignored. Bun loads automatically.
- Prod: systemd `EnvironmentFile=/opt/secrets/uxie.env` per SUP §6.
- **Never** print env values to logs. The logger redacts on `BOT_TOKEN`, `AUTH`, `SECRET`, `KEY` substring keys.

### 17.3 Owner gate

```ts
// src/lib/auth.ts — assertOwner(interaction, ownerId)
// throws NotOwnerError (with a stable code) when interaction.user.id !== ownerId
```

**Router-located, not in command bodies.** `assertOwner` fires inside `bot/interaction-router.ts` BEFORE `deferReply`/`execute` — so a non-owner is rejected before any work and the command body never re-checks. The non-owner pre-defer path replies "not for you" ephemerally (`reply`, not `editReply`).

---

## 18. Logging & observability

- **Structured JSON to stdout.** One log line = one event. Keys: `t`, `level`, `msg`, plus event-specific fields. `src/lib/log.ts`.
- **Levels:** `debug | info | warn | error`. `error` includes a stack.
- **`interactionId` field** on every log line emitted within a command — lets you grep one user invocation end-to-end.
- **Discord log sink.** `warn`+`error` lines are mirrored to an owner-only Discord channel (`guildConfig.logChannelId`) via `src/lib/discord-log-sink.ts` — pure/injectable, and it never re-logs its own send failures (no feedback loop).
- **No telemetry exporters.** Journald + `journalctl -u uxie -f` per SUP §4. If we ever need histograms, Para-RAID is the place to aggregate.

---

## 19. Testing posture

- **Unit-test pure functions:** env parser, the `/ping` probe→`StatusModel` mapping, error mapping, the onboarding role-pick/approval logic, the log sink.
- **Mock at the seam:** `fetch` for the Scrypt health probe; inject the channel/timer into the log sink; `tests/helpers.ts` exposes `withFetch(impl)` and `fakeInteraction()`.
- **Don't test discord.js itself.** No connecting a real client in tests.
- **Smoke ritual:**
  1. Boot uxie locally against a real bot token.
  2. `/ping` → degraded if Scrypt down, healthy otherwise; Refresh/Retry/Details buttons work.
  3. A new member joins → guest role assigned; welcome role-picker is reachable; a role request posts an Approve/Deny card to the access-requests channel; owner approve grants + DMs.
  4. `/create-category`, `/create-channel`, `/create-role` each succeed for the owner and are rejected for a non-owner.

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
| In-memory cache of vault/query results between interactions | Stateless rule. |
| Re-wiring the deleted Scrypt capture/query clients against the old contract | Deferred pending the ingestion rework — rebuild against the new contract (§12). |
| Mixing `content`/`embeds` with Components V2 in one message | Discord rejects it; runtime error. |
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

Next surface: the deferred Scrypt capture/query rebuild (§12) once the ingestion rework lands, plus its ergonomics (autocomplete, modals, context-menu capture, threads-as-conversations). Each goes through brainstorming, design spec, plan — same loop.

---

## 24. Revision log

- 2026-04-26 — Initial draft. Locks v1 conventions: Bun + discord.js@^14.26, slash-first, owner-gated, stateless, two-client-per-module, three error catch-sites, ephemeral-by-default, `#inbox` passive capture, classic embeds primary with Components V2 as upgrade path.
- 2026-06-05 — Pivot to server-wide, owner-only, @-mention trigger. A mention returns a help overview (auto-deletes ~30s); agentic intent-routing is a later phase. Install profile is now Administrator. Removed the #inbox channel and INBOX_CHANNEL_ID; note capture stays via /capture.
- 2026-06-25 — Reconcile to current code. Removed the @-mention trigger and the six Scrypt commands (`/capture`, `/journal`, `/brief`, `/search`, `/ask`) and the MCP read client + `SCRYPT_MCP_URL` (commit `e963939` + follow-up); Scrypt capture/query is now **deferred** pending the ingestion rework (the `ScryptError` seam is kept). Intents are now `Guilds` + `GuildMembers` (SERVER MEMBERS INTENT) — MESSAGE CONTENT is off. UI is **Components V2 everywhere** (no longer classic-embeds-primary). Surface is event-driven onboarding + `/ping` + `/create-category|channel|role`. Dropped `USER_TZ`; added `UXIE_ENV`/`ALLOW_SCRYPT_RESTART`/`SCRYPT_RESTART_CMD`. Per-module `README.md`s are the source of truth for specifics.
