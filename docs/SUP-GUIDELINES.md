# SUP Integration Guidelines

**S**crypt · **U**xie · **P**ara-RAID — co-located system architecture & operating principles

> **Status:** Living document. Revise as designs evolve.
> **Last updated:** 2026-04-25
> **Maintainer:** sainayan.mahto@goveva.com
> **Audience:** Anyone building, deploying, or extending Scrypt, Uxie, or Para-RAID.
> **Canonical copy:** byte-identical in `scrypt/docs/`, `uxie/docs/`, and `para-raid/docs/`. Update all three together.

---

## 1. What is SUP?

SUP is the working name for the three-app system that runs on a single Tailscale-connected VPS:

- **Scrypt** — a personal knowledge vault. Markdown-on-disk plus a SQLite index (FTS5, embeddings, graph). Speaks MCP (HTTP + bearer token).
- **Uxie** — a Discord bot that translates messages into Scrypt + Para-RAID API calls. Lets you reach the system from anywhere a phone or laptop has Discord.
- **Para-RAID** — a Bun/TypeScript HTTP daemon that orchestrates Claude Code workers (tmux sessions, turn brokering, quota management). Listens on a Unix socket. Acts as the box's control plane.

**Why bundle them?** They share a host, share secrets, share the vault, and share users. Co-location buys real synergies: zero-latency MCP for spawned Claude workers, a single ops surface, a single backup target, one log stream. The cost is coupling — which we manage through the boundary rules in §3.

**What SUP is NOT:**
- Not a multi-tenant platform. It serves one operator (today, more in a far future iteration).
- Not a public service. Tailscale-only by design.
- Not a replacement for Obsidian or other personal note-taking on the Mac. It's the *server-side* knowledge plane that complements local-first work.

---

## 2. The Three Planes

Every component in SUP belongs to exactly one plane. If you're tempted to give a component dual-plane responsibilities, **stop and split it.**

| Plane | Owner | Owns |
|---|---|---|
| **Data** | Scrypt | Vault content (markdown + SQLite). All reads and writes go through its MCP API. |
| **Ops / Control** | Para-RAID | Process lifecycle, rebuilds, backups, health, Claude worker orchestration, ingestion triggers. |
| **User** | Uxie | External-facing translation layer (Discord, future channels). Stateless. |

**Why this split matters:** Swapping any single app later — replacing Uxie with a CLI, moving Scrypt to a separate host, retiring Para-RAID for Kubernetes — becomes a contained change instead of a rewrite.

**Plane violations to actively reject:**
- Uxie writing markdown directly to `/vault` (Data-plane intrusion).
- Scrypt restarting Para-RAID workers (Ops-plane intrusion).
- Para-RAID caching vault content in its own state (Data-plane duplication).

---

## 3. Boundary Rules — Do's & Don'ts

These are *hard* rules. Violations create coupling that makes the system fragile.

### DO

- **DO** make Scrypt the only process that writes to `/vault`. All other apps read or call Scrypt's MCP.
- **DO** treat Para-RAID as the box's API. Rebuilds, backups, status, log retrieval — all surface through `/v1/ops/*`.
- **DO** keep Uxie stateless. Persistent state belongs in Scrypt or Para-RAID's data dir.
- **DO** source all secrets from `/opt/secrets/` at startup. Never bake them into images or commit them to git.
- **DO** prefer Unix sockets for same-host calls (`/var/run/para-raid.sock`, optional Scrypt MCP socket).
- **DO** reserve TCP for cross-host calls (Tailscale only — never bind to `0.0.0.0`).
- **DO** log to journald with structured JSON. One log surface for the whole box.
- **DO** version Scrypt's SQLite schema. Migrations are idempotent and run on startup.
- **DO** healthcheck before declaring rollout success. Scripts must verify, not assume.
- **DO** snapshot the vault before destructive ops (mass-delete, schema migration, restore).
- **DO** keep update scripts idempotent. Re-running should converge, not duplicate.
- **DO** treat Tailscale as part of the security boundary. If an app needs to talk over TCP, it goes through Tailscale.
- **DO** pin Docker image tags in production (`scrypt:1.4.2`, not `scrypt:latest`). Rollback needs a known previous tag.
- **DO** keep this doc in sync across all three repos. The doc is the source of truth, code follows.

