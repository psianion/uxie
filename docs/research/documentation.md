# Deep Research — Dimension: Documentation

**Project:** uxie (SUP User plane — stateless Discord → Scrypt translation layer)
**Runtime:** Bun + TypeScript + discord.js@^14.26.2
**Scope:** the documentation *system* that keeps docs truthful as code lands.
**Date:** 2026-06-03
**Status of repo:** docs-only, no code yet. This research informs the build workflow.

---

## 1. Context recap (what the spec already locks)

uxie's doc layer already exists and is opinionated. Before recommending anything, here is the inherited system this research must *build on, not replace*:

- **Source-of-truth rule.** `SUP-GUIDELINES.md §13`: "Update the doc *before* implementing changes that contradict it. The doc is the source of truth, code follows." Also: "One doc, three locations… keep them byte-identical. Versioning: bump the 'Last updated' date and add a one-line entry at the bottom of [§13]." Tie-breaker: "When in doubt, prefer the rule that protects the boundary between planes."
- **Existing doc files** (under `docs/`): `SUP-GUIDELINES.md` (system, three planes), `UXIE-DISCORD-GUIDELINES.md` (24 numbered sections — the operating doc), `discordjs-api-surface.md` (symbol-level USE/LATER/NEVER), `discordjs-research.md`, `scrypt-integration-context.md`, `scrypt-feature-ideation.md`, `spec-consistency-report.md` (the drift register), plus `superpowers/specs/2026-04-14-uxie-design.md` (Design Spec, §§1–13) and `superpowers/plans/2026-04-14-uxie.md` (26-task plan, Waves 0–4).
- **Each doc already carries a Revision Log** (Design §13, UXIE §24, SUP §13). The discipline exists; it is not centralized.
- **Two READMEs are already named *and drafted* in the spec.** The top-level `README.md` body is fully written inside *Plan Task 5* (Discord prereqs, Scrypt prereqs, Run). `integrations/README.md` and `integrations/para-raid/README.md` bodies are fully written inside *Plan Task 14*.
- **The module seam is "a folder convention and a naming discipline, not an `Integration` interface"** (Design §3.2). The contract for module #2 authors is prose in `integrations/README.md`: own your commands/handlers/HTTP-clients/env-namespace, never reach into a sibling module, export one `register<Name>Integration(bot)` entry point.
- **Env field names are frozen** in `UXIE-DISCORD-GUIDELINES §17.1` (9 fields). `.env.example` must match verbatim (Plan Task 1; Task 2 has a "fails with field name" test and a `process.env`-only-here banner comment).
- **Secret-rotation runbook is explicitly TBD**: `SUP-GUIDELINES §6` → "Rotation runbook lives in `docs/runbooks/secret-rotation.md` (TBD)."
- **The consistency loop already ran once.** `spec-consistency-report.md` lists 16 rows; its §3 mandates the fix order — *edit the design spec first, then the plan* ("Do not invert the order. Editing the plan first will leave the design as a stale upstream reference").

### Drift rows this dimension must reconcile (the baseline's stale-reference gap)

The baseline flags drift **#7, #11, #16** as "stale references that no longer match locked decisions." Reading the *current* docs against the report:

| Row | Report says | Current doc reality | Verdict |
|-----|-------------|---------------------|---------|
| #7 | Plan Task 1 pins `discord.js ^14.16.0` | Locked decision + Plan Revision Log say `^14.26.0` | **Report row is now obsolete.** Reconcile by marking #7 *Resolved*. |
| #11 | Design §3.2 + compose pin scrypt to `:3777` | Design §3.2 now reads `http://scrypt:3000`; Plan Revision Log records ":3777 → :3000" | **Report row stale.** Mark #11 *Resolved*. |
| #16 | Task 12 fake interaction uses boolean `ephemeral` | Plan Revision Log records "replaced every `{ ephemeral: true }` with `{ flags: MessageFlags.Ephemeral }`" | **Report row stale.** Mark #16 *Resolved*. |

