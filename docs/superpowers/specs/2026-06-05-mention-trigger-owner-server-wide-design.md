# uxie — mention-triggered, server-wide, owner-only (design)

**Date:** 2026-06-05
**Status:** Approved (design); pending implementation plan
**Supersedes:** the `#inbox` dedicated-channel passive-capture model (Guidelines §9, Design §6.2)

## 1. Goal

Pivot uxie from a dedicated-`#inbox`-channel bot to a **server-wide, owner-only,
@-mention-triggered** bot.

- No special channel. uxie listens across the whole guild.
- Invited with **Administrator** so it can grow into "handle everything" (incl.
  future Para-RAID ops) without a re-invite.
- Hard-gated: it acts **only** for the owner (`DISCORD_OWNER_ID`) and **only**
  when directly @-mentioned.
- **For now**, a mention returns a **help / overview** of available commands.
  The agentic intent-parser (interpret the message → route to Scrypt /
  Para-RAID / tools) is an explicit *later* phase that slots into the same seam.

The six slash commands (`/ping /capture /search /ask /journal /brief`) are
unchanged and remain the real feature surface.

## 2. Behaviour contract

When a `messageCreate` arrives, uxie acts iff **all** hold:

1. author is not a bot (incl. uxie itself),
2. author id === `DISCORD_OWNER_ID`,
3. the message **directly mentions uxie** — `msg.mentions.has(botId, { ignoreEveryone: true, ignoreRoles: true })`
   (an `@everyone`/role ping must NOT trigger it).

