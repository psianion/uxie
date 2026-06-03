# Deep Research — Dimension: discord-ux

> The most advanced, polished Discord UX achievable inside uxie's v1 guardrails — and a crisp roadmap of what to pull forward (v1) vs defer (v1.5 / v2). Every recommendation is reconciled with the locked "classic embeds only in v1" rule.

Date: 2026-06-03 · discord.js pinned `^14.26.2` · runtime Bun + TypeScript · single-owner, stateless. Repo is docs-only; this informs the upcoming build workflow.

---

## 1. Context recap (what is already locked)

From the baseline decisions, hard constraints, and the API surface doc, the following are **non-negotiable for v1** and frame everything below:

- **Classic ephemeral embeds only.** Every reply uses `EmbedBuilder` + `flags: MessageFlags.Ephemeral`. Ephemeral is the default; "loud" (non-ephemeral) is opt-in only (Guidelines §8, §22).
- **Components V2** (`ContainerBuilder`, `SectionBuilder`, `TextDisplayBuilder`, buttons, select menus, modals) sit in MIGHT_USE_LATER → **v1.5+** (api-surface §6).
- **Defer-within-3s contract.** Anything touching Scrypt defers first, then `editReply`. Tested as deferReply→editReply (Design §8.2, Guidelines §22).
- **6 commands:** `/ping`, `/capture` (+ `#inbox` passive), `/search` (FTS5), `/ask` (semantic), `/journal`, `/brief` (manual-only).
- **`#inbox`** acks with ✅/❌ reactions only; fire-and-forget (Design §7.2, Non-Goals §2).
- **Required builder shape** on every command: `.setContexts(InteractionContextType.Guild)`, `.setIntegrationTypes(ApplicationIntegrationType.GuildInstall)`, `.setDefaultMemberPermissions(0n)` (Guidelines §6.2).
- **Guild-scoped deploy** via standalone `deploy-commands.ts` REST PUT to `Routes.applicationGuildCommands` (instant, per-guild) — not global (Design §4).
- **Exactly three catch sites:** `interaction-router.ts`, `message-router.ts`, `index.ts` top-level. No try/catch in command bodies (Guidelines §14.2).
- **Stateless:** no in-memory cache of results between interactions; no local idempotency. Scrypt is idempotent server-side via `client_tag` (`uxie-<id>` / `uxie-msg-<id>`).