### DON'T

- **DON'T** bypass Scrypt to write markdown into `/vault` from another process — the SQLite index will go stale. Use `batch_ingest` or `create_note` MCP tools.
- **DON'T** expose Scrypt's MCP port publicly. Tailscale-only, every time.
- **DON'T** bake secrets into Docker images, environment files committed to git, or shell history.
- **DON'T** make Uxie remember anything across messages beyond what Discord or Scrypt already remembers.
- **DON'T** run Para-RAID or its children as root. Use the `ubuntu` user and systemd `--user` services.
- **DON'T** conflate the ops API and the data API. Different ports/sockets, different tokens, different audit trails.
- **DON'T** `docker exec` from one container into another to do work. Use APIs.
- **DON'T** add synchronous cross-app calls without a timeout and a fallback. A slow Scrypt should not wedge Uxie.
- **DON'T** auto-update during your active working hours. Cron at off-hours, manual triggers anytime.
- **DON'T** trust input from Discord. Sanitize at the Uxie boundary — strip codeblocks of shell commands before forwarding to Para-RAID.
- **DON'T** let Para-RAID restart cycle through Scrypt as a side effect. Vault writes must survive ops events.
- **DON'T** double-auth on localhost. Unix-socket calls trust kernel uid; tokens are for cross-host hops.
- **DON'T** add features that require all three apps to be running synchronously. Each must degrade gracefully if the others are down.
- **DON'T** introduce a fourth long-running process without a plane assignment and an explicit reason.

---

## 4. Co-location Synergies

These are the wins that *only* exist because all three live on the same VPS. If you ever consider splitting the topology, audit which of these you'd lose.

1. **MCP auto-discovery for spawned Claude workers.** When Para-RAID spawns a Claude session, it injects `~/.claude/mcp.json` pointing at the local Scrypt MCP. Every worker becomes vault-aware with zero setup. **This is the most valuable synergy — protect it.**

2. **Unix-socket comms for trust-boundary-internal hops.** Para-RAID ↔ Uxie and (optionally) Para-RAID ↔ Scrypt over Unix sockets. Lower latency, kernel-level uid auth, no token plumbing.

3. **Single secret store.** `/opt/secrets/*.env` (chmod 600, owned by `ubuntu`). All three apps source it. One rotation surface.

4. **Vault as a read-only window for ops.** Para-RAID can read `/vault` for backup, du-stats, integrity checks. Writes stay forbidden — Scrypt remains authoritative.

5. **Aggregated ops surface.** `GET /v1/ops/status` returns combined health for Scrypt + Uxie + Para-RAID. One trigger rebuilds any of them. One backup covers all.

6. **Inotify-driven ingestion.** Para-RAID watches `/vault/inbox/`. You rsync markdown from your Mac, the watcher fires `batch_ingest` on Scrypt, Scrypt indexes. No manual trigger.

7. **Single journald surface.** `journalctl -u scrypt -u uxie -u para-raid -f` is your full system log.

8. **Cost telemetry collection.** Para-RAID brokers Claude turns; it can record token spend per session, per worker, per Uxie command. Single metric source.

9. **Shared healthcheck loop.** One cron, one health endpoint, one alert path. No three-way duplication.

10. **Resource accounting.** All three share the same CPU/RAM/disk pool. One `docker stats` + `systemctl status` view shows the full picture.

---

## 5. Communication Patterns

### Same-host (inside the VPS)

- Use Unix domain sockets where possible. Para-RAID daemon already does. Scrypt should expose one alongside its TCP port for local-only consumers.
- Skip bearer tokens for socket-based calls. Kernel uid trust is sufficient.
- Default permissions: socket mode `660`, group `sup` so all three apps' service users can connect.

