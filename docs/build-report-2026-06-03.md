# uxie v1 — Final Build Verification Report

Date: 2026-06-03
Verifier: final-verification pass
HEAD: `acc2716` (Wave 4) — working tree clean

---

## 1. Wave status + SHAs

| Wave | Description | `bun test` | Pass | SHA |
|------|-------------|-----------|------|-----|
| Wave 0 | Scaffold (lib core, config, integrations stub) | green | yes | `27baaa2` |
| Wave 1 | Discord shell, owner gate, REST health client, `/ping` | green | yes | `7d6a03b` |
| Wave 2 | `/capture` + `#inbox` ingestion | green | yes | `efe4a28` |
| Wave 3 | `/search` + `/ask` reads, hand-rolled MCP client | green | yes | `81ea9c8` |
| Wave 4 | `/journal` + `/brief` | green | yes | `acc2716` |

Build halted early: no. All five waves landed.

---

## 2. Test + typecheck totals (re-run at verification)

- `bun test`: **145 pass / 0 fail**, 261 `expect()` calls, across **21 test files**. Runtime ~605ms.
- `bunx tsc --noEmit`: **exit 0** (clean).
- Source files: **26 `.ts` files** under `src/` (+ 2 README.md placeholders).
- Test files: **22** (21 spec files + `tests/helpers.ts`).

---

## 3. Anti-pattern sweep — CLEAN

Every potential violation grep matched only documentation comments (which restate the
prohibition), never live code. Verified against `src/**/*.ts`:

| Anti-pattern | Result |
|--------------|--------|
| `try {` in command bodies (`commands/*.ts`) | NONE — command bodies are catch-free |
| Boolean `ephemeral: true` | NONE in code (only `{ flags: MessageFlags.Ephemeral }`) |
| `process.env` outside `lib/env.ts` | NONE — sole access point is `lib/env.ts` |
| `@modelcontextprotocol/sdk` import | NONE — MCP client is hand-rolled JSON-RPC over `fetch` |
| `crypto.randomUUID` for client_tag | NONE — deterministic `uxie-<id>` / `uxie-msg-<id>` |
| `DirectMessages` / `GuildMembers` intents | NONE — intents are Guilds + GuildMessages + MessageContent only |
| Components V2 builders (Container/Section/TextDisplay) | NONE — classic `EmbedBuilder` only |
| Forbidden deps (axios/node-fetch/dotenv) in `package.json` | NONE — deps are `discord.js@^14.26` + `zod` only |

### Catch-site accounting (decision 10)
Live `} catch` sites in `src/`:
- `bot/interaction-router.ts:49` — whole-body try/catch + never-throwing `replyWithError` whose
  Discord calls are each defensively `.catch()`ed (`safeReply`/`safeEdit`). **Catch site #1.**
- `bot/message-router.ts:35` — boundary swallow+log so a handler bug can't escape into the
  gateway dispatcher. **Catch site #2.**
- `src/index.ts:24` (ConfigError boot) + `process.on("uncaughtException")` +
  `process.on("unhandledRejection")` → log + `process.exit(1)`. **Catch site #3.**
- `integrations/scrypt/inbox-handler.ts:32` + nested `:38` — the message-boundary equivalent of
  `replyWithError` (the user-facing ack is a ✅/❌ reaction, not an editReply). Explicitly
  documented; the message-router itself stays the boundary. The nested catch swallows a
  best-effort failed ❌ react. This is an intentional, documented reaction-ack handler, not drift.
- `rest-client.ts` (`:185/:219/:253`) + `mcp-client.ts` (`:179/:208`) — fetch-error → typed
  `ScryptError` mappers inside the IO clients (the §7.3 mapping layer), not command bodies.
- Promise-style `.json().catch(()=>null)` / `.text().catch(()=>"")` are safe body-parse guards.

Verdict: the three command/boundary catch sites are exactly where decision 10 places them; the
client mappers and the inbox reaction-ack handler are the deliberately-allowed IO/boundary sites.

---

## 4. Completeness audit vs Plan tasks 1–26 (+ 4.5/4.6)