Known file shapes confirmed from the plan's File Responsibility Map:
- `src/lib/embed.ts` — all embed builders with cap enforcement (`DESC_CAP = 4000`, `FIELD_CAP = 1000`, `truncate(s, n)`), `captureEmbed({path, permalink})` already sketched.
- `src/lib/command-builder.ts` — `withOwnerGate(builder)` applies the §6.2 shape. (Resolves baseline Drift #2.)
- `src/integrations/scrypt/mcp-client.ts` — `searchNotes(q, limit) → SearchHit[]` (`{note_path, match_preview}`), `semanticSearch(q, limit) → SemanticHit[]` (`{note_path, chunk_text, score}`), `getNote(path) → Note` (`{path, title, body}`).
- `src/integrations/scrypt/rest-client.ts` — `health()`, `ingest()`, `getDailyContext()`.
- `src/bot/interaction-router.ts` — single error boundary for commands; `src/bot/message-router.ts` — single boundary for `#inbox`.

---

## 2. The 3s / 15min interaction lifecycle — the spine of every command

This is the single most important UX mechanic and the spec already mandates the core of it. The full lifecycle, precise to v14.26.2:

| Phase | Budget | What uxie does |
|---|---|---|
| **Initial ACK** | **3 seconds** from receipt | `interaction.deferReply({ flags: MessageFlags.Ephemeral })`. The *only* thing that must happen synchronously fast. Shows "uxie is thinking…". |
| **Follow-up window** | **15 minutes** after the ACK | `interaction.editReply({ embeds: [...] })` once Scrypt returns. |
| **Token expiry** | 15 min hard | After that the interaction token is dead; `editReply` 404s. Not a v1 concern (every call is sub-second) but the error router must tolerate `DiscordAPIError 10062 Unknown interaction` / `40060 already acknowledged`. |

Key v14.26.2 facts confirmed against the API docs:
- `deferReply({ flags })` — **only** `MessageFlags.Ephemeral` is accepted in the flags here. The legacy `ephemeral: true` option is **deprecated**; use `flags` (source: `InteractionDeferReplyOptions` interface). Matters for v15-safety.
- The ephemeral choice is made **at defer time** and is immutable for that response. You cannot defer public then `editReply` ephemeral, or vice-versa.
- `/ping` could skip defer (sub-3s) but should *also* defer to keep one command contract and one test matrix — see §8/§12.

### Recommended shared execute contract (engrain in v1)

Lock a single command shape so the deferral discipline can't drift:

```ts
// src/integrations/scrypt/commands/_contract.ts  (or fold into the Command type)
export interface Command {
  data: SlashCommandBuilder;             // already passed through withOwnerGate()
  execute(i: ChatInputCommandInteraction): Promise<void>;
  autocomplete?(i: AutocompleteInteraction): Promise<void>;  // v1.5 hook, optional, no-op in v1
}
```

Every `execute` body:
```ts
export async function execute(i: ChatInputCommandInteraction): Promise<void> {
  assertOwner(i);                                   // FIRST line, always
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await scrypt.someCall(...);        // may throw ScryptError
  await i.editReply({ embeds: [someEmbed(result)] });
}
```
No try/catch — `ScryptError` / `NotOwnerError` bubble to `interaction-router.ts`. Router contract: if `i.deferred || i.replied` → `i.editReply({ embeds: [errorEmbed(...)] })`, else `i.reply({ embeds: [errorEmbed(...)], flags: Ephemeral })`. This deferred/replied branch is the single most common router bug; assert it in the router test. (api-surface §7 Q1: under v15 AsyncEventEmitter the router must also catch *rejected promises* from listener bodies, not only sync throws.)

---

## 3. Ephemeral-by-default — the mobile rationale

Ephemeral replies (`MessageFlags.Ephemeral`) are the correct default for a **single-user personal vault bot**, sharper on mobile:

1. **Privacy of recall.** `/search`, `/ask`, `/brief` surface the owner's private notes. Even in a single-owner guild, a non-ephemeral reply is permanent channel scrollback — searchable, screenshot-able, synced to every device. Ephemeral output is per-session and disappears, matching the "personal vault" model.
2. **No channel pollution.** A second-brain used dozens of times a day would bury the channel; ephemeral keeps `#scrypt` clean for actual capture.
3. **Mobile rendering.** Ephemeral renders identically to normal on mobile but never triggers push notifications or unread badges for the owner's *other* sessions — important when phone + desktop are both logged in.
4. **Opt-in loud is the escape hatch.** For "I want this permanent" cases, a boolean option `public:true` (v1.5) flips the flag. v1 ships ephemeral-always as the safe floor.

`allowedMentions` defense (Guidelines §5): set `Client.options.allowedMentions = { parse: [], repliedUser: false }` once in `client.ts`. Guarantees no `@everyone`/role pings can escape a rendered note body; documented to be inherited by `reply`/`editReply` (api-surface §7 Q5 — assert in a router test).

---

## 4. Classic embeds — the polished playbook (v1)

Embeds are the entire v1 output surface. Hard limits to enforce in `lib/embed.ts` (Discord API + Guidelines §8):

| Field | Hard limit | uxie cap (slack) |
|---|---|---|
| `title` | 256 | 256 |
| `description` | 4096 | `DESC_CAP = 4000` |
| field `name` | 256 | 256 |
| field `value` | 1024 | `FIELD_CAP = 1000` |
| fields per embed | 25 | ≤ 10 (readability) |
| `footer.text` | 2048 | short |
| `author.name` | 256 | — |
| **total across all embeds in a message** | **6000** | budget ~5500 |

### `lib/embed.ts` — recommended builder set (v1)

Build on the already-sketched `captureEmbed` + `truncate`. Add per-command builders so visual design is *code*, not "manual eyeballing" (closes the baseline gap on embed visual design):

```ts
export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
// Scrypt web permalink from a note path. SCRYPT_SERVER_URL comes via env.
export function noteUrl(serverUrl: string, path: string): string {
  return `${serverUrl.replace(/\/$/, "")}/n/${encodeURIComponent(path)}`;
}

const ACCENT = 0x5865f2;                  // brand blurple; one constant everywhere
const OK = 0x57f287, WARN = 0xfee75c, ERR = 0xed4245;

export function captureEmbed(r: { path: string; permalink: string }): EmbedBuilder { /* sketched in plan */ }

export function searchEmbed(q: string, hits: SearchHit[], serverUrl: string): EmbedBuilder {
  const e = new EmbedBuilder().setColor(ACCENT)
    .setTitle(truncate(`🔎 ${hits.length} hits · "${q}"`, 256));
  if (hits.length === 0) return e.setDescription("No matches in scrypt.");
  // ONE description, hyperlinked filenames + FTS preview as blockquote — most scannable on mobile
  e.setDescription(truncate(hits.slice(0, 10).map((h, idx) =>
    `**${idx + 1}.** [${basename(h.note_path)}](${noteUrl(serverUrl, h.note_path)})\n> ${oneLine(h.match_preview)}`
  ).join("\n\n"), DESC_CAP));
  return e.setFooter({ text: `FTS5 · ${hits.length} result(s)` });
}

export function askEmbed(q: string, hits: SemanticHit[], serverUrl: string): EmbedBuilder {
  const e = new EmbedBuilder().setColor(ACCENT).setTitle(truncate(`🧠 ${q}`, 256));
  if (hits.length === 0) return e.setDescription("Nothing semantically close. Try /search for keywords.");
  e.setDescription(truncate(hits.slice(0, 5).map((h, idx) =>
    `**${idx + 1}.** [${basename(h.note_path)}](${noteUrl(serverUrl, h.note_path)}) · \`${h.score.toFixed(2)}\`\n> ${oneLine(h.chunk_text)}`
  ).join("\n\n"), DESC_CAP));
  return e.setFooter({ text: `semantic · top ${Math.min(hits.length, 5)}` });
}

