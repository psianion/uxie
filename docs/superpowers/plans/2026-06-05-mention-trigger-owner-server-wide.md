# Mention-Triggered, Server-Wide, Owner-Only Bot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pivot uxie from the dedicated `#inbox` channel model to a server-wide bot that acts only for the owner, only when @-mentioned, returning a help overview for now.

**Architecture:** A new bot-core `mention-handler` builds a help embed (pure renderer in `lib/embed.ts`) and posts it as a self-deleting reply. The `message-router` gate changes from "owner + inbox channel" to "owner + direct @-mention, any channel". The scrypt module stops owning message capture; the `#inbox` path, `INBOX_CHANNEL_ID`, and `isInboxChannel` are removed. Invite moves to Administrator (`permissions=8`); gateway intents are unchanged.

**Tech Stack:** Bun, TypeScript, discord.js v14, Zod, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-06-05-mention-trigger-owner-server-wide-design.md`

---

## File Structure

**Create:**
- `src/bot/mention-handler.ts` — owner-mention handler: build help, reply, schedule self-delete. Owns its own catch. The future agentic-parser seam.
- `tests/bot/mention-handler.test.ts` — unit tests for the above.

**Modify:**
- `src/lib/embed.ts` — add pure `helpEmbed(commands)` renderer + `CommandSummary` type.
- `tests/lib/embed.test.ts` — add `helpEmbed` tests.
- `tests/helpers.ts` — extend `fakeMessage` with `client.user`, `mentions.has`, `reply` (additive; defaults unchanged).
- `src/bot/message-router.ts` — rewrite gate: owner + direct mention, no channel filter; callback renamed `onMention`.
- `tests/bot/message-router.test.ts` — rewrite for the new gate.
- `src/integrations/scrypt/index.ts` — drop `onInbox` and the `handleInboxMessage` import.
- `src/index.ts` — wire `MessageCreate` → `handleMessage(..., onMention=handleMention)`.
- `src/lib/env.ts` — remove `INBOX_CHANNEL_ID`.
- `tests/lib/env.test.ts` — remove the two `INBOX_CHANNEL_ID` entries.
- `docs/BOT-SETUP.md` — Administrator permissions, mention-help section, drop inbox id/env.
- The Discord Bot Guidelines doc — update §9 and `#inbox`/`INBOX_CHANNEL_ID` cross-refs.

**Delete:**
- `src/integrations/scrypt/inbox-handler.ts`
- `tests/integrations/scrypt/inbox-handler.test.ts`
- `src/integrations/scrypt/channels.ts`

**Retain (do NOT remove):** `src/lib/client-tag.ts` `makeMessageClientTag` + its test — reused by the upcoming mention→Scrypt write path.

---

## Task 1: `helpEmbed` pure renderer

**Files:**
- Modify: `src/lib/embed.ts`
- Test: `tests/lib/embed.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/embed.test.ts` (add `helpEmbed` to the existing import from `../../src/lib/embed.ts`; `ACCENT` is already exported there):

```ts
import { helpEmbed } from "../../src/lib/embed.ts";

describe("helpEmbed", () => {
  test("lists each command as `/name` — description with the accent color", () => {
    const e = helpEmbed([
      { name: "ping", description: "Check uxie + scrypt health" },
      { name: "capture", description: "Save a note to scrypt" },
    ]);
    expect(e.data.color).toBe(ACCENT);
    expect(e.data.title).toBe("uxie — commands");
    expect(e.data.description).toContain("`/ping` — Check uxie + scrypt health");
    expect(e.data.description).toContain("`/capture` — Save a note to scrypt");
    expect(e.data.footer?.text).toContain("route it");
  });

  test("renders without throwing when the command list is empty", () => {
    const e = helpEmbed([]);
    expect(e.data.description).toContain("no commands");
  });
});
```