### Cross-host on Tailscale

- TCP + bearer token in `Authorization: Bearer <token>`.
- Tailscale ACL restricts to your tailnet. Never expose to public internet.
- Use Tailscale MagicDNS hostnames (`scrypt.tail-xxxx.ts.net`) over IPs.
- Treat Tailscale as authentication-grade. Bearer tokens are belt-and-suspenders.

### From outside the tailnet

There is no "from outside the tailnet." Mac, phone (Termius/Termux), and Uxie's Discord client are all on the tailnet. If a new device needs access, add it to Tailscale first.

### MCP specifics

- Scrypt's MCP is the only public-to-the-box data API. All other apps consume it. **No direct SQLite access** from any process other than Scrypt itself.
- Para-RAID's `/v1/ops/*` is the only ops API.
- New cross-app endpoints require a plane assignment and a doc update.

---

## 6. Secrets & Auth

### Layout

```
/opt/secrets/
├── scrypt.env          # SCRYPT_AUTH_TOKEN, embedding API keys (if any)
├── para-raid.env       # PARA_RAID_OPS_TOKEN, github deploy keys
├── uxie.env            # DISCORD_BOT_TOKEN, SCRYPT_AUTH_TOKEN (read-only copy)
└── shared.env          # Tailscale auth keys, GitHub PAT for git pulls
```

- Mode `600`, owner `ubuntu:ubuntu`.
- Loaded via `EnvironmentFile=` in systemd or `env_file:` in docker-compose.
- Rotated quarterly. Rotation runbook lives in `docs/runbooks/secret-rotation.md` (TBD).

### Tokens

- `SCRYPT_AUTH_TOKEN` — gates Scrypt MCP. 32-byte hex. `openssl rand -hex 32`.
- `PARA_RAID_OPS_TOKEN` — gates Para-RAID `/v1/ops/*`. 32-byte hex.
- `DISCORD_BOT_TOKEN` — Discord-side, read-only copy in Uxie.

### Rule

**Same-host calls** never present tokens (Unix socket trust). **Cross-host calls** always present tokens AND ride Tailscale. Don't double-auth on localhost.

### Rotation

- Generate new token → write to `/opt/secrets/<app>.env` → `systemctl restart <app>` → invalidate old token in app config.
- For Scrypt: rolling rotation (accept both old and new for 24h) avoids downtime.
- For Para-RAID ops token: short downtime is acceptable; rotate quarterly or on compromise.

---

## 7. Update & Ops Flow

### Pull-based + on-demand

- **Scheduled:** Cron at 02:00 / 02:30 / 03:00 (staggered) runs `update-{para-raid,scrypt,uxie}.sh` per app.
- **On-demand:** `POST http://para-raid.sock/v1/ops/rebuild?service=…` from anywhere on the tailnet.
- **Until Para-RAID v1 ships:** `ssh para-raid 'update-scrypt'` is the on-demand trigger for Scrypt.

### Update script invariants

Each `update-*.sh` MUST:

1. Log to `/var/log/sup-updates/<app>.log` with timestamps.
2. Pre-pull healthcheck (record current state).
3. `git pull --ff-only` (no merge commits on prod).
4. Build/pull image OR install deps.
5. Restart service.
6. Post-update healthcheck. If fail → rollback to previous image tag and alert.
7. Exit non-zero on any failure.
8. Leave the system in a known state — either fully updated and healthy, or fully rolled back and healthy. Never partial.

### Rollback

- **Docker apps:** keep last 3 image tags. `docker compose up -d --force-recreate scrypt` with previous tag.
- **Para-RAID:** keep last 3 git refs. `git reset --hard <prev-sha> && systemctl --user restart para-raid`.
- Rollback is a normal path, not an emergency. Test it.

### Backups

- Para-RAID daemon owns nightly vault snapshots: `tar | gzip | push to GitHub private repo or B2`.
- Retention: 7 daily, 4 weekly, 12 monthly.
- Restore runbook lives in `docs/runbooks/vault-restore.md` (TBD).
- Backups verify: a weekly cron does a test-restore to `/tmp/restore-test/` and diffs.