export function briefEmbed(ctx: DailyContext, tz: string): EmbedBuilder {
  // multi-field: one field per section (recent captures, open tasks, today's journal)
  const e = new EmbedBuilder().setColor(ACCENT).setTitle(`📋 Daily brief · ${journalDateKey(tz)}`);
  for (const s of ctx.sections.slice(0, 10)) {
    e.addFields({ name: truncate(s.label, 256), value: truncate(s.body || "—", FIELD_CAP) });
  }
  return e.setFooter({ text: `scrypt daily_context · ${tz}` });
}

export function errorEmbed(userMessage: string): EmbedBuilder {
  return new EmbedBuilder().setColor(ERR).setDescription(`⚠️ ${userMessage}`);
}
export function pingEmbed(wsMs: number, scryptOk: boolean): EmbedBuilder {
  return new EmbedBuilder().setColor(scryptOk ? OK : WARN).setTitle("🏓 pong")
    .addFields(
      { name: "gateway", value: `${wsMs} ms`, inline: true },
      { name: "scrypt", value: scryptOk ? "✅ reachable" : "❌ down", inline: true },
    );
}
```

Polish details to engrain in v1 (all classic-embed-legal):
- **Permalinks back to the Scrypt web UI** on every result line via markdown `[label](url)`. Highest-value touch — `/ask` on mobile linking straight to the note in the browser is the killer feature (FC-03). Needs `SCRYPT_SERVER_URL` in env (already planned for the prod swap). **Caveat:** confirm Scrypt's note URL scheme (`/n/<path>` is assumed from the `captureEmbed` sketch — see Open Questions).
- **Single-description list over many fields** for search/ask. Fields wrap awkwardly on narrow mobile; a numbered markdown list in one `description` is most scannable. Reserve multi-field for `/brief` where sections are genuinely distinct.
- **One accent-color constant** + semantic colors (ok/warn/err) for instant recognition.
- **Snippet truncation to one line** (`oneLine()` strips newlines, caps ~140 chars) so each result is a tidy row.
- **Footer carries provenance** ("FTS5", "semantic · top 5", tz) — cheap, professional, helps reason about why `/search` and `/ask` differ.
- **`time()` / `TimestampStyles`** (allowed formatters) for `/brief` timestamps — renders in the viewer's local tz automatically.
- **AttachmentBuilder overflow**: per api-surface, output >1500 chars goes out as a `.md` attachment rather than truncated. Wire `if (body.length > 1500) → AttachmentBuilder` in any `getNote`-backed flow so long notes degrade gracefully.

---

## 5. `#inbox` passive capture + the 🧠 enrichment question

