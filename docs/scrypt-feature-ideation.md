# Uxie × Scrypt — Feature Ideation Brief

**Author:** scrypt-ideator (uxie-kickoff team)
**Date:** 2026-04-14
**Status:** Pre-brainstorm research output. Feeds the real brainstorm + design doc.
**Scope:** What a Discord bot on top of scrypt's Wave 8 MCP server should do, how it should be shaped, and where to stop for v1.

Built on top of `docs/scrypt-integration-context.md` (don't re-read that — this extends it).

---

## 1. Scrypt's domains & folder structure (what the user actually captures)

Actual vault on disk: `/Users/admin/scrypt-vault/` — confirmed via the running MCP server and `.env`.

| Folder | Contents | Ingest-router `kind` | Notes |
|---|---|---|---|
| `journal/` | Daily notes, free-form | `journal` | `{YYYY-MM-DD}.md`, append-only per day, templated from `templates/daily.md`. Each day gets a `domain` + `tags` in frontmatter which anchors `daily_context.related.*`. |
| `research/dnd/` | Deep D&D worldbuilding & AI-DM work | folder-derived | Subfolders: `ai-dm/`, `canvas/`, `plans/`, `specs/`, `vault/`. Heaviest single domain in the graph by volume. |
| `research/scrypt/` | Scrypt's own design history, plans, ops | folder-derived | `architecture/`, `specs/`, `plans/`, `operations/`, `api/`. This is scrypt-designing-scrypt. |
| `research/<other>/` | Any future domain the user creates | folder-derived | `domain`/`subdomain` are inferred from the folder path by the indexer. |
| `memory/` | Durable interest/preference profiles | `memory` | `active: true` memories are injected into every orchestrator research prompt. Example: `memory/research-sources.md`. |
| `notes/inbox/` | Quick unclassified captures | `note` | Where stuff lands when you don't know where it belongs yet. The Discord bot's natural target. |
| `notes/threads/` | Open research questions | `thread` | `status: open\|in-progress\|resolved\|…`, `priority`, `prompt` body. Orchestrator pulls these. |
| `notes/research/` | Research-run output | `research_run` | One file per Claude run, links back to parent thread, appends a summary under `## Runs`. |
| `notes/ideas/`, `notes/thoughts/`, `notes/logs/` | Freeform capture by intent | `idea` / `thought` / `log` | `thought`/`log` files get time-stamped names so same-day collisions don't clobber. |
| `docs/specs/`, `docs/plans/` | Design docs, plans | `spec` / `plan` | Dated, slugged. |
| Every `- [ ] task` across the vault | Kanban items | (parsed) | Surfaced via `/api/tasks` and the Kanban view. |

**Domains that exist today (from the graph report, 265 nodes):** scrypt, dnd, memory, journal, and a handful of orphan notes. The tag space is driven by `tags:` in frontmatter (topic tags) plus identifier tags like `type:research`, `stage:draft`, `project:scrypt`, `wave:4`, `domain:dnd`.

**Implication for uxie:** The bot rarely has to pick a folder by hand. Scrypt's `POST /api/ingest` + MCP `create_note` take a `kind` and do the folder routing. Uxie's UI just has to expose "what is this?" (thought / idea / inbox note / journal line / thread / memory) and delegate the rest.

---

## 2. Full MCP tool inventory → Discord UX mapping

Wave 8 MCP server exposes **12 tools** over stdio + `POST /mcp` streamable-http at `https://scrypt.tailnet.ts.net/mcp` with bearer auth. Every write is idempotent via `client_tag` — safe to retry. Source: `2026-04-14-scrypt-mcp-l5-design.md`.

### Writes

| MCP tool | Input surface | Discord UX that maps cleanly |
|---|---|---|
| `create_note` | `{path, content, client_tag}` | **Capture a thought** (DM the bot or post in `#inbox`). Bot slugs, builds frontmatter, picks folder via `kind`, posts back the note's permalink and live embedding progress as reactions. |
| `update_note_metadata` | `{path, description?, auto_tags?, entities?, themes?}` | **"Enrich this"** — a reply to a captured-note embed runs a short Claude pass (via orchestrator, not scrypt) and back-fills description/tags. User can 👍 to accept, ❌ to reject. |
| `add_section_summary` | `{note_path, heading_id, summary}` | **"TL;DR this section"** — reply to any line in a shown note → summarize. |
| `add_edge` | `{source, target, relation, confidence, reason?}` | **"Link this to X"** — button on any note embed. Relations: `elaborates`, `contradicts`, `cites`, `same-topic`, `mentions`, `related`. |
| `remove_edge` | `{source, target, relation?}` | Rare, destructive — probably not v1. |

### Reads

| MCP tool | Discord UX that maps cleanly |
|---|---|
| `get_note` | Fetch a note by path; render as embed (title, description, sections list, first N lines of body). Chunked "next page" button for long notes. |
| `search_notes` (FTS5) | **`/search <query>`** — fast exact keyword hits. Best for "that thing I literally typed last week". |
| `semantic_search` | **`/ask <query>`** — natural-language recall. "What was the ARM SVE2 thing I was reading about?" Returns top 5 chunks, each clickable → `get_note`. |
| `find_similar` | **"more like this"** button on any embed. Great for exploration. |
| `walk_graph` | **"neighbors of this"** — BFS from a note, filtered by edge relation. Use case: pull everything connected to today's journal domain. |
| `get_report` | **`/state`** — renders hubs, communities, orphans. This is the cheapest, most mobile-friendly "what shape is my brain in?" view. |

### Admin

| `cluster_graph` | Louvain clustering refresh. Not a user-facing command; maybe `/admin recluster` gated to the owner. |

**The 12-tool surface trivially covers the daily-use cases.** The bot adds no new primitives — it's a UX skin. The "intelligence" (any LLM-shaped decision) happens in the orchestrator, never in scrypt.

**Also callable:** the existing REST API. `GET /api/daily_context` is the single biggest win for a phone user — it returns one JSON blob with today's journal, recent notes, open threads, active memories, and tag cloud. One HTTP call, one Discord embed, perfect for the morning brief feature.

---

## 3. Distributed HLD — where uxie sits

```
┌──────────────────────┐
│   L1: User (phone)   │  Discord mobile / Termius fallback
└──────────┬───────────┘
           │ message
┌──────────▼───────────┐
│  L2: uxie (Discord)  │  discord.js v14, Oracle ARM / Mac, Tailscale
│  - slash commands    │  holds DISCORD_BOT_TOKEN + SCRYPT_AUTH_TOKEN
│  - gateway channel   │  owns idempotency (client_tag per interaction)
│  - push notifier     │  multi-integration adapter layer (scrypt #1)
└─┬────────────────────┘
  │ direct MCP                  ┌───────────────────┐
  │ (reads, simple writes)      │  L4: Orchestrator │
  │                             │  Claude in tmux   │
  │                             │  - long research  │
  │          ┌──────────────────│  - enrichment     │
  │          │ dispatches       │  - daily digest   │
  │          │                  │  - replies back   │
  │          ▼                  │   via uxie API    │
  │  ┌───────────────┐          └─┬─────────────────┘
  │  │ L3: Workers   │            │
  │  │ Termux/tmux   │            │
  │  └───────┬───────┘            │
  │          │                    │
  ▼          ▼                    ▼
┌─────────────────────────────────────┐
│  L5: Scrypt MCP (Wave 8)            │
│  12 tools, bearer auth, /mcp        │
│  + REST /api/daily_context, /ingest │
│  + WebSocket vault:embedding        │
└─────────────────────────────────────┘
```

### Direct-MCP vs via-orchestrator — my recommendation: **hybrid with a single router**

Reads and trivial writes should hit scrypt directly. They're fast, deterministic, and don't need an LLM. Anything requiring natural language understanding or multi-step planning should dispatch to the orchestrator as a job.

| Path | Latency | Uses | Examples |
|---|---|---|---|
| `uxie → scrypt MCP` | <300ms | Reads + structural writes | `/search`, `/ask`, `/state`, `/capture`, `/journal add`, `/link a→b` |
| `uxie → orchestrator → scrypt MCP` | 5–120s | LLM-shaped work | Enrich captured note, draft morning brief, answer "what should I work on today", kick off a research run on a thread |

Concretely: uxie publishes a small internal contract for both paths (`callScrypt(tool, args)` and `dispatchOrchestrator(job, payload)`). The orchestrator returns either by writing a note and sending uxie a `reply_to` message, or by posting back through the same Discord channel via a shared inbox queue.

**Open question for team-lead:** does the orchestrator exist as a running process *today*, or is uxie being built in parallel? If it isn't ready, v1 can be "direct MCP only, jobs enqueued but never dispatched" and the enrichment features degrade gracefully.

---

## 4. Daily-use cases on mobile

Ordered roughly by frequency of use.

1. **Morning brief.** 8am push to a `#brief` channel: today's date, journal entry stub (or pre-created), open thread queue (top 3 by priority/neglect), 5 recent notes, active memories, tag cloud highlights. One call to `GET /api/daily_context`; renders as a single embed + a CTA button ("add to journal"). Inspired by the "morning briefing" OpenClaw use case the user already noted.
2. **Quick capture.** Post anything into `#inbox` or DM the bot → `create_note` into `notes/inbox/` (or `journal` if it's a "today" line). The bot replies with the note's permalink + tiny live embedding-progress reactions driven by the `vault:embedding` WebSocket channel. React with 🧠 to enrich.
3. **Voice-note ingest.** Upload an audio file to the bot → a Termux worker transcribes via local whisper → orchestrator writes a `thought` note. (Depends on worker path; v1 can accept audio but defer enrichment.)
4. **Search on the go.** `/search` (FTS5) for exact recall; `/ask` (semantic) for fuzzy recall. Both return paginated embeds. `/find-similar <note-id>` on any result for exploration.
5. **Kanban add.** `/task "ship wave 8 docs" board:In Progress tag:scrypt` → `POST /api/tasks` or an `- [ ]` append into a default note. React ✅ in any DM to mark a line done.
6. **Journal entry.** `/journal "got the MCP working end-to-end"` → appends under today's `## HH:MM UTC` in `journal/{YYYY-MM-DD}.md` via `ingest kind=journal`.
7. **Research run kickoff.** `/research <thread-slug>` → dispatches an orchestrator job. The bot posts a stub reply; the orchestrator writes the actual `research_run` note and edits the stub with results + a link.
8. **Thread triage.** `/threads` → list open threads with status/priority; buttons: `promote`, `defer`, `resolve`, `run now`. `PATCH /api/threads/:slug` handles the writes.
9. **Alert subscriptions.** Stream `vault:embedding` events matching a filter into a channel. Also: notify when a long orchestrator job finishes, when a thread's `last_run` ages past a threshold, when git autocommit hits a milestone.
10. **"What should I look at?"** — open a conversation in a gateway channel; orchestrator pulls `daily_context` + `get_report` and narrates. This is the one that makes uxie feel like an assistant instead of a form.

---

## 5. Interaction model options

### Option A — Pure slash commands (`/note`, `/search`, `/ask`, `/journal`, `/thread`, `/task`, `/state`, …)

**Pros:** Predictable. Autocompletion for params. Each command maps 1:1 to an MCP tool. Easy to add, easy to test, easy for the user to discover via `/`. Degrades gracefully if the orchestrator is down. Discord autocomplete can hit scrypt directly for live suggestions (e.g., thread slugs).

**Cons:** Feels like a form. No room for natural-language intent. Multi-step flows (capture → enrich → link) become awkward.

### Option B — Gateway channel (`#scrypt`, any message is a capture / query)

**Pros:** Matches the OpenClaw dm-s-apprentice pattern the user already validated. Feels conversational. Zero ceremony. Great for the 3 a.m. "remind me what I decided about X" use case.

**Cons:** Requires intent classification on every message (capture? query? command?) — that's an LLM call per message, which means the orchestrator *has* to be up. Risk of accidental captures ("asdf" becomes a note). Harder to test.

### Option C — Hybrid (recommended)

- **Slash commands** for anything structured. They're the source of truth.
- **Dedicated gateway channel** (`#scrypt-gateway` or similar) where any message becomes a "capture-or-query" classified by the orchestrator. Replies are threaded so each capture has its own conversation.
- **DM the bot** = same as the gateway channel but private.
- **Per-channel context.** Pinned message in each channel sets the domain/default-kind so captures in `#dnd-journal` go to `research/dnd/journal/` automatically. Mirrors the `#session-notes` / `#homebrew` / `#apprentice-log` split from dm-s-apprentice.

Hybrid also lets the user dial how much intelligence they want: when the orchestrator is down or slow, slash commands still work; when it's up, the gateway channel is magical.

---

## 6. Notification / alerting use cases

Discord replaces the original Telegram alert channel from the PRD. Broad categories:

- **Orchestrator events.** Research run started / finished / failed. Daily brief posted. Maintenance CLI completed.
- **Vault events.** A new note landed from the web UI or the file watcher; a note you own got an inbound wikilink; embedding finished for a newly captured note (from `vault:embedding`); git autocommit snapshot taken.
- **Thread health.** An open thread has aged past X days without a run. A high-priority thread got bumped.
- **Knowledge graph nudges.** A note became an orphan (no inbound/outbound edges). A new hub emerged. Community membership shifted.
- **System.** Scrypt server down / reachable. Auth token rotated. Tailscale handshake failed.

**Delivery channels:** a fixed `#notifications` channel for low-severity; DM for high-severity. Every notification carries a correlation id for easy ack/mute. Mute syntax: `/mute thread-stale 7d`.

**The bot should rate-limit itself**. A reindex of the vault should collapse into one "indexed N notes in Ms" message, not N messages. The `vault:embedding` throttling policy (one event per 30ms) already hints at how to coalesce.

---

## 7. Multi-integration future-proofing

Uxie is explicitly the unified Discord surface for the user's personal applications. Scrypt is integration #1; there will be more. This is worth paying for in v1.

**Shape the code like this:**

```
uxie/
├── src/
│   ├── bot/                  # discord.js v14 glue (client, interactions, events)
│   ├── core/
│   │   ├── registry.ts       # integration registry (name → commands, handlers, events)
│   │   ├── router.ts         # resolves incoming interaction → integration handler
│   │   ├── notifier.ts       # shared push-notification pipeline
│   │   ├── idempotency.ts    # client_tag generator, dedup store
│   │   ├── auth.ts           # owner-allowlist + per-integration scopes
│   │   └── channels.ts       # pinned-message channel context resolver
│   └── integrations/
│       ├── scrypt/           # MCP client + command surface + notifiers
│       │   ├── mcp-client.ts
│       │   ├── rest-client.ts
│       │   ├── commands/
│       │   ├── listeners/    # WebSocket → Discord bridge
│       │   └── index.ts      # exports Integration interface
│       └── <future>/         # integration #2, #3 slot in here
└── docs/
```

**Integration interface** (draft):

```ts
interface Integration {
  name: string;
  commands: SlashCommandBuilder[];
  handleCommand(interaction, ctx): Promise<void>;
  handleMessage?(message, ctx): Promise<void>;         // gateway-channel opt-in
  subscribeEvents?(notifier: Notifier): void;           // push events into Discord
  health(): Promise<HealthStatus>;
}
```

**Things to make shared from day 1:**

- Owner allowlist (single-user system, one source of truth for "is this my message")
- `client_tag` generator (UUID v4 prefixed with integration name)
- Notification fan-out + mute registry
- Channel context resolver (pinned-message → `{ domain, default_kind, target_folder }`)
- Health-check and `/status` command
- Structured logging + correlation ids

Rule of thumb: if a second integration would need to invent its own version of feature X, feature X belongs in `core/`.

---

## 8. Is the OpenClaw gateway-channel pattern the right template?

**Yes, partly.** The dm-s-apprentice architecture is the only prior art the user has actually thought through. Its channel split (`#dm-apprentice` Q&A, `#session-notes` ingest, `#homebrew` rules, `#apprentice-log` transparency) is a good mental model: **one channel = one intent**. Scrypt's version:

| Channel | Purpose | Behaviour |
|---|---|---|
| `#scrypt-gateway` | Ask / capture / command — conversational | Any message → orchestrator classifies and dispatches |
| `#inbox` | Pure capture (fast path) | Every message → `create_note` into `notes/inbox/`. No classification. |
| `#brief` | Morning brief + daily digests | Bot-posts only |
| `#notifications` | Low-severity system / vault events | Bot-posts only, muteable |
| `#<domain>` (e.g. `#dnd`, `#scrypt-dev`) | Domain-scoped capture | Pinned message sets default `domain`, `subdomain`, `tags` for any capture |

**Where it differs:** the OpenClaw case is tightly coupled to a locally-running LLM (Qwen2.5-7B via Ollama) sitting behind the bot. Uxie's orchestrator is a Claude session in tmux — a much more capable but more expensive backend. The bot should be cheap to hit directly for the "capture now, enrich later" cases, and only dispatch to the orchestrator when asked.

**What I'd reuse:** the "any message is valid input" conversational feel, the channel-per-intent split, the "transparency log" channel concept (`#apprentice-log` → `#scrypt-log`) where the bot posts what it did so the user can audit it.

**What I'd drop:** the hard coupling between "channel" and "agent session". Discord's autocomplete + slash commands are underused in that pattern and carry a lot of ergonomic weight for a mobile UX.

---

## 9. What uxie should NOT try to do in v1

Explicit non-goals so the brainstorm stays bounded.

- **No background research scheduling.** Cron-like "run this thread every 4 hours" belongs in the orchestrator.
- **No complex knowledge-graph visualizations.** `get_report` gives a text summary; that's enough. No rendering the D3 graph as an image for now.
- **No multi-user auth / role routing.** Single owner allowlist.
- **No in-Discord note editing.** A captured note is immutable through the bot except via `update_note_metadata` (enrichment) and `add_edge`. Full editing stays in the scrypt web UI.
- **No LLM calls from uxie itself.** Uxie is dumb glue — every "smart" response is routed through the orchestrator. This keeps scrypt's own non-goal intact (scrypt never invokes a completion model).
- **No custom storage.** Everything persistent lives in scrypt. The only uxie-local state is an idempotency dedup table + notification mute registry + last-known correlation ids.
- **No attempts to replace the web UI.** If a feature is easier in the browser, the bot should link to it, not reimplement it.
- **No Discord voice-channel streaming.** Voice files uploaded as attachments = fine; live voice transcription = a later milestone.
- **No auto-tagging by the bot.** Tags either come from the user or from the orchestrator's enrichment pass. The bot never guesses tags.

---

## 10. Feature cards

Each card: **Name → what it does → MCP/REST tools called → why mobile → MVP vs. ambitious → open questions.** 11 cards.

---

### FC-01 — Morning Brief

- **What:** 8am push to `#brief` with today's scrypt "state of the world": journal stub, top 3 open threads, 5 recent notes, active memories, hot tags.
- **Calls:** `GET /api/daily_context` (single call). Optional `get_report` for hubs/orphans.
- **Why mobile:** this is THE reason to check Discord before anything else in the morning. One embed, everything at a glance.
- **MVP:** raw `daily_context` rendered in a single embed, no commentary.
- **Ambitious:** orchestrator takes the bundle and narrates it in prose ("You've got 3 stale threads. The SVE2 one is 5 days old and tagged research/arm — want to run it?"), proposes 1-3 actions as buttons.
- **Open questions:** Time zone? Post to `#brief` channel or DM? Include a "skip tomorrow" mute? What happens on weekends?

---

### FC-02 — Quick Capture (DM + `#inbox`)

- **What:** DM the bot or post in `#inbox`; becomes a note. Bot replies with the note permalink and a reaction-based enrichment CTA.
- **Calls:** `create_note` (MCP). Optional reaction 🧠 → orchestrator enrichment job → `update_note_metadata`.
- **Why mobile:** friction-free. The "open the app, type, tap share" loop is the thing people actually do ten times a day; everything else is aspirational.
- **MVP:** plain text message → `create_note` into `notes/inbox/{slug}.md` with the message as the body, `kind=note`. Reply with the vault-relative path and a green check once embedding finishes.
- **Ambitious:** channel context determines folder (`#dnd-inbox` → `research/dnd/inbox/`). Reaction UI: 🧠 enrich, 📌 pin to journal today, 🔗 link to the most recent note, ❌ trash. Attachments (images, audio) ingested as files + a stub note.
- **Open questions:** Do captures auto-embed synchronously (block on the MCP progress) or fire-and-forget? Does bot allow the user to *undo* a capture within N seconds? Should captures get auto-generated titles from the first N chars, or leave title blank?

---

### FC-03 — `/ask` — Semantic Search with Citations

- **What:** Natural-language recall. `/ask what did I write about arm sve2` → top 5 chunks with snippets + links.
- **Calls:** `semantic_search` (MCP). Optional follow-up `get_note` for the winning chunk.
- **Why mobile:** searching the web UI on a phone is miserable. This is the single highest-ROI "I know I wrote this somewhere" feature.
- **MVP:** 5 results, each with note title, snippet, cosine score, path. Clickable buttons: "open note", "more like this".
- **Ambitious:** orchestrator composes a direct answer from retrieved chunks + cites ("You wrote about ARM SVE2 in research/arm-sve2-intrinsics.md on 2026-04-12 — the key point was…"). Follows the dm-s-apprentice "factual first, always cite" principle.
- **Open questions:** Default `limit`? `min_score` cutoff? Filter by `folder` from channel pin? Per-user query history for autocompletion?

---

### FC-04 — `/search` — FTS5 Exact Keyword Search

- **What:** Fast, deterministic keyword search. `/search client_tag` → exact matches.
- **Calls:** `search_notes` (MCP, FTS5).
- **Why mobile:** cheap, instant, zero-LLM; the fallback when semantic is overkill.
- **MVP:** paginated results with highlights, 10 per page.
- **Ambitious:** query syntax passthrough (`/search title:foo tag:bar`), autocomplete from recent queries, saved searches per user.
- **Open questions:** How do we render FTS5's `<mark>` highlights in Discord embeds (no HTML)? Markdown bold?

---

### FC-05 — `/journal` — Append to Today

- **What:** Append a timestamped entry to `journal/{YYYY-MM-DD}.md`.
- **Calls:** `POST /api/ingest` with `kind=journal` (cleaner than `create_note` since the side-effect logic is already in the smart router).
- **Why mobile:** the phone is where journal entries happen. Typing in Discord is faster than opening the scrypt web UI on mobile.
- **MVP:** `/journal <text>` appends under `## HH:MM UTC`. Creates today's file from `templates/daily.md` if missing.
- **Ambitious:** `/journal mood:good energy:low` slash options map to frontmatter. Threaded replies on the response message append additional lines under the same heading. Voice-note upload → transcription → journal line.
- **Open questions:** Time zone handling — user wall clock or UTC? Should there be a distinct `#journal` gateway channel where any message becomes a journal line, bypassing the slash command entirely?

---

### FC-06 — `/threads` — Triage Open Threads

- **What:** List open threads with status, priority, neglect age. Inline buttons to change status or kick a research run.
- **Calls:** `GET /api/threads?status=open,in-progress` + `PATCH /api/threads/:slug` for updates. `POST /api/research_runs` (or orchestrator dispatch) for "run now".
- **Why mobile:** the user wants to look at their backlog from the bus, not only from the laptop.
- **MVP:** paginated list, read-only + `/thread :slug status:done` update command.
- **Ambitious:** full button-driven triage (Defer / Promote / Resolve / Run Now / Snooze 7d), with a `last_run` pill showing neglect. Scheduled nag in `#brief` when anything goes stale.
- **Open questions:** Should the Run-Now button dispatch a *new* research run or only if `last_run` is older than N days? Where does the "I'm watching this" state live?

---

### FC-07 — `/state` — Graph Report

- **What:** Vault health snapshot: node/edge counts, top hubs, communities, orphans, suggested questions.
- **Calls:** `get_report` (MCP). Already returns a markdown document ready to embed.
- **Why mobile:** single tap to "how's my brain doing?" — genuinely useful as a checkin.
- **MVP:** raw `get_report` in an embed, truncated to the first ~1500 chars with a "full report" button.
- **Ambitious:** orchestrator converts the report into 2-3 suggested actions ("You have 14 orphan notes — want me to propose wikilinks?"). Weekly digest post. Sparkline of nodes/edges over time (requires uxie-local history table).
- **Open questions:** Should the bot cache the report and only refresh when a write happens? How often does it get stale?

---

### FC-08 — Enrich This Note

- **What:** A reaction on any captured-note embed kicks off an orchestrator pass that adds description, auto_tags, entities, themes.
- **Calls:** Orchestrator job → `get_note` → LLM extraction → `update_note_metadata`. Potentially followed by `add_edge` suggestions.
- **Why mobile:** the user captures in one tap; enrichment happens async; they come back later and see it already done.
- **MVP:** 🧠 reaction → enrichment job → bot edits the original embed with the new metadata. No edge suggestions.
- **Ambitious:** the orchestrator also proposes 3-5 `add_edge` candidates, each with a confidence and a reason; user accepts with 👍 per edge. Dm-s-apprentice's "transparent learning" — bot posts a small line to `#scrypt-log` when enrichment happens.
- **Open questions:** Does this run synchronously on capture (slower, better UX) or only on demand (cheaper)? If the orchestrator is down, do we queue or reject? How do we prevent "enrichment thrash" on notes that get captured-then-edited quickly?

---

### FC-09 — Vault Live Feed (`#notifications`)

- **What:** Bridge `vault:embedding` WebSocket events into a throttled Discord feed. Also bridges thread status changes, new orphan notes, new hub nodes, git autocommit snapshots.
- **Calls:** WebSocket client subscribed to `vault:embedding` + poll `GET /api/activity?since=…` for non-WS events.
- **Why mobile:** low-signal background awareness; the user sees the vault breathing.
- **MVP:** one coalesced "indexed N notes in Ms" message per reindex batch. Thread status changes as single-line updates.
- **Ambitious:** per-event type subscriptions with `/subscribe embedding,threads,orphans`, muteable per-type, per-hour digest mode. Correlation ids so a captured note's embedding event is rendered as an edit to the capture-reply rather than a new message.
- **Open questions:** Is the WebSocket reachable from uxie's deployment? (Same Tailscale mesh, so yes, but needs a persistent connection.) How aggressive is the coalescing window — 5s, 30s, 5min? Is the git-commit event a notification or silent?

---

### FC-10 — `/link` — Add Graph Edge

- **What:** Create a semantic edge between two notes (or sections) from Discord. `/link source:foo target:bar relation:elaborates`.
- **Calls:** `add_edge` (MCP). Autocomplete on `source`/`target` backed by `search_notes`.
- **Why mobile:** you remember the connection but not the note path; autocomplete fixes that.
- **MVP:** slash command, relation as a string enum (the 6 documented ones), `confidence` defaults to `extracted`.
- **Ambitious:** "link from this" button on any note embed → picks source automatically, user only types target; orchestrator suggests a reason; bidirectional linking with `add_edge` twice.
- **Open questions:** Should we expose `remove_edge`? (Risky; probably no for v1.) Do we allow section-id targets, and if so, how does autocomplete surface them?

---

### FC-11 — Gateway Channel (`#scrypt`) with Intent Classification

- **What:** A conversational channel where any message is classified as capture / query / command / journal by the orchestrator and dispatched accordingly. Threaded replies per message.
- **Calls:** Orchestrator classifier → one of: `create_note`, `semantic_search`, `get_note`, `PATCH /api/threads/:slug`, etc.
- **Why mobile:** this is the "one channel, no thinking" surface. Matches how the user already uses dm-s-apprentice.
- **MVP:** classifier with 3 intents only — CAPTURE, QUERY, JOURNAL. Anything else → reply "I didn't understand, use a slash command". Per-message thread for replies.
- **Ambitious:** full conversational continuation ("more detail on the third one"), pinned-message channel context (so `#dnd-gateway` scopes everything to `research/dnd/`), persistent per-thread conversation state so follow-ups work.
- **Open questions:** How do we avoid the orchestrator-is-down failure mode making the channel look broken? Fallback: if orchestrator times out, default to CAPTURE. Is classifier cost acceptable (one Claude call per inbound message)?

---

## 11. Cross-cutting open questions for team-lead

These are the scope calls I deliberately *did not* guess — flagging for decision before the real brainstorm:

1. **Direct MCP vs via-orchestrator for writes** — my recommendation is hybrid (direct for structural writes, orchestrator for LLM-shaped ones) but worth an explicit ack.
2. **Auto-embed on capture** — block on the embedding call (slower reply, richer search same-second) vs fire-and-forget (instant reply, eventual consistency)?
3. **Multi-integration architecture in v1** — pay the abstraction cost on day 1 or start scrypt-only and refactor at integration #2?
4. **Gateway channel depends on a running orchestrator** — is the orchestrator being built in parallel, or after uxie v1?
5. **Capture priority** — if only one of {capture, search, brief} ships in v1, which?
6. **Voice-note support in v1** — yes/no/later?
7. **`remove_edge` exposure** — probably not, but confirm.
8. **Time-zone handling** — UTC everywhere, or store wall-clock in frontmatter and convert on display?

---

## 12. Fast recap (one paragraph)

Uxie should be a thin discord.js v14 shell that owns idempotency, channel context, notifications, and a tiny integration registry, and whose scrypt integration exposes the Wave 8 MCP surface plus the `/api/daily_context` + `/api/ingest` REST endpoints. The interaction model is hybrid: structured slash commands for everything predictable, a gateway channel for conversational capture/query, and a dedicated `#brief` / `#notifications` pair for push. The 11 feature cards above are all cheap 1:1 wrappers over the existing scrypt surface — no new primitives, no new storage — plus an optional orchestrator dispatch layer for LLM-shaped features. Defer in v1: background scheduling, complex graph visualizations, multi-user, in-Discord editing, LLM calls originating from uxie itself. Steal the channel-per-intent pattern from `dm-s-apprentice`, but keep slash commands first-class so the bot degrades gracefully when the orchestrator is down.