> If `ACCENT` is not already imported in this test file, add it to the existing import line.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/lib/embed.test.ts`
Expected: FAIL — `helpEmbed is not a function` / not exported.

- [ ] **Step 3: Add the implementation**

Append to `src/lib/embed.ts` (uses `EmbedBuilder` and `ACCENT`, both already present in this file):

```ts
// Help overview shown when the owner @-mentions uxie (mention-trigger spec). Pure: takes a
// flat command summary list, returns one classic embed. The list is derived by the caller
// from the registered command collection so this never drifts from the real command set.
export interface CommandSummary {
  name: string;
  description: string;
}

export function helpEmbed(commands: CommandSummary[]): EmbedBuilder {
  const lines = commands.map((c) => `\`/${c.name}\` — ${c.description || "—"}`);
  return new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle("uxie — commands")
    .setDescription(lines.length ? lines.join("\n") : "_(no commands registered)_")
    .setFooter({
      text: "Tag me with a request soon and I'll route it. For now, use the slash commands above.",
    });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/lib/embed.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/embed.ts tests/lib/embed.test.ts
git commit -m "feat(embed): add helpEmbed renderer for the mention help overview"
```

---

## Task 2: `mention-handler`

**Files:**
- Create: `src/bot/mention-handler.ts`
- Test: `tests/bot/mention-handler.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/bot/mention-handler.test.ts`:

```ts
import { describe, expect, test, mock } from "bun:test";
import { Collection } from "discord.js";
import { handleMention } from "../../src/bot/mention-handler.ts";
import type { LoadedCommand } from "../../src/bot/command-loader.ts";

function fakeLog(): any {
  const l: any = { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) };
  l.child = () => l;
  return l;
}

function cmds(): Collection<string, LoadedCommand> {
  const c = new Collection<string, LoadedCommand>();
  c.set("ping", { data: { name: "ping", description: "Check health" } as any, execute: async () => {} });
  c.set("capture", { data: { name: "capture", description: "Save a note" } as any, execute: async () => {} });
  return c;
}