**v1 (locked):** `messageCreate` → owner gate → channel gate → `rest.ingest(kind="inbox", client_tag=msg.id)` → `msg.react("✅")` on success, `msg.react("❌")` on failure. No replies, no edits. Sanitize codeblocks before forwarding (Guidelines §9). Correct and complete; don't add to it in v1.

**The 🧠 reaction-enrichment idea (defer to v2).** Natural next step: react 🧠 on a captured message → trigger enrichment (summary, tags, edges). Honest reasons it must wait:

1. Requires `GatewayIntentBits.GuildMessageReactions` + `Partials.Reaction` + `Events.MessageReactionAdd` — none in the v1 intent set. Adding any intent requires a Guidelines §5 doc bump (hard constraint).
2. The async story is the real blocker. Enrichment is **not** sub-second; it's an orchestrator job. uxie is *stateless* with **per-call MCP connections** — nowhere to park a long job or report completion. The honest pattern (react 🧠 → POST enrich → react ⏳ then 🧠✅ on done) needs polling (stateful) or the `#notifications` WS bridge — both explicit Tier-2/Tier-3 Non-Goals.
3. Enrichment is **orchestrator (Para-RAID) territory** by the SUP plane model — "business logic" uxie must not own.

So 🧠 enrichment is **v2**, gated on (a) Para-RAID existing, (b) the `#notifications` WS bridge, (c) a Guidelines §5 intent bump. Document it as a v2 slot; do not scaffold reaction listeners in v1.

**Custom-emoji ack (v1.5, S):** the one cheap inbox polish — swap ✅/❌ for the guild's custom emoji via a `resolveGuildEmoji` util (api-surface notes `Client#emojis` is removed in v15; use a resolver). Cosmetic, no new intent. v1.5.

---

## 6. Autocomplete — the highest-value *interactive* upgrade (v1.5)

Autocomplete is the most impactful interactive touch that is **not** Components V2 and **not** a new intent. It is a separate interaction type (`AutocompleteInteraction`) routed alongside commands. MIGHT_USE_LATER → v1.5; pull **one** instance forward conditionally.

### Mechanics (v14.26.2, confirmed)
- Declare on an option: `option.setAutocomplete(true)` (cannot combine with `.setChoices`).
- Router branches: `if (i.isAutocomplete()) return command.autocomplete?.(i)`.
- Handler reads `i.options.getFocused()` (partial string), computes ≤25 choices, calls `i.respond([{ name, value }, ...])`.
- **Strict 3-second budget, and `respond()` is the *only* valid response** — you cannot `deferReply` an autocomplete. The backing call must be fast.