Any message failing the gate is **silently dropped** — no reply, no reaction.
Non-owners who tag it get nothing (don't advertise the bot, no channel noise).

On a valid mention uxie:

- builds a **help embed** auto-derived from the registered command collection
  (each command's `name` + `description`), plus a footer noting that
  "tag me with a request" agentic routing is coming,
- posts it as an in-channel **reply** to the owner's message, with
  `allowedMentions: { parse: [] }` (pings nobody),
- **auto-deletes its own reply after ~30s** (best-effort; failures swallowed).

## 3. Permissions & intents

### Invite
- Scopes: `bot` + `applications.commands` (unchanged).
- Bot permissions integer → **`8` (Administrator)**.
- Invite URL: `https://discord.com/api/oauth2/authorize?client_id=APP_ID&scope=bot%20applications.commands&permissions=8`

### Gateway intents — **unchanged**
`Guilds + GuildMessages + MessageContent` already cover reading the owner's
mention text server-wide. `src/bot/client.ts` is **not** modified. No
`GuildMembers`, no `DirectMessages` (replies are in-channel). `MessageContent`
stays privileged-but-enabled.

> Note: with server-wide `GuildMessages` + `MessageContent`, uxie's gateway now
> receives every guild message and reads its content before the gate drops
> non-matching ones. Acceptable: single owner, owner's own server. No message
> content is stored or forwarded unless the gate passes.

## 4. Architecture & components

### New: `src/bot/mention-handler.ts` (bot-core, NOT under `integrations/scrypt/`)
Rationale: the future agentic parser spans **both** Scrypt and Para-RAID, so the
seam belongs in core, not inside the scrypt module.

```
handleMention(msg: Message, commands: Collection<string, LoadedCommand>, log: Logger, opts?: { ttlMs?: number }): Promise<void>
```

- Owns its **own try/catch** (mirrors the old inbox-handler — the message-boundary
  equivalent of interaction-router's `replyWithError`). The `message-router`
  itself stays catch-free.
- Builds the help embed via a **pure** `helpEmbed(commands)` renderer added to
  `src/lib/embed.ts` (consistent with "embed builders are pure, no IO").
- IO lives here: `const reply = await msg.reply({ embeds: [helpEmbed(commands)], allowedMentions: { parse: [] } });`
  then `setTimeout(() => void reply.delete().catch(() => {}), opts?.ttlMs ?? HELP_TTL_MS)` with `HELP_TTL_MS = 30_000`.
- **Future seam:** later this function swaps "build help" for "parse intent →
  dispatch", keeping the same signature and gate.

### Rewrite: `src/bot/message-router.ts`
New gate (server-wide, mention-based). `MessageRouterConfig` drops `inboxId`,
keeping only `{ ownerId: string }`. Signature becomes:

```
handleMessage(msg, cfg: { ownerId: string }, onMention: (msg: Message) => Promise<void>): Promise<void>
```

Gate order: `author.bot` → `author.id !== ownerId` → `!msg.client.user` (not ready)
→ `!msg.mentions.has(msg.client.user.id, { ignoreEveryone: true, ignoreRoles: true })`.
Then `try { await onMention(msg) } catch (err) { log.error("message-router unhandled", …) }`.
This remains **catch site #2 of 3** (decision 10) — semantics preserved, only the
gate predicate and callback change.

### Edit: `src/integrations/scrypt/index.ts`
Drop `onInbox` from `ScryptModule` and stop importing `handleInboxMessage`. The
module still owns the clients + command collection; it no longer knows about
message capture.

### Edit: `src/index.ts` (boot wiring)
```
import { handleMention } from "./bot/mention-handler.ts";
...
client.on(Events.MessageCreate, (m) =>
  handleMessage(m, { ownerId: env.DISCORD_OWNER_ID }, (msg) => handleMention(msg, scrypt.commands, log)),
);
```
`mention-handler` stays decoupled from scrypt internals — it takes a generic
command collection.

### Edit: `src/lib/env.ts` + `.env.example`
Remove `INBOX_CHANNEL_ID` (the schema field on line 13 and the example entry).

### Delete
- `src/integrations/scrypt/inbox-handler.ts`
- `src/integrations/scrypt/channels.ts` (`isInboxChannel`) — **iff** no other
  references remain after the router rewrite (verify, then delete).
- `tests/integrations/scrypt/inbox-handler.test.ts`

### Incidental cleanup (no dead code left behind)
- `src/lib/client-tag.ts`: `makeMessageClientTag` (the `uxie-msg-<id>` tag) is
  used only by `inbox-handler` today, but the next phase (mention → Scrypt
  writes) will need a message-scoped client tag. **Retain it** (and its test) as
  the seam for that path rather than churning it out and back in.
- Sweep stale `#inbox` references in comments/docs so they don't mislead:
  `src/bot/message-router.ts` header, `src/bot/client.ts` header, `src/index.ts`
  comments, `src/integrations/scrypt/index.ts` header, `src/lib/auth.ts` comment,
  `src/integrations/README.md`. (Leave genuine ones, e.g. `/capture` routing
  notes that note the scrypt-side `notes/inbox/` path — that is unrelated to the
  removed channel.)

## 5. Help embed content

`helpEmbed(commands)` → one classic `EmbedBuilder` (ACCENT color):
- title: `uxie — commands`
- description: one line per command, `` `/name` — description `` iterated from
  `commands.values()` (read `data.name` / `data.description`; fall back to a
  placeholder if a `data` branch lacks a description).
- footer: `Tag me with a request soon and I'll route it for you. For now: use the slash commands above.`

Pure, no IO, deterministic order (collection insertion order = registration
order), so it's unit-testable and never drifts from the real command set.

## 6. Error handling & the one deliberate deviation

- **Catch sites stay three** (decision 10): interaction-router (#1),
  message-router (#2), `index.ts` process handlers (#3). `mention-handler` owns a
  narrow internal try/catch for its reply/delete IO, exactly as `inbox-handler`
  did — this does **not** add a fourth router-level catch site.
- **Auto-delete `setTimeout` vs the stateless / "no scheduler" rule (§15):**
  permitted. It is a transient, per-message UX cleanup timer — not a persistent
  scheduler, queue, or cron. It schedules nothing across restarts; if uxie
  restarts within the 30s window the stray help message simply survives
  (acceptable degradation). This deviation is intentional and documented here.

## 7. Testing (TDD)

- **Rewrite** `tests/bot/message-router.test.ts`: cfg `{ ownerId }`; cases —
  bot author ignored; non-owner ignored; owner-without-mention ignored;
  owner + direct mention → `onMention` called once; `@everyone`-only does NOT
  trigger; throwing `onMention` resolves (catch site #2 preserved).
- **New** `tests/bot/mention-handler.test.ts`: owner mention → `msg.reply`
  called with an embed whose description lists every command name; reply uses
  `allowedMentions: { parse: [] }`; a self-delete is scheduled (inject small
  `ttlMs` / fake timers) and a failing `reply.delete()` does not throw.
- **New/extend** embed test: `helpEmbed` lists all six command names, single
  ACCENT color, stable order.
- **Delete** `tests/integrations/scrypt/inbox-handler.test.ts`.
- **Update** any env test asserting `INBOX_CHANNEL_ID` is required.
- **Unchanged:** `tests/bot/client.test.ts` (intents identical), command-builder
  and command tests.

Test helper `fakeMessage` needs `client.user` and a `mentions.has(id, opts)` stub.

## 8. Docs to update

- `docs/BOT-SETUP.md`: Part C (permissions → Administrator `8`, new invite URL);
  the "how channels & replies work" section (mention-help instead of `#inbox`);
  Part D (drop inbox channel id); Part E (drop `INBOX_CHANNEL_ID` row).
- Discord Bot Guidelines: §5 unchanged (note intents are reused, not changed);
  §9 (`#inbox` capture) → replaced by the mention/help model; cross-refs to
  `INBOX_CHANNEL_ID` removed; §15 gains the auto-delete-timer carve-out note.

## 9. Out of scope (explicitly deferred)

- The agentic intent-parser and any Para-RAID dispatch — future phase; only the
  `mention-handler` seam is established now.
- Multi-user / non-owner access (still owner-only).
- DM triggers, reaction triggers, or any non-mention trigger ("expand later").
- Restoring passive note-capture — note capture remains via `/capture`.

## 10. Done-when

- Tagging uxie as the owner, in any channel, returns a help embed that
  auto-deletes after ~30s; tagging by a non-owner (or `@everyone`) does nothing.
- No code path references `INBOX_CHANNEL_ID` or `#inbox`.
- `bun test` and typecheck pass; invite URL in docs uses `permissions=8`.