| Task | Deliverable | Status |
|------|-------------|--------|
| 1 | Project scaffolding (package.json, tsconfig, bunfig) | DONE |
| 2 | `lib/env.ts` zod-validated config (sole `process.env`) | DONE |
| 3 | `lib/errors.ts` (UxieError/ScryptError/NotOwnerError/ConfigError) | DONE |
| 4 | `lib/log.ts` single-line JSON + key-substring redaction | DONE |
| 4.5 | `lib/tz.ts` (`today`, `formatLocal`, + `journalDateKey`/`nowInZone`) | DONE |
| 4.6 | `lib/command-builder.ts` `withOwnerGate` + `applyDefaultBuilderShape` | DONE |
| 5 | Placeholder boot + Dockerfile + README | DONE |
| 6 | `lib/auth.ts` owner gate (`assertOwner`) | DONE |
| 7 | `lib/client-tag.ts` deterministic tags | DONE |
| 8 | `rest-client.ts` with `health()` | DONE |
| 9 | `bot/client.ts` Client factory (intents/partials/allowedMentions) | DONE |
| 10 | `tests/helpers.ts` fake interaction/message | DONE |
| 11 | `bot/command-loader.ts` | DONE |
| 12 | `bot/interaction-router.ts` error boundary | DONE |
| 13 | `commands/ping.ts` (REST-only probe, STRING reply) | DONE |
| 14 | `scrypt/index.ts` + `src/index.ts` wiring + `deploy-commands.ts` | DONE |
| 15 | `rest-client.ts` extend with `ingest()` | DONE |
| 16 | `lib/embed.ts` with `captureEmbed` | DONE |
| 17 | `commands/capture.ts` | DONE |
| 18 | `channels.ts` + `message-router.ts` + `#inbox` handler | DONE |
| 19 | `mcp-client.ts` (`searchNotes`/`semanticSearch`/`getNote`) | DONE |
| 20 | `lib/embed.ts` search + semantic embeds | DONE |
| 21 | `commands/search.ts` | DONE |
| 22 | `commands/ask.ts` | DONE |
| 23 | `rest-client.ts` extend with `getDailyContext()` | DONE |
| 24 | `commands/journal.ts` | DONE |
| 25 | `lib/embed.ts` `briefEmbed` | DONE |
| 26 | `commands/brief.ts` + final wiring + smoke ritual | DONE |

All 26/26 (incl. 4.5, 4.6) tasks shipped.

### Folded items / ratified decisions — present

| Folded item | Evidence |
|-------------|----------|
| Catch site #3 — `process.on` uncaught/unhandled | `src/index.ts:12-18` → log + exit(1) |
| Router-located owner gate, BEFORE defer | `interaction-router.ts:44` `assertOwner` precedes `:46` `deferReply`; non-owner uses pre-defer `i.reply` "not for you" (`:65`/`:98`) |
| Deterministic client_tag | `lib/client-tag.ts` `uxie-${i.id}` / `uxie-msg-${m.id}`; same value = log scope + `X-Correlation-Id` |
| Logger `t` / `interactionId` keys + closed vocab | `lib/log.ts`; tested in `tests/lib/log.test.ts` |
| Logger redaction (BOT_TOKEN/AUTH/SECRET/KEY) | recursive serializer; `tests/lib/log.test.ts` |
| 10s / 500ms per-route timeouts (AbortSignal.timeout) | rest `health()` 500ms (`rest-client.ts:179`); ingest/daily 10s; mcp 10s |
| `withOwnerGate` + `applyDefaultBuilderShape` on every builder | all 6 command files import + apply; `command-builder.ts` sets Guild context + GuildInstall + perms `0n` |
| para-raid orchestrator-stub (throws NotImplemented) + README | `src/integrations/para-raid/orchestrator-stub.ts` + `README.md` |
| §7.3 error-mapping contract test | `rest-client.test.ts` covers all 6 codes (auth/server/bad_request/unreachable/timeout/bad_response); `mcp-client.test.ts` covers the applicable subset + `scrypt_tool_error` envelope + zod fail-closed |
| gate-before-defer test | `tests/bot/interaction-router.test.ts` |
| intents/partials test | `tests/bot/client.test.ts` |
| allowedMentions test | all command tests + `client.test.ts` |
| per-route-timeout test | `tests/integrations/scrypt/rest-client.test.ts` (500ms + 10s) |
| logger-redaction test | `tests/lib/log.test.ts` |
| Embeds: classic only, accent `0x5865f2`, http(s) permalink degrade, top-N + AttachmentBuilder overflow (no pagination) | `lib/embed.ts` (`ACCENT`, `asHttpUrl`, `AttachmentBuilder`) |
| /ping enrichment (Status enum, null-safe ws.ping, roundtrip, uptime), STRING reply | `commands/ping.ts` |
| SIGTERM/SIGINT → destroy → exit(0) | `src/index.ts:51-58` |

---

## 5. Known gaps / observations

1. **`DISCORD_APP_ID` is in `env.ts` and `.env.example` but was not in the ratified decision-11
   field list.** This is REQUIRED by `Routes.applicationGuildCommands(appId, guildId)` in
   `deploy-commands.ts` and matches the Plan's Task 14 sketch verbatim. It is a necessary,
   Plan-sanctioned superset — not drift. Operator must set it.