So the reconciliation work is **closing out the report, not changing the code**. The report has no *status* mechanism, so resolved rows rot in place — exactly the #7/#11/#16 problem. Fix is a Status column (Recommendation D2).

---

## 2. Recommended approach & rationale

### 2.1 Two-layer doc model: *Governing* vs *Derived/operational*

Make explicit the split the spec already implies:

- **Governing docs (hand-written, source of truth, revision-logged, edit-BEFORE-code):** `SUP-GUIDELINES.md`, `UXIE-DISCORD-GUIDELINES.md`, the Design Spec, `discordjs-api-surface.md`. They own the rules.
- **Derived/operational docs (follow code, some auto-generated, edit-WITH-or-AFTER-code):** `README.md`, `docs/COMMANDS.md` (generated), `docs/runbooks/*`, ADRs, `CONTRIBUTING.md`, `CHANGELOG.md`, mermaid diagrams.

Rationale: the source-of-truth inversion only makes sense for rule-bearing docs. A generated command table that *lagged* code, or a CHANGELOG entry written before the change, would be self-contradictory. Tagging each doc's layer tells a contributor whether to edit-doc-first or edit-doc-after, and prevents the dangerous case of a derived doc being treated as a rule.

### 2.2 Anti-comment-rot stance: self-documenting code + a narrow comment allow-list

2025 consensus (TSDoc.org; Microsoft TSDoc; DeepDocs; "self-documenting code vs comments" literature): the primary danger of comments is **obsolescence** — refactors update code but forget comments, so comments rot and become actively misleading. Self-documenting code (clear names, small functions) cannot rot because renaming is compiler-forced.

uxie should adopt a **narrow inline-comment allow-list**, not a "document everything" TSDoc mandate. Four comment kinds earn their keep, and three already appear as banner comments in the plan (see Plan Revision Log):

1. **Banner / invariant comments** pinning a non-obvious *rule* the type system can't enforce. The plan already mandates: `// process.env only read here`, `// no try/catch in command body — error router is the only catch site`, `// Catch site #N of 3`, `// v1 uses classic embeds only — Components V2 is v1.5+`. Highest-value comments in the repo: they encode a constraint a future edit would otherwise silently violate.
2. **"Why, not what"** — constraint rationale (e.g. *why* per-call MCP connections; *why* `client.ping ?? -1`).
3. **Spec back-references** — `// per UXIE-DISCORD-GUIDELINES §14.2`. The plan already does this.
4. **TSDoc `/** */` only on public seam surfaces** module #2 / future-you will call without reading the body: `withOwnerGate()`, `assertOwner()`, `makeClientTag()`, the `ScryptRestClient`/`ScryptMcpClient` public methods, the embed builders, and `dispatch()` in the orchestrator stub. **Not** on private helpers, test files, or trivial getters (TSDoc.org: "creating TSDoc for trivial methods adds clutter").

A *convention*, not tooling — no `typedoc` build in v1 (it would be the unused machinery the spec resists). Enforced by the PR checklist (§2.6) and review, not CI.

### 2.3 Auto-generate the command reference from the builders (don't hand-maintain it)

`SlashCommandBuilder#toJSON()` returns a stable `RESTPostAPIChatInputApplicationCommandsJSONBody` — `{ name, description, options: [{ name, description, type, required }] }` (confirmed against discord.js 14.26.2 via context7). The deploy path already materializes this exact array (`Plan Task 14, deploy-commands.ts` maps `c.data.toJSON()`). A tiny second script renders the same array to a markdown table.

This kills the single most rot-prone doc in any bot repo: the hand-written command list that drifts the moment someone adds an option. The generated `docs/COMMANDS.md` is *derived* (layer 2); a CI/pre-push check fails the change if it's stale (regenerate-and-diff). Serves the mandate "auto-generating a command reference from SlashCommandBuilder definitions" with **no runtime dependency** — it reuses code the plan already writes.

### 2.4 Runbook fills the named-but-TBD gap, aligned to the smoke ritual