### uxie-specific design
- **`/search query` live autocomplete (v1.5, M):** as the owner types, fire `searchNotes(focused, 5)` → return top 5 note titles as choices. Killer on mobile — pick the note before submitting. **Stateless?** Yes — each autocomplete is an independent per-call MCP read, no cache. **But** it doubles Scrypt reads under a hard 3s budget (Discord fires per keystroke; no server-side debounce). Enable only if Scrypt FTS5 p99 < ~800ms, cap `limit=5`. v1.5 because it needs the `autocomplete?` router branch + an `AutocompleteInteraction` test — scope beyond the 6 v1 commands.
- **`/link source target` (v2):** the brief's future `/link` backed by `search_notes` for both operands is the canonical autocomplete case (pick two notes → create an edge). But `/link` is a **Tier-2 Non-Goal** (edge writes ≈ graph/orchestrator) and not in v1's command set. v2.

**v1 recommendation:** ship `/search`/`/ask` with plain string options (no autocomplete) but **structure the `Command` interface and router to accept an optional `autocomplete(i)` method now** (zero runtime cost; makes v1.5 a pure addition, not a refactor). This is the advanced touch worth engraining in v1 — the *seam*, not the feature.

---

## 7. Components V2 / Display Components — status, trap, upgrade trigger

### Current GA status (2025–2026)
Components V2 went **generally available in March 2025**; Discord now *recommends* it for new apps/features (sources: cybrancee.com, bestcodes.dev, discord.js guide "Display Components"). Production-ready. discord.js v14.26.2 exposes the full builder set: `ContainerBuilder`, `SectionBuilder`, `TextDisplayBuilder`, `SeparatorBuilder`, `MediaGalleryBuilder`, `ThumbnailBuilder`, `FileBuilder`.

### What it unlocks
- **`TextDisplayBuilder`** — markdown text blocks (replaces `content`/`embed.description`).
- **`SectionBuilder`** — up to 3 text displays + **one accessory** (button or thumbnail) alongside. The "row + accessory" shape: a note title with an **Open** link button beside it.
- **`ContainerBuilder`** — accent-colored bordered box grouping sections (the visual cousin of an embed).
- **`SeparatorBuilder`, `MediaGalleryBuilder`** (≤10 images), `FileBuilder`.

### The mutual-exclusivity trap (confirmed, critical)
A message with `MessageFlags.IsComponentsV2` **cannot** also send `content`, `embeds`, `poll`, or `stickers` — those fields silently stop working (discord.js guide; WebSearch confirmed). Mixing classic + V2 in one message is a runtime rejection — exactly the constraints' anti-pattern. Further V2 limits: **40 components max** (incl. nested), **4000 chars total** across all text displays, and **every attached file must be referenced** by a component.

`lib/embed.ts` already documents this ("Do not import them here"). Keep the boundary; introduce V2 later in a **separate `lib/components.ts`** so the two worlds never share a file.

### Precise upgrade trigger (when v1.5 adopts V2)
Adopt Components V2 **only when a command needs interactive accessories or a layout embeds can't express** — concretely:
1. **`/ask` retry / "more like this" buttons** — the FC-03 "ambitious" UX. A `SectionBuilder` per result with an **Open** *link* button (link buttons need no customId/collector → still stateless-friendly) and a footer `ActionRow` "more like this" button (this one needs a component collector → stateful → see §8). The link-button half is the lowest-risk V2 entry.
2. **`/brief` rich layout** — api-surface explicitly names `/brief` as the V2 candidate (Container + ≤2 ActionRows). Trigger: when brief wants per-section "open" buttons or exceeds the 6000-char embed budget.

**Verify before committing (api-surface §7 Q7):** confirm `IsComponentsV2 | Ephemeral` actually renders ephemerally — flags must OR cleanly. v1.5 spike, not a v1 task. **Until verified and until a button is genuinely needed, classic embeds + markdown-link permalinks deliver ~90% of the value with zero risk.** That is the v1 stance.

---

## 8. Buttons / select menus / modals — lifecycle and why they wait

Exact lifecycle for each, and the honest reason most defer:

- **Link buttons** (`ButtonStyle.Link` + `.setURL`) — **no interaction, no collector, no customId.** They just open a URL — the *one* interactive-looking element that is fully stateless. They require Components V2 (a button lives in a `SectionBuilder` accessory or `ActionRow`), so they ride the §7 V2 upgrade. **v1.5**, low risk.
- **Action buttons** (Primary/Secondary/Danger) — emit a `ButtonInteraction` with your `customId`. Route by `customId` in `interaction-router` (`if (i.isButton())`), then `deferUpdate()`/`editReply()`. **Catch:** you must re-derive *all* state from the `customId` string because uxie holds **no memory between interactions** (stateless). A "more like this" button must encode the note path in its `customId` (e.g. `ask:more:notes/x.md`) and re-run `semanticSearch` on click. Workable, but real surface + a third interaction branch + routing tests. **v1.5.**
- **Select menus** (`StringSelectMenuBuilder` etc.) — emit `StringSelectMenuInteraction`; same stateless constraint (encode meaning in option `value`s). Use case: pick which of N hits to expand inline. **v1.5 at the earliest; arguably v2.**
- **Modals** (`ModalBuilder` + `showModal` → `ModalSubmitInteraction`) — **note:** `showModal` is an *alternative* to deferring (the modal **is** the ACK), so you cannot `deferReply` then `showModal`. Use case: `/journal` opening a multi-line modal instead of a single string option (api-surface names this exactly). Nicer for long entries on desktop, but the text input caps at 4000 chars and is clunkier on mobile than the slash option. **v1.5.**

**Why this ordering is honest:** every component beyond a link button adds (a) a new router branch, (b) `customId` routing + tests, (c) the cognitive load of "all state lives in the customId because we're stateless." None of that buys the owner anything in v1 that a markdown-link embed doesn't already give. The **v1 engrained touch** is again the *seam*: have `interaction-router` switch on interaction type (`isChatInputCommand` / `isAutocomplete` / `isButton` / `isModalSubmit`) with the latter two as no-op `default` branches, so adding them later is additive.

---

## 9. Threads, polls, pagination, gateway-channel classification — defer map

- **Threads as conversations (v2):** `Message#startThread` + `ThreadChannel` for `/ask`-spawns-a-thread chat. Needs `Events.Thread*` and a stateful conversation model — against stateless + per-call MCP. **v2.**
- **Polls (v2 / never):** no single-owner use case.
- **Pagination (avoid; v1.5 only if proven necessary):** classic pagination needs Prev/Next **buttons** + a component collector holding page state → **stateful**, anti-pattern in v1. Stateless-friendly substitutes for "too many results": (a) cap to top-N (5 for `/ask`, 10 for `/search`) — **do this in v1**; (b) overflow to an `AttachmentBuilder` `.md`; (c) tell the owner to narrow the query. Real button pagination is v1.5+ and only if top-N proves insufficient. Recommend **not** building it — cap + permalink-to-web-UI is the better answer for a vault.
- **Gateway-channel (`#scrypt`) intent classification (v2, Tier-3):** "type anything in `#scrypt` → LLM classifies capture vs query vs task → routes." Explicitly Tier-3 orchestrator-dependent (LLM calls uxie must not make) and a Non-Goal. The `orchestrator-stub.ts` seam exists for exactly this. **v2**, Para-RAID-gated.

---

## 10. Mobile rendering rules (apply in v1)

- Numbered single-`description` lists beat multi-field on narrow screens (§4).
- Keep titles short — they truncate hard on phones; put detail in the description.
- Markdown links render as tappable text on mobile — permalinks are first-class mobile UX.
- Avoid wide inline-field triples except `/ping` (2–3 short inline fields render fine).
- Code blocks (`codeBlock`) horizontal-scroll on mobile — use sparingly; prefer `inlineCode` for paths.
- Ephemeral renders identically to normal on mobile but won't badge other sessions (§3).

## 11. Rate-limit & response hygiene (apply in v1)