---

## 8. Ingestion Pipeline

The "drop folder" pattern: Mac → rsync → VPS `/vault/inbox/` → inotify → Scrypt MCP → indexed.

```
Mac:                            VPS:
~/notes/*.md  ─── rsync ──►   /vault/inbox/*.md
                                     │
                                     ▼ (inotify watch in para-raid)
                              POST /mcp/batch_ingest
                                     │
                                     ▼
                              /vault/<organized>/*.md
                              .scrypt/scrypt.db (FTS5 + embeddings)
```

### Rules

- Drop into `/vault/inbox/`, never directly into vault root or project subdirs.
- Para-RAID's watcher handles classification + relocation via Scrypt MCP.
- Scrypt's `batch_ingest` is idempotent — re-dropping a file updates rather than duplicates.
- The Mac side is dumb rsync — no logic. All intelligence lives on the VPS.
- Failed ingests move to `/vault/inbox/.failed/` with an error log, not silently dropped.

### Why this pattern

- Decouples "I want to add a note" from "the index is up to date."
- Survives Scrypt being temporarily down — rsync still works, watcher catches up later.
- One ingestion path, one set of bugs.

---

## 9. Failure Modes & Recovery

| Failure | Detection | Recovery |
|---|---|---|
| Scrypt down | `/health` 5xx, MCP calls timeout | Restart container; verify reindex completes |
| Vault corruption | SQLite errors, healthcheck fail | Restore from last nightly snapshot |
| Para-RAID daemon crash | Systemd auto-restart; alert if 3 restarts in 5 min | Investigate logs; rollback to previous git ref |
| Uxie disconnected from Discord | Heartbeat lost | Auto-reconnect; if persistent, restart container |
| Tailscale down | All cross-host calls fail | Tailscale auto-recovers; SSH to provider console as last resort |
| Disk full | `du > 90%` | Backup retention auto-prunes; if not enough, manual cleanup of `/var/log` and Docker images |
| Token leak | Audit log shows unexpected access | Rotate immediately; revoke Tailscale device if compromised |
| Watcher loop death | Inbox files pile up, no ingest | Para-RAID supervisor restarts watcher; alert if persistent |
| Bad update | Post-update healthcheck fails | Auto-rollback to previous tag; alert via Uxie/Discord |

### Rule of recovery

**Every failure should have an automated first-response** (restart, rollback, retry) and a **manual escalation path** (logs, runbook, console). If it doesn't, that's a gap to close.

---

## 10. Open Questions

These need resolution as the specs mature. Track in respective design docs.

1. **Does Uxie call Scrypt MCP directly, or proxy through Para-RAID?**  
   *Current lean:* direct in v1, optionally proxy in v2 for audit/throttle.

2. **Where does the inotify ingestion watcher live?**  
   *Current lean:* Para-RAID daemon owns it. Less code than a separate watcher service.

3. **Multi-vault support — one Scrypt with multiple vaults, or one Scrypt per vault?**  
   *Current lean:* one Scrypt, projects-as-namespaces inside the vault.

4. **Read-replica of Scrypt on Mac for offline?**  
   *Deferred.* Possible future via Syncthing or cron rsync of markdown only (rebuild index locally).

5. **Does Uxie support non-Discord channels (Slack, Telegram)?**  
   *Out of scope for v1.* Architecturally yes (translation layer pattern), but no work planned.

6. **Should Scrypt MCP expose ops tools, or stay strictly Data-plane?**  
   *Current lean:* stay strictly Data. Ops tools live in Para-RAID. But see §11 future ideas.

7. **How do we version SUP itself across the three repos?**  
   *Current lean:* per-app SemVer, plus a top-level `SUP-COMPATIBILITY.md` matrix once we hit two breaking changes.

---

## 11. Future Ideas (Good-to-Haves)

Captured to avoid losing them. Not committed to.