`SUP §6` names `docs/runbooks/secret-rotation.md (TBD)`; `SUP §7` defines rollback/backup invariants. uxie already has a fully-specified **smoke ritual** (Design §8.4, 10 steps) and **boot contract** (env validates → exit 1 with field name; `process.on` catch site #3). The runbook layer should be thin and *reference* these, not restate them. Runbook best practice (oneuptime, Vercel Academy, Rootly): metadata header (owner, version, last-tested date) + numbered steps + rollback section + "no secrets in the doc; link the secret store." This is the one genuinely *new* artifact this dimension must author, because the spec marks it TBD.

### 2.5 ADRs: lightweight, append-only, plane-boundary-gated

The codebase already *makes* architecture decisions and records rationale inline in revision logs (e.g. "decision: helper option (a) chosen — preserves the 26-integer-task pin"). That is an ADR in disguise. Formalize a **MADR-minimal** ADR (adr.github.io / Nygard / MADR) but gate it hard: write one **only** when a decision (a) affects a plane boundary, (b) is hard to reverse, or (c) was contested with a real alternative. v1 backfills ~3 ADRs from decisions already made (stateless/per-call MCP; three catch sites; folder-convention-not-`Integration`-interface). MADR lifecycle: **never edit an accepted ADR — supersede it with a new one and link** (preserves the thinking trail). Numbered, immutable, in `docs/adr/`.

### 2.6 CONTRIBUTING + PR template that *encodes the constraints as a checklist*

The repo has an unusually crisp, finite rule set (the HARD CONSTRAINTS + ANTI-PATTERNS lists), which makes a PR checklist far more valuable here than usual: the reviewer (often future-you) can mechanically verify a closed list. Practice (Graphite, GitHub Docs, Axolo): `.github/PULL_REQUEST_TEMPLATE.md` auto-populates every PR. uxie's checklist should be the *project's own invariants*: owner gate is line 1, no try/catch in command bodies, `MessageFlags.Ephemeral`, classic embeds only, no env reads outside `lib/env.ts`, no cross-module imports, doc-before-code for governing docs, intent changes bump UXIE §5, regenerate `COMMANDS.md`.

### 2.7 Mermaid for the two diagrams that matter

GitHub renders ```mermaid fenced blocks natively (since 2022); diagrams-as-code live in version control and diff in PRs (github.blog; mermaid-js). uxie needs exactly two diagrams, both describable from existing prose: (1) **plane-boundary** (User→Data plane, allowed/forbidden — encodes SUP §3) and (2) **request data-flow** (`/capture` and `#inbox` → REST `/api/ingest`; `/ask`/`/search` → MCP). Keep it to two — more diagrams = more rot surface, against the spec's minimalism. See Open Question 5 on *where* they live (derived vs governing).

### 2.8 Keep the consistency-report loop alive

`spec-consistency-report.md` is a living doc but has no *status* mechanism — rows go stale (the #7/#11/#16 problem). Add a **Status** column (`Open / Resolved (sha) / Won't-fix`) and a standing instruction: re-run the report (a) before each Wave and (b) whenever a governing doc changes. The report becomes a recurring gate, not a one-shot artifact.

---

## 3. Recommended docs tree (concrete)

```
uxie/
├── README.md                         # MANDATORY v1 — quickstart, env table, command-ref link, deploy
├── CHANGELOG.md                      # MANDATORY v1 — Keep-a-Changelog, human-curated, ties to git tags
├── CONTRIBUTING.md                   # MANDATORY v1 — invariant checklist + doc-before-code rule
├── .env.example                      # MANDATORY v1 — 9 fields verbatim per UXIE §17.1
├── .github/
│   └── PULL_REQUEST_TEMPLATE.md      # MANDATORY v1 — constraint checklist
├── scripts/
│   └── gen-command-docs.ts           # MANDATORY v1 — toJSON() → docs/COMMANDS.md
├── docs/
│   ├── COMMANDS.md                   # GENERATED v1 — do-not-edit banner; CI diff-checks freshness
│   ├── SUP-GUIDELINES.md             # governing (existing)
│   ├── UXIE-DISCORD-GUIDELINES.md    # governing (existing)
│   ├── superpowers/specs/…design.md  # governing (existing)
│   ├── superpowers/plans/…uxie.md    # governing (existing)
│   ├── discordjs-api-surface.md      # governing (existing)
│   ├── spec-consistency-report.md    # living register (existing) + Status column
│   ├── adr/
│   │   ├── README.md                 # v1 — index + "when to write an ADR" gate
│   │   ├── 0001-stateless-per-call-mcp.md
│   │   ├── 0002-three-catch-sites.md
│   │   └── 0003-folder-convention-not-integration-interface.md
│   └── runbooks/
│       ├── boot-and-smoke.md         # v1 — boot contract + the 10-step smoke ritual
│       ├── rollback.md               # v1.5 — references SUP §7 invariants
│       └── secret-rotation.md        # v1.5 — fills the SUP §6 TBD
└── src/integrations/
    ├── README.md                     # MANDATORY v1 — module seam contract (drafted in Plan Task 14)
    └── para-raid/README.md           # MANDATORY v1 — module #2 placeholder (drafted in Plan Task 14)
```

**Mandatory-for-v1 set:** `README.md`, `.env.example`, `integrations/README.md`, `integrations/para-raid/README.md`, `CONTRIBUTING.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `CHANGELOG.md`, `docs/COMMANDS.md` (+ generator), `docs/runbooks/boot-and-smoke.md`, the 3 backfill ADRs + `docs/adr/README.md`. Everything else (rollback + secret-rotation runbooks, more ADRs) is v1.5.

---

## 4. Code / interface sketches

### 4.1 `scripts/gen-command-docs.ts` — auto command reference (reuses the deploy array)

```ts
// scripts/gen-command-docs.ts
// Renders docs/COMMANDS.md from the SAME builder array the deploy script ships.
// Run: bun run docs:commands   (CI/pre-push runs it then `git diff --exit-code docs/COMMANDS.md`)
import { writeFileSync } from "node:fs";
import { parseEnv } from "../src/lib/env.ts";
import { buildScryptModule } from "../src/integrations/scrypt/index.ts";

const OPT_TYPE: Record<number, string> = { 3: "string", 5: "boolean", 11: "attachment" }; // ApplicationCommandOptionType

const cmds = Array.from(buildScryptModule(parseEnv()).commands.values())
  .map((c) => c.data.toJSON())                 // RESTPostAPIChatInputApplicationCommandsJSONBody
  .sort((a, b) => a.name.localeCompare(b.name));

let md = `<!-- GENERATED by scripts/gen-command-docs.ts — do not edit by hand. Run \`bun run docs:commands\`. -->\n# uxie command reference\n\n`;
for (const c of cmds) {
  md += `## /${c.name}\n\n${c.description}\n\n`;
  if (c.options?.length) {
    md += `| option | type | required | description |\n|---|---|---|---|\n`;
    for (const o of c.options) {
      md += `| \`${o.name}\` | ${OPT_TYPE[o.type] ?? o.type} | ${"required" in o && o.required ? "yes" : "no"} | ${o.description} |\n`;
    }
    md += `\n`;
  }
}
writeFileSync(new URL("../docs/COMMANDS.md", import.meta.url), md);
```

Note: `parseEnv()` is needed only because module construction takes `Env`; the generator never reaches the network. If that coupling is unwanted, expose an env-free `buildScryptCommandData()` (Open Question 2).

### 4.2 TSDoc convention — what a sanctioned doc comment looks like

```ts
/**
 * First line of every command/inbox handler. Throws {@link NotOwnerError}
 * if the actor is not the single configured owner.
 *
 * Single-owner is a security invariant, not a feature — see
 * UXIE-DISCORD-GUIDELINES §17.3 and §22 (no roles, no permission tiers).
 *
 * @param actor - the interaction or message author
 * @param ownerId - resolved once from env.DISCORD_OWNER_ID
 */
export function assertOwner(actor: BaseInteraction | Message, ownerId: string): void { … }
```

Counter-example (do **not** write): `/** Returns the embed. */` on `captureEmbed` whose name already says it. Use a banner only where a rule hides:

```ts
// NO try/catch in this file. The interaction-router boundary is the only catch
// site for command bodies (UXIE-DISCORD-GUIDELINES §14.2, catch site 1 of 3).
```

### 4.3 ADR template (MADR-minimal) — `docs/adr/0001-stateless-per-call-mcp.md`

```md
# 1. Stateless translation layer; per-call MCP connections

Date: 2026-06-03
Status: Accepted

## Context
uxie is the SUP User plane and must not hold business state (SUP §2–3).
A long-lived MCP connection is in-memory cross-interaction state and a
harder reconnection failure mode.

## Decision
No in-memory cache of results between interactions. Open one MCP connection
per call, close it. Idempotency is server-side via deterministic client_tag.

## Consequences
+ No cache-coherence or reconnect-backoff code; plane boundary stays clean.
− A few ms connect cost per read. Acceptable for a single-user bot.

## Alternatives considered
- Pooled/long-lived MCP client — rejected: stateful, anti-pattern (§22).

Supersedes: none.  Superseded by: none.
```

### 4.4 `.github/PULL_REQUEST_TEMPLATE.md` (the invariant checklist)

```md
## What & why
<!-- one line; link the spec section or ADR this implements -->

## Constraint checklist (uxie invariants — all must hold)
- [ ] `assertOwner(...)` is the FIRST line of every new command / inbox handler
- [ ] No `try/catch` inside a command body (router boundary is the only catch site)
- [ ] Every reply uses `{ flags: MessageFlags.Ephemeral }` (no boolean `ephemeral`)
- [ ] Classic embeds only — no Components V2 (`IsComponentsV2`) in v1
- [ ] No `process.env` access outside `src/lib/env.ts`
- [ ] No cross-module imports (`integrations/scrypt` ⇄ `integrations/para-raid`)
- [ ] No new gateway intent — or, if added, UXIE-DISCORD-GUIDELINES §5 is bumped
- [ ] Governing-doc change (if any) landed BEFORE the code change (SUP §13)
- [ ] `bun test` + `bun run typecheck` green
- [ ] If a command/option changed: ran `bun run docs:commands` and committed `docs/COMMANDS.md`
- [ ] CHANGELOG.md updated under `## [Unreleased]`
```

### 4.5 `docs/runbooks/boot-and-smoke.md` (header + structure)

```md
# Runbook: boot & smoke
Owner: @owner · Version: 1 · Last-updated: 2026-06-03 · Last-tested: <date>

## Boot contract
1. `parseEnv()` validates 9 fields → on failure exit 1 naming the field (UXIE §17.1).
2. Top-level `process.on('uncaughtException'|'unhandledRejection')` → log + exit 1; Docker/systemd restarts.

## Smoke ritual (Design §8.4 — all 10 must pass before ship)
<!-- 7 happy-path + 3 failure-mode steps; link the section, do not restate -->

## Rollback → see runbooks/rollback.md (SUP §7)
## Secrets → never in this file; rotation in runbooks/secret-rotation.md
```

---

## 5. Prioritized recommendation table

| ID | Recommendation | Priority | Effort | Conflicts spec? |
|----|----------------|----------|--------|-----------------|
| D1 | Two-layer doc model (governing vs derived); tag each doc | v1 | S | No |
| D2 | Add **Status** column to `spec-consistency-report.md`; mark #7/#11/#16 *Resolved*; re-run report each Wave + on governing-doc change | v1 | S | No |
| D3 | Narrow inline-comment allow-list (4 kinds) + TSDoc only on public seam surfaces; codify in CONTRIBUTING | v1 | S | No |
| D4 | `scripts/gen-command-docs.ts` → generated `docs/COMMANDS.md`; diff-check freshness | v1 | M | No |
| D5 | `docs/runbooks/boot-and-smoke.md` (boot + smoke, references Design §8.4) | v1 | S | No |
| D6 | `docs/adr/` + 3 backfill ADRs (MADR-minimal, append-only, plane-boundary gate) | v1 | M | No |
| D7 | `CONTRIBUTING.md` + `.github/PULL_REQUEST_TEMPLATE.md` invariant checklist | v1 | M | No |
| D8 | `CHANGELOG.md` (Keep-a-Changelog) tied to git tags; PR adds an `[Unreleased]` line | v1 | S | No |
| D9 | README env table derived/checked against `lib/env.ts` zod schema (single field-list source) | v1.5 | M | No |
| D10 | Two mermaid diagrams (plane-boundary + request data-flow) | v1.5 | S | No |
| D11 | `docs/runbooks/secret-rotation.md` (fills SUP §6 TBD) + `rollback.md` | v1.5 | M | No |
| D12 | SUP-GUIDELINES 3-copy sync: `scripts/check-sup-sync.sh` (sha256 compare across the 3 repos) | v1.5 | M | No |
| D13 | `typedoc` HTML API site for the seam surface | v2 | M | No |
| D14 | ADR linting + ADR-required gate on architectural-path changes | v2 | M | No |

---

## 6. Conflicts with spec

**None of the recommendations conflict with a locked decision.** The design deliberately leaves the doc-system layer (README depth, ADRs, runbook bodies, comment convention, command-ref generation, CONTRIBUTING) unspecified or marked TBD, so this dimension fills gaps rather than overriding rules. Three guardrails were observed to *avoid* a conflict:

- **No `typedoc`/doc-gen runtime dependency in v1.** The dep lock is `discord.js` + `zod` only (HARD CONSTRAINT). D4's generator is a `bun run` dev script importing existing code, not a new dependency; `typedoc` (D13) is deferred to v2 for that reason.
- **D9 (README env table from zod) must not introduce a second env field list.** `lib/env.ts` stays the single source; the README table is *derived*, never hand-duplicated, or it violates the §17.1-verbatim constraint. Marked v1.5 so it lands after the schema exists.
- **No doc recommendation weakens an anti-pattern.** The PR checklist (D7) and ADRs (D6) *reinforce* the owner-gate, no-try/catch, ephemeral, no-cross-module-import, and intent-bump rules.

(If a future contributor wanted `COMMANDS.md` or ADRs to become *governing* docs that gate code, that would invert the layer model in §2.1 and *would* conflict — they are intentionally derived/append-only, not source-of-truth.)

---

## 7. Open questions

1. **Three-copy SUP-GUIDELINES sync (D12):** the three repos (scrypt, para-raid, uxie) are siblings on disk (the spec references `../scrypt`, `../para-raid`). Is there a shared CI runner that can sha256-compare the three copies, or does sync stay manual pre-commit discipline until the monorepo/submodule "future improvement" lands?
2. **`gen-command-docs.ts` env coupling:** building the scrypt module needs a valid `Env`. Acceptable to require a dummy `.env` for the docs script, or expose an env-free `buildScryptCommandData()` (tiny refactor) — v1 or v1.5?
3. **CHANGELOG granularity for a single-user bot:** does a private single-owner bot need Keep-a-Changelog rigor, or is the per-doc Revision Log + git tags enough? The recommendation assumes a light root CHANGELOG; confirm it's not ceremony.
4. **ADR backfill scope:** three proposed (stateless/per-call-MCP, three-catch-sites, folder-convention). Other already-made decisions worth immortalizing now (e.g. `withOwnerGate()` helper option (a); guild-scoped over global command registration)?
5. **Diagram authority (D10):** if the Design Spec (a governing doc) gains a mermaid diagram, the diagram becomes source-of-truth and can itself rot. Should diagrams live only in *derived* docs (README/runbook) and be *referenced* from governing docs, to keep the edit-doc-first burden off pictures?
6. **CI availability in v1:** D4 diff-check and D12 sync-check assume a CI runner. v1 is Docker Desktop only with no stated CI — should these be git pre-push hooks until prod CI exists?

---

## 8. Sources

Internal (source of truth — read in full):
- `docs/SUP-GUIDELINES.md` §3 boundary rules, §6 secrets layout + rotation-runbook TBD, §7 ops/rollback, §13 document conventions + revision log.
- `docs/UXIE-DISCORD-GUIDELINES.md` §5 intents (+doc-bump rule), §11 module pattern + rules, §14.2 three catch sites, §17.1 env fields / §17.2 redaction / §17.3 owner gate, §21 versioning, §24 revision log.
- `docs/superpowers/specs/2026-04-14-uxie-design.md` §3.1–3.3 architecture/layout, §4 file layout, §8.4 smoke ritual, §12 references, §13 revision log.
- `docs/superpowers/plans/2026-04-14-uxie.md` Task 1 (deps/.env.example), Task 5 (README body, Dockerfile, compose), Task 14 (`integrations/README.md` + `para-raid/README.md` bodies, deploy-commands `toJSON()` map), Revision Log.
- `docs/spec-consistency-report.md` §2 drift list (rows #6, #7, #11, #16), §3 fix-order rule.
- `docs/scrypt-integration-context.md` §3 (deterministic `client_tag`, server-side idempotency).

External (best-practice, 2025–2026):
- discord.js 14.26.2 — `SlashCommandBuilder#toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody`, command/option JSON shape (context7 `/websites/discord_js_packages_discord_js_14_26_2`; https://discord.js.org/docs/packages/discord.js/14.26.2/SlashCommandBuilder:Class).
- discord.js Guide — command deployment / `command.data.toJSON()` deploy pattern (https://discordjs.guide/creating-your-bot/slash-commands.html; https://v15.discordjs.guide/creating-your-bot/command-deployment).
- ADR practice — Martin Fowler bliki ArchitectureDecisionRecord (https://martinfowler.com/bliki/ArchitectureDecisionRecord.html); MADR templates (https://adr.github.io/adr-templates/); github.com/joelparkerhenderson/architecture-decision-record; AWS Architecture Blog ADR best practices (https://aws.amazon.com/blogs/architecture/master-architecture-decision-records-adrs-best-practices-for-effective-decision-making/); Microsoft Azure Well-Architected ADR.
- TSDoc / comment-rot — https://tsdoc.org/ ; github.com/microsoft/tsdoc ; DeepDocs "8 Code Documentation Best Practices for 2025" (https://deepdocs.dev/code-documentation-best-practices/); "Self-Documenting Code vs. Comments" (https://dev.to/actocodes/self-documenting-code-vs-comments-lessons-from-maintaining-large-scale-codebases-52im); CodeSignal effective comments in TypeScript (https://codesignal.com/learn/courses/clean-code-basics-1/lessons/effective-comments-and-documentation-in-typescript).
- Runbooks — Vercel Academy Operations Runbook (https://vercel.com/academy/slack-agents/operations-runbook); oneuptime "How to Create Effective Runbooks" (https://oneuptime.com/blog/post/2026-02-02-effective-runbooks/view); Rootly incident-response runbooks (https://rootly.com/incident-response/runbooks).
- CONTRIBUTING / PR templates — GitHub Docs (creating diagrams; PR templates); Graphite "Comprehensive Checklist: GitHub PR Template" (https://graphite.com/guides/comprehensive-checklist-github-pr-template); github.com/nayafia/contributing-template.
- Mermaid — github.blog "Include diagrams in your Markdown files with Mermaid" (https://github.blog/developer-skills/github/include-diagrams-markdown-files-mermaid/); github.com/mermaid-js/mermaid; GitHub Docs "Creating diagrams".
- CHANGELOG — Keep a Changelog 1.1.0 (https://keepachangelog.com/en/1.1.0/); Common Changelog (https://common-changelog.org/).