- **Per-call MCP connections** (no long-lived socket) — already mandated; also sidesteps reconnect-backoff complexity.
- **One ACK, one edit.** Never stream rapid `editReply`s (api-surface §5 rejects rapid-fire streaming; debounce ≥1s or single placeholder+final edit). uxie's defer → single editReply already complies.
- **No in-code cooldowns/throttling** (api-surface §5) — single owner, no abuse vector; rely on Discord's per-route limits.
- Let `DiscordAPIError` 429s surface to the router; do **not** build a custom retry queue (stateless rule).
- `client.ws.ping` for `/ping` today (v14.26); flag for v15 where it becomes `Client#ping`.

---

## 12. Conflicts with spec

- **Autocomplete & Components V2 are MIGHT_USE_LATER, not v1.** Every recommendation touching them is tagged v1.5/v2; none proposed for v1. The only v1 ask is the *router/interface seam* (no-op branches), which is additive and spec-compatible.
- **🧠 enrichment** would need `GuildMessageReactions` (intent → Guidelines §5 bump) + is orchestrator/business-logic → flagged v2, conflict noted.
- **Live `/search` autocomplete** doubles Scrypt reads under a 3s budget; not a stateless violation (per-call reads) but a perf/scope concern → v1.5, perf-gated.
- **Baseline Drift #1** (DirectMessages intent + missing `Partials.Message` in Design §5.1 / Plan Task 9) is outside this dimension's authority but affects the client factory; flagged for the build to fix per the consistency report.

## 13. Open questions

1. Does Scrypt expose a stable web-UI permalink scheme? The `captureEmbed` sketch assumes `/n/<path>`. Confirm the exact route (path vs slug vs note id) before hardcoding `noteUrl()`.
2. What is Scrypt FTS5 / `search_notes` p99 latency? Determines whether `/search` autocomplete is viable under the 3s budget (v1.5 gate).
3. What is the shape of `getDailyContext()` / `daily_context`? `briefEmbed` assumes `{sections: [{label, body}]}` — confirm to finalize multi-field vs single-description.
4. Does `IsComponentsV2 | MessageFlags.Ephemeral` render correctly ephemeral? (api-surface §7 Q7) — v1.5 spike before any V2 commitment.
5. Confirm `Client.allowedMentions = {parse:[],repliedUser:false}` is inherited by `editReply` (api-surface §7 Q5) — assert in a router test.
6. `/ping`: defer-for-uniformity vs reply-fast? Recommend defer for a single command contract; confirm with the build owner.

## 14. Sources

- discord.js v14.26.2 API docs (Context7 `/websites/discord_js_packages_discord_js_14_26_2`): `InteractionDeferReplyOptions` (flags = Ephemeral only; `ephemeral` option deprecated), `AutocompleteInteraction#respond` / `isAutocomplete`, `deferReply`/`editReply` lifecycle.
- discord.js Guide (Context7 `/discordjs/guide`): Autocomplete (`getFocused`, `respond`, filtered choices), Display Components / Components V2 (IsComponentsV2 caveats: no content/poll/embeds/stickers; 40-component & 4000-char limits; files must be referenced).
- WebSearch (June 2026): Components V2 GA timeline (March 2025) + production-ready recommendation — cybrancee.com "The Future of Discord: Components V2"; bestcodes.dev "Using Discord Components v2 with Discord.js"; discord.js guide "Display Components".
- uxie repo docs: `UXIE-DISCORD-GUIDELINES.md` (§5 intents, §6.2 builder, §8 embeds vs V2, §9 inbox, §14.2 catch sites, §22 anti-patterns); `discordjs-api-surface.md` §5–§7; `superpowers/specs/2026-04-14-uxie-design.md` (§2 Non-Goals, §5.1, §8.2); `superpowers/plans/2026-04-14-uxie.md` (File Responsibility Map, Tasks 13/16/21/22/24/26, `lib/embed.ts` sketch, MCP-client shapes `SearchHit`/`SemanticHit`/`Note`); `scrypt-feature-ideation.md` (FC-03 `/ask`); `spec-consistency-report.md` (Drift #1/#2).