2. **Dockerfile copies `bun.lockb*` / `bunfig.toml*` globs, but the repo uses the text
   `bun.lock` (bun 1.3).** The globs simply don't match; the `RUN bun install --frozen-lockfile
   || bun install` fallback still installs deps. The image builds, but `--frozen-lockfile`
   silently falls through to a non-frozen install (lockfile not copied). MINOR — for fully
   reproducible Docker builds, copy `bun.lock` explicitly. Local `bun run start` is unaffected.
3. **Scrypt-contract BLOCKERS — both handled, no code blockers remain:**
   - *Journal tz unsupported (CONFIRMED):* `/api/ingest` `kind:journal` ignores any tz; server
     stamps UTC. rest-client deliberately does NOT forward `tz` for `journal` (asserted by test
     "does NOT forward tz for journal kind"). `/journal` reply text still renders the USER_TZ-local
     `HH:MM <tz>` via `lib/tz.ts` for the user's benefit — cosmetic only.
   - *Permalink scheme is a best-guess:* `lib/embed.ts` `asHttpUrl()` degrades gracefully — only
     an absolute http(s) URL becomes a tappable title; a raw vault path is shown as plain text.
   - MCP cold `tools/call` VERDICT in the contract = **WORKS** (no initialize handshake, no
     session header). The hand-rolled client issues one bare `tools/call` POST per read with
     `AbortSignal.timeout(10000)` and zod-parses every envelope — matches the contract exactly.
4. **No live integration test against a running Scrypt/Discord** — by design (v1 is unit-tested
   with mocked fetch + fake interactions; live behavior is the manual smoke ritual below).

No hard blockers. The two MINOR items (Dockerfile lockfile glob, APP_ID documentation) do not
block local smoke.

---

## 6. Smoke-readiness — READY

The owner can run the smoke ritual locally given env vars. Steps (from Plan Task 26, Step 6):

### Required env vars (`.env`, validated at boot by `lib/env.ts`)
```
DISCORD_BOT_TOKEN=    # bot token from the Discord developer portal
DISCORD_APP_ID=       # application (client) id — needed by deploy-commands
DISCORD_DEV_GUILD_ID= # the guild to register guild-scoped commands into
DISCORD_OWNER_ID=     # the single allowlisted owner user id
INBOX_CHANNEL_ID=     # channel id watched for passive #inbox capture
USER_TZ=Asia/Kolkata  # IANA tz for /journal + /brief local-date rendering
SCRYPT_SERVER_URL=    # e.g. http://scrypt:3000  (REST writes/health)
SCRYPT_MCP_URL=       # e.g. http://scrypt:3000/mcp  (MCP reads)
SCRYPT_AUTH=          # bearer token for Scrypt (REST + MCP)
```

### Local smoke steps
```bash
# 0. Install + verify
bun install
bun run typecheck && bun test          # expect: tsc exit 0, 145 pass / 0 fail

# 1. Register guild commands (one-time / on command change)
bun run deploy                          # PUTs the 6 commands to DISCORD_DEV_GUILD_ID

# 2. Boot the bot
bun run start                           # logs single-line JSON "uxie ready"

# 3. Happy path (run in the dev guild, all replies ephemeral):
#   /ping                 -> STRING: "uxie alive — status: Ok — heartbeat … — uptime Ns — scrypt: ok — roundtrip …ms"
#   /capture hello world  -> embed with vault path + permalink (notes/inbox/)
#   post text in #inbox   -> ✅ react; note appears in notes/inbox/
#   /ask "discord intents"-> embed with semantic hits (or plain "no matches")
#   /search bun           -> embed with FTS5 hits (or plain "no matches")
#   /journal smoke test   -> "📓 appended to journal/<date>.md at HH:MM <tz>"
#   /brief                -> embed titled with USER_TZ-local date, 5 fields

# 4. Failure modes (resilience):
#   from an ALT account: /ping -> ephemeral "not for you"; main account still works
#   stop scrypt, then /ping    -> "scrypt: unreachable"; bot stays alive
#   with scrypt down, post in #inbox -> ❌ react; bot stays alive
```

Docker path also available: `docker compose up --build` (set `.env` first; see note 2 re lockfile).

### Acceptance (Guidelines §23 "Done-when")
1. All 26 plan tasks ship — YES.
2. Smoke ritual passes against live Scrypt + Discord — pending operator run (env-gated).
3. Guidelines doc zero "TBD" — out of scope of code build.
4. `bun test` green — YES (145/0).
5. Para-RAID seam in place — YES (`integrations/para-raid/orchestrator-stub.ts`).

---

## 7. Verdict

All waves green, 145/145 tests pass, tsc clean, anti-pattern sweep clean, 26/26 tasks + all
folded items present. No hard blockers. Two MINOR cleanups noted (Dockerfile lockfile glob,
APP_ID documentation). The build is smoke-ready: an owner with the nine env vars can run
`bun run deploy && bun run start` and execute the full ritual.