- **Ops MCP tools.** Expose `rebuild_service`, `tail_logs`, `vault_stats` as Scrypt MCP tools so any Claude session — including ones not spawned by Para-RAID — can do ops via natural language. (Caveat: this blurs Plane boundaries; only do it if the value is clear.)
- **Discord-as-ops-console.** Uxie commands like `/sup rebuild scrypt`, `/sup status`, `/sup logs uxie tail=50`.
- **Voice → Vault.** Uxie accepts Discord voice notes, transcribes via Whisper, ingests to Scrypt as a daily journal entry.
- **Scheduled knowledge digests.** Para-RAID spawns a weekly Claude that summarizes `git diff` of the vault, posts to Discord via Uxie.
- **Workflow / DAG runner inside Para-RAID.** Chain Claude sessions: research → draft → review → commit. Each step a separate worker, output of one feeds the next.
- **Audit log for Scrypt.** Every mutation logged with who/what/when. Powers undo and debugging.
- **Cost telemetry dashboard.** Para-RAID exposes `/v1/ops/cost?period=…` showing token spend per worker, per Uxie user, per project.
- **Embedding model abstraction.** Scrypt today uses one embedding provider; allow swapping (local model, OpenAI, Voyage, etc.) via config.
- **Multi-tenant Para-RAID.** Multiple users sharing the box, each with their own quota, vault namespace, and Discord identity. (Far future.)
- **Local-first hybrid.** Scrypt on Mac as a read-only mirror of the server vault, syncing markdown via Syncthing. Disable indexing on Mac; rely on server.
- **Encrypted vault at rest.** age or LUKS encrypt `/vault` and `.scrypt/`. Para-RAID handles key unlock on boot.
- **Webhook ingestion.** Scrypt MCP gets a `POST /mcp/webhook/<source>` endpoint so Zapier/Make/etc. can drop content into the vault.
- **Federated Scrypt.** Two Scrypts on two boxes (work + personal), with a curated subset replicated between them.
- **Calendar-aware ingestion.** Daily journal entries auto-template from your Google Calendar via Uxie's existing OAuth.
- **Spec-mode integration.** When Para-RAID spawns a Claude in spec-collab mode, it auto-mounts the relevant Scrypt project namespace as read context.
- **Mobile-first Uxie commands.** Quick-capture (`/n <text>`), quick-search (`/s <query>`), daily (`/today`) — optimized for one-handed phone use.
- **A "browse the vault" Discord command.** `/vault tree` returns a folder listing as embeds with links to view notes via a temporary signed URL.

---

## 12. Glossary

- **SUP** — Scrypt + Uxie + Para-RAID, the three apps treated as one system.
- **The vault** — `/vault` on the VPS. Markdown source-of-truth. Owned by Scrypt.
- **The box** — the VPS hosting all three apps.
- **Plane** — one of {Data, Ops, User}. See §2.
- **Tailnet** — the user's Tailscale mesh: Mac, VPS, phone.
- **MCP** — Model Context Protocol. Scrypt's primary API surface.
- **Worker** — a Claude Code session spawned by Para-RAID inside a tmux pane.
- **Inbox** — `/vault/inbox/`, the drop folder for fresh markdown awaiting ingestion.
- **Plane violation** — code that mixes Data, Ops, and User responsibilities in one component.

---

## 13. Document Conventions

- Update this doc *before* implementing changes that contradict it. The doc is the source of truth, code follows.
- One doc, three locations (`docs/SUP-GUIDELINES.md` in each app). Keep them byte-identical. Future improvement: a sync script or git submodule.
- Versioning: bump the "Last updated" date and add a one-line entry at the bottom of this section when you change rules.
- When in doubt, prefer the rule that protects the *boundary* between planes.

### Revision log

- 2026-04-25 — Initial draft. Captures three-plane model, do's & don'ts, co-location synergies, ingestion pipeline, future ideas.

---

*"The point of co-location is not convenience — it's leverage. Co-locate to multiply, not to entangle."*