describe("handleMention", () => {
  test("replies with a help embed listing every command and pings nobody", async () => {
    const del = mock(async () => {});
    const reply = mock(async () => ({ delete: del }));
    const msg: any = { id: "m1", channelId: "c1", reply };
    const scheduled: Array<() => void> = [];

    await handleMention(msg, cmds(), fakeLog(), { schedule: (fn) => scheduled.push(fn) });

    expect(reply).toHaveBeenCalledTimes(1);
    const payload = reply.mock.calls[0][0] as any;
    expect(payload.allowedMentions).toEqual({ parse: [] });
    const desc = payload.embeds[0].data.description as string;
    expect(desc).toContain("/ping");
    expect(desc).toContain("/capture");
    expect(scheduled).toHaveLength(1);
  });

  test("the scheduled self-delete fires and a rejecting delete does not throw", async () => {
    const del = mock(async () => {
      throw new Error("already gone");
    });
    const reply = mock(async () => ({ delete: del }));
    const msg: any = { id: "m1", channelId: "c1", reply };
    const scheduled: Array<() => void> = [];

    await handleMention(msg, cmds(), fakeLog(), { schedule: (fn) => scheduled.push(fn) });
    expect(() => scheduled[0]()).not.toThrow();
    expect(del).toHaveBeenCalledTimes(1);
  });

  test("never throws if the reply itself fails (own catch site)", async () => {
    const reply = mock(async () => {
      throw new Error("missing perms");
    });
    const msg: any = { id: "m1", channelId: "c1", reply };
    await expect(handleMention(msg, cmds(), fakeLog())).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/bot/mention-handler.test.ts`
Expected: FAIL — cannot find module `mention-handler.ts`.

- [ ] **Step 3: Create the implementation**

Create `src/bot/mention-handler.ts`:

```ts
// Owner @-mention handler (bot-core). For now it replies with a help overview of the
// registered slash commands and auto-deletes that reply after HELP_TTL_MS to keep channels
// clean. This function is the seam where the future agentic intent-parser (interpret the
// message -> route to Scrypt / Para-RAID / tools) will attach — same signature, same gate.
//
// CATCH SITE NOTE: this handler owns its OWN narrow try/catch (the message-boundary
// equivalent of interaction-router's replyWithError). The message-router stays catch-free,
// so the three catch sites (decision 10) are unchanged.
//
// STATELESS NOTE: the self-delete timer is a transient, per-message UX cleanup — not a
// scheduler/queue/cron (Guidelines §15). It schedules nothing across restarts; if uxie
// restarts inside the window the stray help message simply survives. Acceptable.
import type { Collection, Message } from "discord.js";
import type { LoadedCommand } from "./command-loader.ts";
import type { Logger } from "../lib/log.ts";
import { helpEmbed, type CommandSummary } from "../lib/embed.ts";

export const HELP_TTL_MS = 30_000;

export interface MentionHandlerOpts {
  ttlMs?: number;
  // Injectable so tests fire the deletion deterministically; defaults to setTimeout.
  schedule?: (fn: () => void, ms: number) => void;
}

export async function handleMention(
  msg: Message,
  commands: Collection<string, LoadedCommand>,
  log: Logger,
  opts: MentionHandlerOpts = {},
): Promise<void> {
  const ttlMs = opts.ttlMs ?? HELP_TTL_MS;
  const schedule =
    opts.schedule ??
    ((fn, ms) => {
      setTimeout(fn, ms);
    });
  const scoped = log.child({ messageId: msg.id, channel: msg.channelId, kind: "mention" });
  scoped.info("mention help start");
  try {
    const summaries: CommandSummary[] = [...commands.values()].map((c) => ({
      name: c.data.name,
      description: "description" in c.data ? c.data.description : "",
    }));
    const reply = await msg.reply({
      embeds: [helpEmbed(summaries)],
      allowedMentions: { parse: [] },
    });
    schedule(() => {
      void reply.delete().catch(() => {
        /* best-effort: message may already be gone or perms lost */
      });
    }, ttlMs);
    scoped.info("mention help ok");
  } catch (err) {
    scoped.warn("mention help failed", { err });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/bot/mention-handler.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add src/bot/mention-handler.ts tests/bot/mention-handler.test.ts
git commit -m "feat(bot): add owner @-mention help handler with self-deleting reply"
```

---

## Task 3: Extend the `fakeMessage` test helper (additive)

**Files:**
- Modify: `tests/helpers.ts`

- [ ] **Step 1: Replace `fakeMessage` with the extended version**

In `tests/helpers.ts`, replace the existing `fakeMessage` function with this. It keeps every current default field (so the still-present old tests stay green) and ADDS `client.user`, `mentions.has`, and `reply`:

```ts
// Fake Message for router + mention tests. Defaults match a valid owner message; pass
// `mentionsBot: true` to make `mentions.has(...)` return true, and `clientUserId` to set the
// bot's own id. `react` and `reply` are mocked so handler acknowledgements are observable.
export function fakeMessage(overrides: Record<string, unknown> = {}): any {
  const { mentionsBot = false, clientUserId = "bot-1", ...rest } = overrides as any;
  return {
    id: "mid-1",
    content: "hello world",
    channelId: "chan-1",
    author: { id: "123", bot: false },
    client: { user: { id: clientUserId } },
    mentions: { has: mock((_id: string, _opts?: unknown) => mentionsBot) },
    react: mock(async (_: string) => {}),
    reply: mock(async (_: unknown) => ({ delete: mock(async () => {}) })),
    ...rest,
  };
}
```

> `mock` is already imported at the top of `tests/helpers.ts`. Changing the default
> `channelId` from `"inbox-chan"` to `"chan-1"` is safe: the only consumers are
> `message-router.test.ts` and `inbox-handler.test.ts`, both rewritten/deleted in later
> tasks. If you run the suite at this point and the OLD `message-router.test.ts` fails on a
> channel assertion, that is expected and resolved in Task 4 — but prefer to keep this
> commit green by NOT running those two files in isolation; the full suite is verified in
> Task 7. To stay strictly green here, leave `channelId: "inbox-chan"` unchanged instead —
> the new tests do not depend on its value.

- [ ] **Step 2: Run the test suite to confirm nothing regressed**

Run: `bun test`
Expected: PASS (the additive fields don't break existing tests). If the old
`message-router.test.ts` channel case fails because you changed the default `channelId`,
revert that one default to `"inbox-chan"` — it has no effect on the new mention tests.

- [ ] **Step 3: Commit**

```bash
git add tests/helpers.ts
git commit -m "test(helpers): extend fakeMessage with client.user, mentions, reply"
```

---

## Task 4: Cutover — rewrite the gate and wiring

**Files:**
- Modify: `src/bot/message-router.ts`
- Modify: `tests/bot/message-router.test.ts`
- Modify: `src/integrations/scrypt/index.ts`
- Modify: `src/index.ts`
- Modify: `src/lib/env.ts`
- Modify: `tests/lib/env.test.ts`

- [ ] **Step 1: Rewrite the message-router test**

Replace the entire contents of `tests/bot/message-router.test.ts` with:

```ts
import { describe, expect, test, mock } from "bun:test";
import { handleMessage } from "../../src/bot/message-router.ts";
import { fakeMessage } from "../helpers.ts";

describe("handleMessage (owner mention gate)", () => {
  const cfg = { ownerId: "123" };

  test("ignores bot authors", async () => {
    const onMention = mock(async () => {});
    await handleMessage(fakeMessage({ author: { id: "123", bot: true }, mentionsBot: true }), cfg, onMention);
    expect(onMention).not.toHaveBeenCalled();
  });

  test("ignores non-owner authors even when they mention uxie", async () => {
    const onMention = mock(async () => {});
    await handleMessage(fakeMessage({ author: { id: "999", bot: false }, mentionsBot: true }), cfg, onMention);
    expect(onMention).not.toHaveBeenCalled();
  });

  test("ignores owner messages that do not mention uxie", async () => {
    const onMention = mock(async () => {});
    await handleMessage(fakeMessage({ author: { id: "123", bot: false }, mentionsBot: false }), cfg, onMention);
    expect(onMention).not.toHaveBeenCalled();
  });

  test("invokes onMention for an owner direct-mention", async () => {
    const onMention = mock(async () => {});
    await handleMessage(fakeMessage({ author: { id: "123", bot: false }, mentionsBot: true }), cfg, onMention);
    expect(onMention).toHaveBeenCalledTimes(1);
  });

  test("does nothing before the client is READY (no client.user)", async () => {
    const onMention = mock(async () => {});
    await handleMessage(
      fakeMessage({ author: { id: "123", bot: false }, mentionsBot: true, client: { user: null } }),
      cfg,
      onMention,
    );
    expect(onMention).not.toHaveBeenCalled();
  });

  test("catch site: a throwing handler never escapes handleMessage", async () => {
    const onMention = mock(async () => {
      throw new Error("handler blew up");
    });
    await expect(
      handleMessage(fakeMessage({ author: { id: "123", bot: false }, mentionsBot: true }), cfg, onMention),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/bot/message-router.test.ts`
Expected: FAIL — the new test passes `cfg` without `inboxId` and the old router still
references `isInboxChannel`/`inboxId` (type and/or assertion failures).

- [ ] **Step 3: Rewrite the message-router**

Replace the entire contents of `src/bot/message-router.ts` with:

```ts
// messageCreate boundary — owner @-mention trigger, server-wide (mention-trigger spec).
// Replaces the #inbox channel capture model.
//
// CATCH SITE #2 of 3 (decision 10): interaction-router (#1), message-router (#2),
// src/index.ts process.on (#3). The onMention handler owns its own try/catch; this router
// additionally guarantees nothing escapes into the gateway dispatcher (a throw out of a
// discord.js listener becomes an unhandledRejection -> exit(1) via catch site #3).
//
// Gate (router-located, decision 9): not-a-bot, owner-only, and a DIRECT @-mention of uxie
// (an @everyone / role / replied-user ping does NOT count). Non-matching messages are
// silently dropped — no reply, no reaction.
import type { Message } from "discord.js";
import { log } from "../lib/log.ts";

export interface MessageRouterConfig {
  ownerId: string;
}

export async function handleMessage(
  msg: Message,
  cfg: MessageRouterConfig,
  onMention: (msg: Message) => Promise<void>,
): Promise<void> {
  if (msg.author.bot) return;
  if (msg.author.id !== cfg.ownerId) return;
  const me = msg.client.user;
  if (!me) return; // gateway not READY yet
  if (!msg.mentions.has(me.id, { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true })) {
    return;
  }

  try {
    await onMention(msg);
  } catch (err) {
    // Defensive: onMention owns a try/catch, but the catch site must never let anything
    // escape (decision 10). Anything reaching here is a handler bug, not a routine fault.
    log.error("message-router unhandled", { messageId: msg.id, err });
  }
}
```

- [ ] **Step 4: Run the message-router test to verify it passes**

Run: `bun test tests/bot/message-router.test.ts`
Expected: PASS (all six cases).

- [ ] **Step 5: Drop `onInbox` from the scrypt module**

Replace the entire contents of `src/integrations/scrypt/index.ts` with:

```ts
// scrypt module entry. Builds the REST + MCP clients from validated env and the command
// collection. The module owns its clients and commands; the boot path wires the command
// collection into the interaction-router. Message handling (owner @-mention) lives in
// bot-core (mention-handler), not here.
import { buildCommandCollection, type LoadedCommand } from "../../bot/command-loader.ts";
import { ScryptRestClient } from "./rest-client.ts";
import { ScryptMcpClient } from "./mcp-client.ts";
import { buildPingCommand } from "./commands/ping.ts";
import { buildCaptureCommand } from "./commands/capture.ts";
import { buildSearchCommand } from "./commands/search.ts";
import { buildAskCommand } from "./commands/ask.ts";
import { buildJournalCommand } from "./commands/journal.ts";
import { buildBriefCommand } from "./commands/brief.ts";
import type { Env } from "../../lib/env.ts";

export interface ScryptModule {
  commands: ReturnType<typeof buildCommandCollection>;
  rest: ScryptRestClient;
  mcp: ScryptMcpClient;
}

export function buildScryptModule(env: Env): ScryptModule {
  const rest = new ScryptRestClient(env.SCRYPT_SERVER_URL, env.SCRYPT_AUTH);
  // Reads use the MCP streamable-http endpoint (decision 2 / scrypt-contract §2); writes use
  // REST. Same SCRYPT_AUTH bearer; different base URL.
  const mcp = new ScryptMcpClient(env.SCRYPT_MCP_URL, env.SCRYPT_AUTH);
  const cmds: LoadedCommand[] = [
    buildPingCommand(rest),
    buildCaptureCommand(rest),
    buildSearchCommand(mcp),
    buildAskCommand(mcp),
    buildJournalCommand(rest, env.USER_TZ),
    buildBriefCommand(rest, env.USER_TZ),
  ];
  return {
    commands: buildCommandCollection(cmds),
    rest,
    mcp,
  };
}
```

- [ ] **Step 6: Rewire the boot path**

In `src/index.ts`:

Add this import alongside the other `./bot/...` imports:

```ts
import { handleMention } from "./bot/mention-handler.ts";
```

Replace the existing `MessageCreate` handler block (the one with the `#inbox passive capture`
comment that calls `handleMessage(m, { ownerId: env.DISCORD_OWNER_ID, inboxId: env.INBOX_CHANNEL_ID }, scrypt.onInbox)`) with:

```ts
// Owner @-mention trigger, server-wide (mention-trigger spec). message-router is catch site
// #2 (decision 10): it gates (not-bot / owner / direct-mention) and never lets a handler
// fault escape. For now the mention handler replies with a help overview.
client.on(Events.MessageCreate, async (m) => {
  await handleMessage(m, { ownerId: env.DISCORD_OWNER_ID }, (msg) => handleMention(msg, scrypt.commands, log));
});
```

- [ ] **Step 7: Remove `INBOX_CHANNEL_ID` from the env schema**

In `src/lib/env.ts`, delete this line from the `z.object({ ... })` schema:

```ts
  INBOX_CHANNEL_ID: z.string().min(1),
```

- [ ] **Step 8: Update the env test**

In `tests/lib/env.test.ts`, delete the `complete` map entry:

```ts
  INBOX_CHANNEL_ID: "i",
```

and delete the required-field list entry:

```ts
    "INBOX_CHANNEL_ID",
```

- [ ] **Step 9: Run the full suite + typecheck**

Run: `bun test`
Expected: PASS — including `env.test.ts`, `message-router.test.ts`, `mention-handler.test.ts`. (`inbox-handler.test.ts` still exists and still passes; deleted in Task 5.)

Run: `bunx tsc --noEmit` (or `bun run typecheck` if defined in `package.json`)
Expected: no errors. `inbox-handler.ts` and `channels.ts` still compile (now unimported).

- [ ] **Step 10: Commit**

```bash
git add src/bot/message-router.ts tests/bot/message-router.test.ts \
        src/integrations/scrypt/index.ts src/index.ts \
        src/lib/env.ts tests/lib/env.test.ts
git commit -m "feat(bot): switch to server-wide owner @-mention trigger; drop #inbox channel"
```

---

## Task 5: Delete the dead `#inbox` code and sweep stale comments

**Files:**
- Delete: `src/integrations/scrypt/inbox-handler.ts`, `tests/integrations/scrypt/inbox-handler.test.ts`, `src/integrations/scrypt/channels.ts`
- Modify (comments only): `src/bot/client.ts`, `src/lib/auth.ts`, `src/integrations/README.md`

- [ ] **Step 1: Confirm there are no remaining importers**

Run: `grep -rn "inbox-handler\|handleInboxMessage\|onInbox\|isInboxChannel\|scrypt/channels" src tests`
Expected: matches ONLY inside the three files about to be deleted (and `inbox-handler.test.ts`). If anything else matches, fix that first.

- [ ] **Step 2: Delete the files**

```bash
git rm src/integrations/scrypt/inbox-handler.ts \
       tests/integrations/scrypt/inbox-handler.test.ts \
       src/integrations/scrypt/channels.ts
```

- [ ] **Step 3: Sweep stale `#inbox` comments**

Update comments so they don't describe a removed feature (text only — no behavior change):
- `src/bot/client.ts`: the header comment says `GuildMessages (#inbox messageCreate)` and `Partials … so the #inbox handler receives uncached payloads`. Reword to: `GuildMessages (owner @-mention messageCreate)` and `Partials Channel + Message so the mention handler receives uncached payloads`.
- `src/lib/auth.ts`: the comment mentioning `#inbox capture` → reword to `slash commands and the owner @-mention path`.
- `src/integrations/README.md`: the line referencing `the passive #inbox capture` → reword to describe the owner @-mention handler living in `bot/mention-handler.ts`.

> Leave genuine, still-accurate mentions alone — e.g. `commands/capture.ts` and
> `rest-client.ts` notes that a `note` routes into `notes/inbox/` on the **scrypt** side
> (that is a vault path, unrelated to the removed Discord channel).

- [ ] **Step 4: Run the full suite + typecheck**

Run: `bun test`
Expected: PASS. Test count drops by the deleted `inbox-handler.test.ts` cases.

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove dead #inbox handler, channel filter, and stale comments"
```

---

## Task 6: Update the docs

**Files:**
- Modify: `docs/BOT-SETUP.md`
- Modify: the Discord Bot Guidelines doc (the `Uxie — Discord Bot Guidelines` markdown file under `docs/`)

- [ ] **Step 1: BOT-SETUP.md — Part C (permissions)**

Replace the entire "Part C — Invite URL, scopes & permissions" section with:

```markdown
## Part C — Invite URL, scopes & permissions

**Scopes:** `bot` + `applications.commands`
**Bot permissions:** **Administrator** — uxie is a personal, owner-only bot that will grow
to "handle everything" (including future Para-RAID ops), so it is invited with full
permissions rather than a hand-tuned set. Gate is enforced in code (owner id), not by
Discord permission bits.

**Permissions integer = `8` (Administrator).**

Ready-made invite URL (replace `APP_ID` with your `DISCORD_APP_ID`):

```
https://discord.com/api/oauth2/authorize?client_id=APP_ID&scope=bot%20applications.commands&permissions=8
```

Open that URL, pick your **test server**, keep **Administrator** ticked, click **Authorize**.
```

- [ ] **Step 2: BOT-SETUP.md — "how channels & replies work" section**

Replace the "How uxie's channels & replies actually work" section body with one that
describes the two mechanisms now in play:

```markdown
## How uxie's channels & replies actually work

uxie acts server-wide but only for **you** (`DISCORD_OWNER_ID`), via two mechanisms:

- **Slash commands → ephemeral interaction responses.** Every command
  (`/ping`, `/capture`, `/ask`, `/search`, `/journal`, `/brief`) defers, then `editReply`
  with a classic embed and `flags: MessageFlags.Ephemeral` — private to you, no scrollback.
- **@-mention → in-channel help reply (auto-deleting).** When you tag uxie in any channel,
  it replies with a help overview of the commands and deletes its own reply after ~30s.
  Anyone who is not the owner (or an `@everyone`/role ping) is silently ignored. Later this
  becomes an agentic parser that interprets your message and routes it.

There is no dedicated `#inbox` channel anymore.
```

- [ ] **Step 3: BOT-SETUP.md — Parts D and E (remove inbox id)**

- In **Part D** (IDs from the Discord client), delete the step that copies the `#inbox`
  channel id (the `INBOX_CHANNEL_ID` / "Copy Channel ID" item).
- In **Part E** (`.env` table), delete the `INBOX_CHANNEL_ID` row.

- [ ] **Step 4: Guidelines doc**

In the `Uxie — Discord Bot Guidelines` markdown file:
- §9 (`#inbox` channel passive capture): replace the section with the owner @-mention →
  help-reply model (server-wide, owner-only, auto-deleting reply; future agentic routing).
- Remove `INBOX_CHANNEL_ID` from the §17.1 required-env list.
- §4/§5: note the install profile is now Administrator; intents are unchanged and reused.
- §15: add a one-line carve-out that the mention reply's ~30s self-delete `setTimeout` is a
  transient UX timer, not a scheduler/queue.

- [ ] **Step 5: Confirm no doc still references the removed env var**

Run: `grep -rni "INBOX_CHANNEL_ID" docs`
Expected: no matches (or only inside the dated spec/plan under `docs/superpowers/`, which
are historical and may keep the reference).

- [ ] **Step 6: Commit**

```bash
git add docs
git commit -m "docs: Administrator invite + mention-help model; drop #inbox/INBOX_CHANNEL_ID"
```

---

## Task 7: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: PASS, 0 failures.

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit` (or `bun run typecheck` if defined)
Expected: no errors.

- [ ] **Step 3: Grep for leftover references**

Run: `grep -rni "inbox" src tests | grep -v "notes/inbox\|note (inbox)"`
Expected: no Discord-`#inbox`-channel references remain (vault-path `notes/inbox/` notes in
`capture.ts`/`rest-client.ts` are fine).

Run: `grep -rn "permissions=8" docs/BOT-SETUP.md`
Expected: the invite URL uses `permissions=8`.

- [ ] **Step 4: Final commit (if the greps prompted any fixes)**

```bash
git add -A
git commit -m "chore: finalize mention-trigger cutover"
```

> If Step 4 has nothing to commit, skip it — the work is already committed per task.

---

## Self-Review (completed by plan author)

- **Spec coverage:** §2 behaviour → Tasks 2,4; §3 permissions/intents → Task 6 (intents
  unchanged, noted); §4 architecture (mention-handler core, router rewrite, scrypt/index,
  index, env) → Tasks 2,4; §4 deletions → Task 5; §4 incidental (retain
  `makeMessageClientTag`, comment sweep) → Task 5; §5 help embed → Task 1; §6 catch
  sites + auto-delete carve-out → Tasks 2,4 (code) + Task 6 (doc); §7 tests → Tasks 1–4;
  §8 docs → Task 6; §10 done-when → Task 7. No gaps.
- **Placeholder scan:** every code step has complete code; no TBD/TODO.
- **Type consistency:** `handleMention(msg, commands, log, opts)`, `MessageRouterConfig {
  ownerId }`, `helpEmbed(CommandSummary[])`, `CommandSummary { name, description }`,
  `HELP_TTL_MS` are referenced identically across tasks and the spec.
```
