# Uxie Discord Bot — Scrypt Integration Context

**Date:** 2026-04-14
**Status:** Research findings (pre-brainstorm)

## 1. What Uxie is

`uxie` is the Discord bot application at `/Users/admin/Desktop/Files/uxie`. It will be the unified Discord surface for multiple user applications; Scrypt is integration #1.

## 2. Where the Discord bot fits in the Scrypt HLD

From `scrypt/docs/superpowers/specs/2026-04-14-scrypt-mcp-l5-design.md` (Wave 8 MCP L5 spec) and the scrypt vault (`research/scrypt/...`):

Scrypt has a **distributed system HLD** with these layers:
- **L5 — MCP server** (just designed in Wave 8, about to ship): exposes the vault as MCP tools over stdio + streamable-http
- **L4 — Orchestrator**: a Claude session running in tmux that autonomously drives the MCP server
- **L3 — Remote workers**: Termux / tmux agents doing background work
- **L2 — Discord bot (uxie)**: user-facing remote trigger
- **L1 — User** (phone, laptop, anywhere)

> "Remote triggering (Discord, orchestrator). Separate specs." — Wave 8 spec §2
> "Once those ten [Wave 8 success criteria] hold, Wave 8 ships and the Orchestrator + Discord bot specs can begin." — §12

The Discord bot's job is to let the user **talk to the scrypt orchestrator / vault from anywhere** (especially from a phone), without needing a terminal.

## 3. What the bot can call

Scrypt MCP (Wave 8) exposes **12 tools** over `POST /mcp` (bearer auth):

**Writes:** `create_note`, `update_note_metadata`, `add_section_summary`, `add_edge`, `remove_edge`
**Reads:** `get_note`, `search_notes` (FTS5), `semantic_search` (local bge-small embeddings), `find_similar`, `walk_graph`, `get_report`
**Admin:** `cluster_graph`

All writes are **idempotent via `client_tag`** — safe for retries.
Transport: `streamable-http` at `https://scrypt.tailnet.ts.net/mcp` + `Authorization: Bearer <token>`.
There is also a live `vault:embedding` WebSocket channel broadcasting embedding progress.

## 4. Deployment context

- Scrypt runs on Oracle Cloud ARM VM (Always Free tier)
- Tailscale mesh network
- Original PRD used Telegram for alerts; Discord bot is the evolution of that
- User mental model: phone is the primary remote console (Termius / Discord mobile)

## 5. Prior art in the user's vault

`research/dnd/ai-dm/dm-s-apprentice-architecture-spec.md` — "OpenClaw Gateway (Discord bot)" routing `#dm-apprentice` channel messages to a local service via tmux. Similar channel-as-gateway pattern is likely the template.

## 6. Known constraints / preferences

- **Single user, trusted mesh** (Tailscale) — so auth can be simple (a static bearer token the bot holds, plus Discord user allowlist)
- **Idempotency matters** — every bot action that writes must generate a UUID `client_tag`
- **Mobile-first UX** — rendering must work in Discord mobile (respect embed limits, avoid wide tables)
- **No LLM in scrypt itself** — any "smart" response shaping happens either in the bot or via a Claude orchestrator call

## 7. Open questions for brainstorming

1. Is uxie the **direct MCP client** (bot → scrypt MCP), or does it go **through the orchestrator** (bot → orchestrator → MCP)?
2. Should uxie be **multi-integration from day 1** (plugin architecture) or scrypt-first then refactor?
3. Do we want **slash commands** (`/note`, `/search`) or **natural language in a dedicated channel** (gateway pattern)?
4. Do we surface scrypt's **live WebSocket embedding progress** in Discord, or keep writes synchronous?
5. What's the minimum feature set to be useful on a phone tomorrow vs. the ambitious version?

## 8. Next steps

1. Fetch latest discord.js v14 docs (context7 + web) — slash command patterns, interaction handling, embeds, threads, voice
2. Invoke `superpowers:brainstorming` skill to explore features, constraints, and MVP scope
3. Produce a short design doc and an implementation plan
