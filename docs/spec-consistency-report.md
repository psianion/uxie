# Uxie Spec Consistency Report

**Audit date:** 2026-04-26
**Audited:** `docs/superpowers/specs/2026-04-14-uxie-design.md`, `docs/superpowers/plans/2026-04-14-uxie.md`
**Authoritative:** `docs/SUP-GUIDELINES.md`, `docs/UXIE-DISCORD-GUIDELINES.md`, `docs/discordjs-api-surface.md`

---

## §1 Verdict

Design needs a small bump and the plan needs targeted patches before execution. The architecture and module shape are sound and the 26 tasks decompose cleanly to the design components, but **15 drift items** (1 L, 8 M, 6 S) and **6 gaps** sit on the boundary between v14.26 surface, plane rules, and operating doc. None are structural — all fixable by editing 6 tasks plus a handful of design lines, no new wave required.

**2026-06-03 addendum (deep-research pass):** four further drifts (#17–#20) surfaced during the pre-build research workflow — all spec-internal contradictions the original audit missed, and all four are now **resolved** by edits to `UXIE-DISCORD-GUIDELINES.md`: hand-rolled MCP client (§3/§12.2), deterministic `client_tag` (§12.1), `t`/`interactionId` logger keys (§18), and 10s/500ms timeouts (§12.1).

---

## §2 Drift list

Sorted by impact: L → M → S.

| # | Flavor | File:loc | What | Impact | Fix |
|---|---|---|---|---|---|
| 1 | Operational-rule contradiction | `plans/2026-04-14-uxie.md` Task 9 (line 770–778) + `specs/2026-04-14-uxie-design.md` §5.1 (line 149) | Both wire `GatewayIntentBits.DirectMessages` and only `Partials.Channel`. UXIE-DISCORD-GUIDELINES §5 explicitly drops `DirectMessages` from v1 and mandates `Partials.Channel` AND `Partials.Message`. Design §6 `slash / DM / channel msg` line and §5.4 README "any future DM-capture flow" note also assume DMs are in scope. | L | Task 9 — remove `GatewayIntentBits.DirectMessages`, add `Partials.Message`. Design §5.1 — drop `DirectMessages`, add `Partials.Message` and a one-line "DM capture deferred to v1.5 per UXIE-GUIDELINES §5". |
| 2 | Operational-rule contradiction | `plans/2026-04-14-uxie.md` Task 9 (no builder mods), Task 13 ping, Task 16 capture, Task 21 search, Task 22 ask, Task 24 journal, Task 26 brief | Every `SlashCommandBuilder` in the plan is built with `.setName().setDescription()` only. UXIE-DISCORD-GUIDELINES §6.2 requires `.setContexts(InteractionContextType.Guild)`, `.setIntegrationTypes(ApplicationIntegrationType.GuildInstall)`, `.setDefaultMemberPermissions(0n)` on every command. Design §5 doesn't even mention these. | M | Add a single shared `applyDefaultBuilderShape(builder)` helper in Wave 1 (extend Task 13 or insert Task 13.5). Update every command task to call it. Design §5.1 needs one paragraph naming the three required setters. |
| 3 | Operational-rule contradiction | `plans/2026-04-14-uxie.md` Task 12 lines 1033, 1040, 1046, 1051 | Uses `{ ephemeral: true }` boolean field. UXIE-DISCORD-GUIDELINES §7 + §8 require `{ flags: MessageFlags.Ephemeral }`. The boolean form is deprecated in v14.26 and removed on the v15 path. | M | Task 12 — replace every `ephemeral: true` with `flags: MessageFlags.Ephemeral`; add `import { MessageFlags } from "discord.js"`. Same in any `i.reply` site. |
| 4 | Operational-rule contradiction | `plans/2026-04-14-uxie.md` (whole) — no `process.on` in any task | UXIE-DISCORD-GUIDELINES §14.2 requires three catch sites; the third is a top-level `process.on('uncaughtException' \| 'unhandledRejection')` in `src/index.ts`. Design §7.2 lists three catch sites but uses `src/index.ts` boot for `ConfigError` only — does not require process-level rejection handler. Plan never adds it. | M | Insert a step into Task 14 (`src/index.ts` wiring) that registers `process.on('uncaughtException', ...)` and `process.on('unhandledRejection', ...)` → log + `process.exit(1)`. Bump Design §7.2 catch site #1 to read "boot + process-level". |
| 5 | Operational-rule contradiction | `plans/2026-04-14-uxie.md` Task 4 `lib/log.ts` (entire task) | Logger has no redaction. UXIE-DISCORD-GUIDELINES §17.2 requires the logger to redact any field whose key contains `BOT_TOKEN`, `AUTH`, `SECRET`, or `KEY`. | M | Add a `serializeField` substring check + redact step + a failing test "redacts SCRYPT_AUTH value" to Task 4. |
| 6 | Plane breach (latent) | `specs/2026-04-14-uxie-design.md` §4 file layout (line 104–142) + plan Task 14 commit (line `src/integrations/scrypt/orchestrator-stub.ts`) | Stub lives at `src/integrations/scrypt/orchestrator-stub.ts`. UXIE-DISCORD-GUIDELINES §11 mandates the seam at `src/integrations/para-raid/orchestrator-stub.ts` so the para-raid integration directory exists from day 1. Putting it under `scrypt/` couples scrypt module to a para-raid concern. | M | Task 14 — create the file at `src/integrations/para-raid/orchestrator-stub.ts` instead, plus an `src/integrations/para-raid/README.md` placeholder. Design §5.3 — drop the orchestrator-stub bullet; add a §5.4 `integrations/para-raid/` placeholder entry. |
| 7 | Stale reference | `plans/2026-04-14-uxie.md` Task 1 line ~ `"discord.js": "^14.16.0"` | UXIE-DISCORD-GUIDELINES §3 + discordjs-api-surface §3 v15 matrix pin to `^14.26`. The earlier 14.16 baseline misses `Events.ClientReady` constant string change, `Message#interactionMetadata`, and the v15 forward-compat constants. | M | Bump dep to `"discord.js": "^14.26.0"`. |
| 8 | Operational-rule contradiction | `specs/2026-04-14-uxie-design.md` §5.2 env list (line ~ "SCRYPT_BEARER") + plan Task 2 fixture (line 175 + 192 `SCRYPT_BEARER`) | Env field is named `SCRYPT_BEARER`. UXIE-DISCORD-GUIDELINES §17.1 names it `SCRYPT_AUTH` (matches SUP §6 secret layout's `SCRYPT_AUTH_TOKEN`). Same drift on `SCRYPT_REST_URL` (guidelines: `SCRYPT_SERVER_URL`) and `OWNER_DISCORD_ID` (guidelines: `DISCORD_OWNER_ID`). | M | Rename in Task 2 zod schema, Task 5 `.env.example`, Task 8 rest-client constructor, Task 11 mcp-client, every test fixture. Design §5.2 — same renames. |
| 9 | Gap | `plans/2026-04-14-uxie.md` (whole) — no Task creates `src/lib/tz.ts` | UXIE-DISCORD-GUIDELINES §11 module map lists `lib/tz.ts` ("USER_TZ helpers for /journal"). Plan Task 24 (journal) and Task 26 (brief) just pass `env.USER_TZ` through verbatim — fine for `/journal`, but `/brief` formatting "today's date" needs a tz-aware helper. Design §5.2 lib list also omits `tz.ts`. | M | Add a small Task 23.5 (or extend Task 24 Step 1) creating `src/lib/tz.ts` with `today(tz)`, `formatLocal(date, tz)` + tests. Design §5.2 — add the bullet. |
| 10 | NEVER violation (latent) | `plans/2026-04-14-uxie.md` Task 13 ping (line ~ test fixture) | Ping command body never reads gateway latency. discordjs-api-surface §3 calls out that `client.ws.ping` is renamed `Client#ping` in v15 and can be `null` until first heartbeat. Plan does not pin a v15-safe shape. Not strictly a NEVER hit because the symbol isn't used at all — but the guideline §6 ping shape is `client.ping ?? -1`. | S | If `/ping` should display gateway latency, add `client.ping ?? -1`. If not, leave a comment in Task 13 stating "intentionally omits gateway latency". |
| 11 | Stale reference | `specs/2026-04-14-uxie-design.md` §3.2 ("Backend failure is module-local… `http://scrypt:3777`") + plan Task 5 docker-compose | Both pin scrypt port to `3777`. UXIE-DISCORD-GUIDELINES §17.1 example uses `:3000`. Not a true contradiction (port is a config var) but the dev URL fixture should match the guideline example to avoid confusion. | S | Either align fixture port to `3000` in plan + design, or add a one-line note in design §5.2 "port is configurable; guideline uses 3000, dev fixture uses 3777". |
| 12 | Stale reference | `specs/2026-04-14-uxie-design.md` §5.3 ("the three MCP tools the read commands need: `searchNotes`, `semanticSearch`, `getNote`") | Matches UXIE-GUIDELINES §11 + scrypt's MCP tool list; included as positive cross-check. **No drift** — listed for completeness. | — | n/a |
| 13 | Operational-rule contradiction | `plans/2026-04-14-uxie.md` Task 12 error router | The router catches inside command bodies via the test stubs but the production interaction-router is correctly the only catch. The plan does not, however, explicitly add a "do not add try/catch in command bodies" guardrail in any later task or PR review checklist. UXIE-GUIDELINES §22 lists this as anti-pattern. | S | Add a one-line note in Task 17 (capture), Task 21 (search), Task 22 (ask), Task 24 (journal), Task 26 (brief) Step 3: "no try/catch in command body — let the router boundary handle it." Or add a single Wave-end review task. |
| 14 | Stale reference | `specs/2026-04-14-uxie-design.md` §6.5 `/journal` flow ("plain text, no embed") | Acceptable; matches UXIE-GUIDELINES §8 ephemeral default. Listed as positive cross-check. **No drift.** | — | n/a |
| 15 | Operational-rule contradiction (light) | `specs/2026-04-14-uxie-design.md` §8.4 smoke ritual + plan Task 26 Step 6 | Both list 7 happy-path checks. UXIE-GUIDELINES §19 (smoke ritual) requires also confirming "owner-gate fail = ephemeral 'not for you'" and "scrypt-down → ✅ status reported, no crash". The plan Task 26 includes these in comments; design §8.4 does not. | S | Bump design §8.4 to add the two failure-mode steps explicitly. |
| 16 | Stale reference | `plans/2026-04-14-uxie.md` Task 12 helper update | The fake interaction stub uses `replied: false / deferred: false` flat fields — fine for tests, but `i.reply` ephemeral path uses the deprecated boolean field. Will surface as deprecation warning at runtime under v14.26. | S | Same fix as drift #3 — replace boolean ephemeral with `flags: MessageFlags.Ephemeral`. |
| 17 | Operational-rule contradiction (blocking) | `UXIE-DISCORD-GUIDELINES.md` §3 (line 44) + §12.2 (line 274) vs `plans/2026-04-14-uxie.md` Task 1 dep-lock + `specs/2026-04-14-uxie-design.md` §357/§209 | Guidelines mandated `@modelcontextprotocol/sdk` / `StreamableHTTPClientTransport`, but the Plan dep-lock is `discord.js`+`zod` only and Design describes a hand-rolled `fetch` client. Surfaced by the 2026-06-03 deep-research pass. | L | **RESOLVED 2026-06-03** — hand-roll chosen; §3 + §12.2 edited to a per-call JSON-RPC `POST` over `fetch`. Open: confirm Scrypt accepts a cold `tools/call` (build Phase 0). |
| 18 | Operational-rule contradiction | `UXIE-DISCORD-GUIDELINES.md` §12.1 (line 268) vs `specs/2026-04-14-uxie-design.md` §5.2 | Guidelines used `crypto.randomUUID()` for the slash-command `client_tag`, contradicting the locked deterministic `uxie-<id>` (the single idempotency / correlation / trace key). Surfaced by deep-research pass. | M | **RESOLVED 2026-06-03** — §12.1 edited to deterministic `uxie-<interaction.id>` / `uxie-msg-<msg.id>`. |
| 19 | Operational-rule contradiction | `UXIE-DISCORD-GUIDELINES.md` §18 (lines 410, 412) vs Task 4 test + `specs/2026-04-14-uxie-design.md` §5.2 | Guidelines logged `ts` / `interaction_id`; the locked Task 4 test + Design §5.2 use `t` / `interactionId`. The logger would fail its own test. Surfaced by deep-research pass. | M | **RESOLVED 2026-06-03** — §18 edited to `t` / `interactionId`. (`LOG_LEVEL` env field deferred to v1.5.) |
| 20 | Operational-rule contradiction (light) | `UXIE-DISCORD-GUIDELINES.md` §12.1 (line 270) vs `specs/2026-04-14-uxie-design.md` §304 | Guidelines set 5s default / 10s `/journal`; Design standardizes 10s default / 500ms health probe. Surfaced by deep-research pass. | S | **RESOLVED 2026-06-03** — §12.1 edited to 10s default + 500ms health. |

**Drift counts by flavor:**
- NEVER violations: 1 (latent — drift #10)
- Plane breaches: 1 (drift #6)
- Operational-rule contradictions: 12 (#1, #2, #3, #4, #5, #8, #13, #15, #17, #18, #19, #20)
- Gaps: 1 (#9)
- Stale references: 3 (#7, #11, #16)

(Two rows — #12 and #14 — are positive cross-checks kept in-table for traceability.)
(Drifts #17–#20 were surfaced by the 2026-06-03 deep-research pass and resolved the same day; impact spread +1 L / +2 M / +1 S.)

---

## §3 Coverage confirmed

Things the audit verified are correct and need no change:

- The 26 plan tasks decompose cleanly to design §5 components: every component in §5.1 (`bot/`), §5.2 (`lib/`), §5.3 (`integrations/scrypt/`) has at least one owning task. The plan's own self-review (line ~ "Spec coverage check") tracks this.
- Every command in design §6 has a task: §6.1 capture (Task 17), §6.2 inbox (Task 18), §6.3 ask (Task 22), §6.4 search (Task 21), §6.5 journal (Task 24), §6.6 brief (Task 26), §6.7 ping (Task 13).
- The 5-wave structure (Wave 0 scaffolding → 4 brief) maps 1:1 to design §9 phases.
- Plan correctly avoids `@discordjs/voice`, `ShardingManager`, `GuildPresences`, `setDMPermission`, `sendPremiumRequired`, `Message#interaction`, `ActionRow.from()`, `isAnySelectMenu`, `Client#emojis`, legacy `Constants`/`Formatters`, `SelectMenuBuilder`, `NewsChannel`, audit-log surface, moderation methods, `@discordjs/core` symbols. None of these appear in either doc.
- Plan correctly avoids in-memory caches, queues, and schedulers — stateless rule §15 is honored.
- Writes consistently go through `POST /api/ingest`, never direct vault writes — plane rule §3 honored.
- Reads consistently use the three MCP tools `searchNotes`, `semanticSearch`, `getNote` (matches UXIE-GUIDELINES §11 + scrypt's MCP surface) — no other MCP tools wrapped in v1.
- Bun-as-runtime + `bun test` is consistent across both docs and matches UXIE-GUIDELINES §3.
- Owner-gate is the first thing the interaction router does (Task 12), matching guideline §17.

---

## §4 New-layer additions the plan should absorb

These are not drift; they are net-new requirements the new spec layer added that the plan should grow tasks (or task amendments) to handle.

1. **Add `applyDefaultBuilderShape()` helper task** (Wave 1, before Task 13). Purpose: enforce `setContexts` + `setIntegrationTypes` + `setDefaultMemberPermissions(0n)` from one place; every later command task imports and calls it. Rationale: §6.2 makes these mandatory, and centralizing prevents drift across 6 commands.
2. **Add a logger-redaction sub-step to Task 4.** Purpose: meet §17.2's "redact `BOT_TOKEN`/`AUTH`/`SECRET`/`KEY` substrings". Add a unit test that asserts `log.info("scrypt", { SCRYPT_AUTH: "abc" })` emits `"SCRYPT_AUTH":"[REDACTED]"`.
3. **Add a top-level process-handler step to Task 14.** Purpose: complete §14.2's third catch site. Two `process.on` registrations + log + `process.exit(1)`. Add a small test that simulates an unhandled rejection in a child of the router and verifies the handler runs.
4. **Add `src/lib/tz.ts` task (or extend Task 24).** Purpose: meet §11 module map. Functions: `today(tz: string): string`, `formatWithTz(date: Date, tz: string): string`. Used by `/brief` to title "today" and by `/journal` reply text. Add unit tests with `Asia/Kolkata`.
5. **Move orchestrator stub to `integrations/para-raid/`.** Purpose: meet §11 directory shape and avoid scrypt↔para-raid coupling. Update Task 14 commit list.
6. **Add a Components V2 guardrail note** (no new task — single line in design §5 + Task 16). Purpose: discord.js surface §6 marks `ContainerBuilder`, `SectionBuilder`, `TextDisplayBuilder` as USE LATER and §8 of UXIE-GUIDELINES warns V2 is mutually exclusive with `embeds`. The current plan never imports them, which is correct — but the guardrail should be explicit so future contributors don't accidentally cross the streams. One-line comment in `lib/embed.ts` Task 16: "v1 uses classic embeds only — Components V2 is v1.5+".
7. **Anti-pattern lint check** (optional Wave 4 add). Purpose: §22 lists 22 anti-patterns; a `bun test` or grep-based smoke could catch the highest-value ones (try/catch in command body, `process.env.X` outside `lib/env.ts`, boolean `ephemeral`). Could be a single task adding a `tests/anti-patterns.test.ts` that scans `src/integrations/scrypt/commands/*.ts` for the `try {` token and fails if found.

---

## §5 Recommended next move

Bump the **design first**. Three reasons: (a) the plan currently traces back to the design as its source of truth (`Spec: docs/superpowers/specs/2026-04-14-uxie-design.md`), so design changes propagate; (b) the design's intent list (§5.1), env names (§5.2), and orchestrator-stub location (§5.3) are the upstream causes of the highest-impact drift items #1, #6, #8; (c) the design is shorter and the edits are concentrated in §5 + §7.2 + §8.4 — under an hour of careful editing.

**Order of bumps:**

1. **Design v1.1** — patch §5.1 (intents + partials), §5.2 (env names + add `tz.ts`), §5.3 (orchestrator-stub location), §6.5 (mention `lib/tz.ts`), §7.2 (third catch site), §8.4 (smoke ritual additions), and §10 (acceptance criteria mention `setContexts` + `MessageFlags.Ephemeral`).
2. **Plan v1.1** — patch Task 1 (discord.js bump), Task 2 (env renames + add `SCRYPT_AUTH`), Task 4 (redaction), Task 9 (intents/partials), Task 12 (`MessageFlags.Ephemeral`), Task 13/16/21/22/24/26 (builder shape helper), Task 14 (process handlers + para-raid stub move), insert Task 23.5 or extend Task 24 (`lib/tz.ts`).
3. **Then execute.** All 26 tasks remain valid; only edits to ~9 tasks are required. No wave needs renumbering.

Do not invert the order. Editing the plan first will leave the design as a stale upstream reference that subagent-driven-development will read and re-introduce drift on the next pass.
