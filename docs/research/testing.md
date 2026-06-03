# Deep Research — Dimension: Testing

**For:** uxie (Discord User-plane bot, SUP system)
**Status:** research / pre-build. Repo is docs-only today.
**Scope:** Best-in-class testing strategy with `bun:test` for a discord.js v14.26 bot with **no real Discord and no real Scrypt in CI**.
**Author note:** This doc builds *on* the locked spec (Design §8, §7; Plan Task 1/4/15; Guidelines §14/§19/§22; spec-consistency-report §4.7). Every deviation is flagged `conflictsWithSpec`.

---

## 1. Context recap (what is already locked)

From the baseline + primary docs, these are non-negotiable and the strategy must honor them:

- **Test runner:** `bun test` and nothing else (Design §8.1; Guidelines §3). `package.json` scripts: `test: "bun test"`, `typecheck: "bun x tsc --noEmit"` (Plan Task 1).
- **TDD ordering:** every Plan task opens with *"Step 1: Write the failing test."* Tests precede implementation, always (Plan Tasks 4, 15, 17–26).
- **Unit-tested set is explicit** (Design §8.2): `lib/env.ts`, `lib/client-tag.ts`, `lib/embed.ts`, `lib/errors.ts`, `lib/log.ts`, `lib/tz.ts`, `lib/auth.ts`, `lib/command-builder.ts`, `integrations/scrypt/mcp-client.ts`, `integrations/scrypt/rest-client.ts`, `integrations/scrypt/commands/*.ts`.
- **Mocks are hand-rolled doubles cast `as any`** — no faithful `ChatInputCommandInteraction` construction (Design §8.3, §8.5). "Faithful construction is not the goal."
- **`tests/helpers.ts`** exports `fakeInteraction(overrides)` and `fakeMessage(overrides)`. `withFetch(impl)` is a per-test fetch-swap helper (Plan Task 15).
- **`test:integration` exists as an EMPTY suite** — placeholder, no real scrypt in unit tests (Design §8.3).
- **No snapshot tests on embed markdown** — "manual eyeballing during smoke" (Design §8.3).
- **Tests live under `tests/` mirroring `src/`** (Design §4 tree: `tests/lib/`, `tests/integrations/scrypt/`).
- **Exactly three error catch sites** (Design §7.2; Guidelines §14.2). No `try/catch` in command bodies — the router is the only catch. This is *itself* a testable invariant.
- **Seven user-facing error mappings** (Design §7.3 — the spec text says "six" but the table lists seven; see §10 / Conflicts).
- **No retries** (Design §7.4). The user re-running a command is the retry; idempotency is server-side via `client_tag`.

---

## 2. The test pyramid for this app

uxie is a *stateless translation layer with an error boundary*. It has almost no business logic — its risk surface is **boundary parsing** (Discord input in, Scrypt response in) and **error mapping** (failure → user message). That shape dictates an inverted-effort pyramid:

```
        ▲  manual smoke  (10 checks, §8.4)  — humans, not CI
       ███ integration   (empty in v1; placeholder suite)
   ███████ unit          (~95% of all assertions)
```

**Why heavy-unit / thin-integration / manual-smoke is correct here, not lazy:**

1. The whole app is pure functions + thin adapters. `lib/*` is deterministic; `*-client.ts` is `fetch`-in / typed-out; commands are `(interaction, client) → editReply`. All three are unit-shaped.
2. The only genuinely integrated parts are (a) the live Discord gateway and (b) the live Scrypt server — both explicitly excluded from CI (Design §8.3). Faking them faithfully costs more than it catches.
3. Single-user scale + server-side idempotency means a missed edge case is *recoverable by re-running* — the cost of a test escape is low, which justifies leaning on a 10-step human smoke for the integrated path.

**Layer responsibilities:**

| Layer | What it proves | Where | Runs in CI? |
|---|---|---|---|
| **Unit — pure** | env/zod, client-tag, tz, embed render, error taxonomy, redaction | `tests/lib/*.test.ts` | yes |
| **Unit — adapters** | rest-client + mcp-client: response parsing + all HTTP-failure → `ScryptError` mappings, `fetch` mocked | `tests/integrations/scrypt/*-client.test.ts` | yes |
| **Unit — commands** | each command: `deferReply` called → client called with right args → `editReply` with right embed shape, via `fakeInteraction` + injected fake client | `tests/integrations/scrypt/commands/*.test.ts` | yes |
| **Unit — router/contract** | the three catch sites map each error class to the right user text/reaction | `tests/bot/interaction-router.test.ts`, `tests/bot/message-router.test.ts` | yes |
| **Static invariant ("lint test")** | no `try{` in command bodies; no boolean `ephemeral:true`; no `process.env` outside `lib/env.ts` | `tests/anti-patterns.test.ts` | yes |
| **Integration** | (deferred) real scrypt round-trip | `tests/integration/*.test.ts` (empty) | scripted, not in default `bun test` |
| **Manual smoke** | live Discord + live scrypt, 10 checks | human, recorded in PR | no |

---

## 3. Dependency injection — the single design decision that makes testing clean

The cleanest seam is **parameter injection of the scrypt clients into commands**, instead of commands importing a singleton. This is the difference between trivial command tests and fighting `mock.module`.

**Recommended command contract:**

```ts
// src/integrations/scrypt/commands/capture.ts
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { ScryptRestClient } from "../rest-client.ts";

export interface CaptureDeps { rest: ScryptRestClient }

export async function execute(
  i: ChatInputCommandInteraction,
  deps: CaptureDeps,
): Promise<void> {
  assertOwner(i);                                   // FIRST line, always (Guidelines §22)
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const text = i.options.getString("text", true);
  const res = await deps.rest.ingest({
    kind: "note", content: text, clientTag: makeClientTag(i),
  });
  await i.editReply({ embeds: [captureEmbed(res)] });
}
```

`registerScryptIntegration(bot)` wires the real `deps` once at boot; tests pass a fake `deps`. With DI:

- Command tests need **zero** `mock.module` — pass `{ rest: { ingest: mock(async () => fixture) } } as any`.
- The "client called with correct args" assertion (Design §8.2) becomes `expect(deps.rest.ingest).toHaveBeenCalledWith({...})`.
- No module-cache state leaks between tests (Bun's `mock.module` mutates the ESM cache and is *not* reset by `mock.restore()` — a known footgun, per Bun docs).

> Note: Plan Task 17/21/22/24/26 currently describe commands taking only `interaction`. Recommending the explicit `deps` parameter is a small refinement that stays inside the spirit of §8.2 ("a mocked client"). It is the one architectural recommendation here (see §9 #1). For the bot wiring it does **not** add state — `deps` is constructed once and passed by reference, fully compatible with the stateless rule.

**Where `mock.module` / `withFetch` still apply:** the clients themselves (`rest-client.ts`, `mcp-client.ts`) own `globalThis.fetch`. There DI is not natural, so swap `globalThis.fetch` per test with `withFetch` (Plan Task 15, already specified). For `lib/log.ts` redaction tests, `spyOn(console, "log")` and assert the serialized payload.

---

## 4. Test helpers — concrete contracts for `tests/helpers.ts`

The spec names `fakeInteraction` / `fakeMessage` / `withFetch` but does not centrally specify them (gap). Here are implementable signatures. Keep them dumb and `as any` per §8.5.

```ts
// tests/helpers.ts
import { mock } from "bun:test";

export const OWNER_ID = "OWNER_ID";

export function fakeInteraction(overrides: Partial<{
  userId: string;
  commandName: string;
  strings: Record<string, string>;
  booleans: Record<string, boolean>;
}> = {}): any {
  const strings = overrides.strings ?? {};
  const booleans = overrides.booleans ?? {};
  const i: any = {
    id: "int-123",
    user: { id: overrides.userId ?? OWNER_ID },
    commandName: overrides.commandName ?? "ping",
    deferred: false,
    replied: false,
    options: {
      getString: mock((name: string) => strings[name] ?? null),
      getBoolean: mock((name: string) => booleans[name] ?? null),
    },
    isChatInputCommand: () => true,
    deferReply: mock(async () => { i.deferred = true; }),
    reply:      mock(async () => { i.replied = true; }),
    editReply:  mock(async () => {}),
    followUp:   mock(async () => {}),
  };
  return i;
}

export function fakeMessage(overrides: Partial<{
  authorId: string; bot: boolean; content: string; channelId: string;
}> = {}): any {
  return {
    author: { id: overrides.authorId ?? OWNER_ID, bot: overrides.bot ?? false },
    content: overrides.content ?? "hello inbox",
    channelId: overrides.channelId ?? "INBOX_CHANNEL_ID",
    id: "msg-123",
    url: "https://discord.com/channels/g/c/msg-123",
    attachments: new Map(),
    react: mock(async () => {}),  // assert ✅ / ❌ ack
  } as any;
}

export function withFetch(impl: typeof fetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return () => { globalThis.fetch = original; };
}
```

**Why mutable `deferred`/`replied` flags matter:** the router's `replyWithError` must choose `reply` vs `followUp` based on interaction state (the official discord.js error-handling pattern: `if (interaction.replied || interaction.deferred) followUp else reply`). Making `deferReply`/`reply` flip the flags lets the router test exercise both branches faithfully. This also addresses spec-consistency drift #16 (flat boolean flags are fine for the *stub*; the *runtime* reply must use `{ flags: MessageFlags.Ephemeral }`, never `{ ephemeral: true }`).

**Convention:** centralize the owner id as `OWNER_ID` so command tests and the auth test agree. A non-owner test passes `fakeInteraction({ userId: "999" })`.

---

## 5. Unit-testing each command's pure logic

Per Design §8.2, every command test asserts three things. With DI (§3) this is mechanical:

```ts
// tests/integrations/scrypt/commands/capture.test.ts
import { describe, expect, test, mock } from "bun:test";
import { execute } from "../../../../src/integrations/scrypt/commands/capture.ts";
import { fakeInteraction, OWNER_ID } from "../../../helpers.ts";
import { NotOwnerError } from "../../../../src/lib/errors.ts";

function fakeRest(over: Partial<{ ingest: any }> = {}) {
  return { ingest: over.ingest ?? mock(async () => ({ note_path: "notes/inbox/x.md", url: "u" })) } as any;
}

describe("/capture", () => {
  test("defers, calls ingest with client_tag, edits with capture embed", async () => {
    const i = fakeInteraction({ userId: OWNER_ID, commandName: "capture", strings: { text: "hello" } });
    const rest = fakeRest();
    await execute(i, { rest });

    expect(i.deferReply).toHaveBeenCalledTimes(1);
    expect(rest.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "note", content: "hello", clientTag: "uxie-" + i.id }),
    );
    const arg = i.editReply.mock.calls[0][0];
    expect(arg.embeds).toHaveLength(1);
    expect(arg.embeds[0].toJSON().description).toContain("notes/inbox/x.md");
  });

  test("non-owner throws NotOwnerError before any work", () => {
    const i = fakeInteraction({ userId: "999", commandName: "capture", strings: { text: "x" } });
    const rest = fakeRest();
    expect(() => execute(i, { rest })).toThrow(NotOwnerError); // sync throw, before defer
    expect(rest.ingest).not.toHaveBeenCalled();
    expect(i.deferReply).not.toHaveBeenCalled();
  });
});
```

**Highest-value command assertions (the contract every command test must include):**
1. `assertOwner` fires *first* — non-owner throws and **nothing else runs** (no defer, no client call). This is the security invariant.
2. `deferReply` is called for any async command (all except `/ping`) — guards the 3-second drop (Guidelines §7).
3. Client called with the right args — `kind`, `content`, `clientTag` for writes; `query` for reads.
4. `editReply` receives the right embed shape — assert on `.toJSON()` fields (description, title, fields), not on a rendered string.
5. The `loud`/ephemeral flag is correct — assert `{ flags: MessageFlags.Ephemeral }` shape; never boolean.

Apply this matrix to `/capture`, `/search`, `/ask`, `/journal`, `/brief`, `/ping`. `/journal` additionally asserts the plain-text reply (no embed, per §6.5) and that `tz.journalDateKey` is used. `/ping` is the exception that does **not** defer — assert it `reply`s within budget and reports scrypt health from `rest.health()`.

---

## 6. Testing the interaction-router error boundary (the contract test)

This is the single highest-leverage test in the suite: it proves the §7.3 mapping table. The router is one of only three catch sites, so getting it right *is* the error-handling guarantee.

```ts
// tests/bot/interaction-router.test.ts
import { describe, expect, test } from "bun:test";
import { replyWithError } from "../../src/bot/interaction-router.ts";
import { NotOwnerError, ScryptError } from "../../src/lib/errors.ts";
import { fakeInteraction } from "../helpers.ts";

// reason -> expected user text (Design §7.3)
const cases: Array<[Error, string]> = [
  [new NotOwnerError(),                            "not for you"],
  [new ScryptError("unreachable", "unreachable"),  "scrypt unreachable"],
  [new ScryptError("auth", "auth"),                "scrypt auth rejected"],
  [new ScryptError("server", "server"),            "scrypt server error"],
  [new ScryptError("timeout", "timeout"),          "scrypt timed out"],
  [new ScryptError("tool_error", "boom"),          "scrypt tool failed: boom"],
  [new ScryptError("bad_request", "no field x"),   "scrypt: no field x"],
  [new Error("anything"),                           "uxie crashed, check logs"],
];

describe("interaction-router error mapping (§7.3)", () => {
  for (const [err, expected] of cases) {
    test(`${err.constructor.name} -> "${expected}"`, async () => {
      const i = fakeInteraction({ commandName: "x" });
      i.deferred = true;                               // simulate post-defer failure
      await replyWithError(i, err);
      const arg = i.editReply.mock.calls[0]?.[0] ?? i.followUp.mock.calls[0]?.[0];
      expect(arg.content).toContain(expected);
      expect(arg.flags).toBeDefined();                 // ephemeral, never boolean
    });
  }

  test("unknown error logs full stack, does NOT leak to user", async () => {
    const i = fakeInteraction({ commandName: "x" });
    await replyWithError(i, new Error("secret detail"));
    const shown = (i.reply.mock.calls[0]?.[0] ?? i.editReply.mock.calls[0]?.[0]).content;
    expect(shown).not.toContain("secret detail");      // stack stays in logs
  });

  test("pre-defer failure uses reply; post-defer uses editReply/followUp", async () => {
    const fresh = fakeInteraction({});
    await replyWithError(fresh, new NotOwnerError());
    expect(fresh.reply).toHaveBeenCalled();
  });
});
```

**What this guards:** every row of the §7.3 table, the reply-vs-followUp branch (driven by `deferred`/`replied` flags), and the leak invariant (unknown error → generic message, stack only in logs — a redaction concern as much as UX).

**Message-router boundary test** (`tests/bot/message-router.test.ts`): on inbox handler success → `message.react("✅")`; on thrown `ScryptError` → `message.react("❌")` and the bot does not throw out of the boundary. Gate tests: non-owner / bot author / wrong channel / empty content all → handler not invoked (the §5.2 gate). Use `fakeMessage`.

> v15 note: under discord.js v15's AsyncEventEmitter, the router boundary must catch **rejected promises** from listener bodies, not just synchronous throws (api-surface §7 open Q1). Write at least one router test where the wrapped handler *rejects* (returns a rejected promise) and assert the error is still mapped — this catches the v15 migration trap early.

---

## 7. Testing the scrypt clients (rest + mcp)

`withFetch` per Plan Task 15 is the right tool. The clients are the boundary where Scrypt failures become `ScryptError` subclasses, so the test matrix *is* the §7.3 contract on the producing side.

**rest-client (`health` / `ingest` / `getDailyContext`)** — assert each HTTP outcome maps correctly. `health()` returns `{ok, reason}` (degrade-don't-crash, Guidelines §12.3); `ingest()`/`getDailyContext()` throw the right `ScryptError` subclass:

| `fetch` behavior | rest-client result |
|---|---|
| resolves 200 | success / `{ ok: true }` |
| rejects (`TypeError`) | `unreachable` |
| 401 | `auth` (`ScryptAuthError`) |
| 4xx (400) | `bad_request` (with message) (`ScryptBadRequestError`) |
| 500 | `server` |
| `AbortSignal.timeout` fires | `timeout` (`ScryptTimeoutError`) |

```ts
test("ingest maps 401 -> ScryptAuthError", async () => {
  const restore = withFetch(async () => new Response("", { status: 401 }));
  try {
    await expect(client().ingest({ kind: "note", content: "x", clientTag: "uxie-1" }))
      .rejects.toBeInstanceOf(ScryptError);
  } finally { restore(); }
});
```

**Timeout test without real waiting** — make `fetch` reject with an `AbortError` to simulate `AbortSignal.timeout` firing, rather than sleeping 10s:
```ts
const restore = withFetch(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
// expect ScryptTimeoutError / reason "timeout"
```

**mcp-client (`searchNotes` / `semanticSearch` / `getNote`)** — same shape (Design §8.2 "same shape as MCP client tests"). The MCP client wraps the `@modelcontextprotocol/sdk` streamable-HTTP transport, but the *single internal `post(tool, args)`* (Design §5.2) owns bearer auth + `AbortSignal.timeout(10_000)` + JSON parse + error mapping. Test `post`'s mapping by stubbing the transport or `globalThis.fetch`, then assert: (a) each wrapped tool parses its response into the typed hit shape, (b) the six+ HTTP/transport failures map to `ScryptError` reasons, (c) the bearer header is set, (d) `client_tag` / read args are forwarded correctly. **Always use `try { ... } finally { restore(); }`** so a failing assertion never leaks a swapped global into the next test. (See §16 Q2 — verify whether the SDK transport routes through `globalThis.fetch`; if not, inject the transport.)

---

## 8. The anti-pattern "lint test" (spec-consistency-report §4.7)

A `bun test` that greps source and fails on the highest-value §22 violations. This makes architectural invariants *enforced*, not just documented. Recommended **v1** (it is cheap and catches real drift; the report calls it "optional Wave 4 add" but its value/effort ratio is excellent).

```ts
// tests/anti-patterns.test.ts
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");
const glob = (pat: string) => [...new Glob(pat).scanSync({ cwd: process.cwd() })];

describe("architecture invariants", () => {
  test("no try/catch in command bodies (only the router catches — §14.2)", () => {
    for (const f of glob("src/integrations/*/commands/*.ts"))
      expect(read(f), `try{ found in ${f}`).not.toMatch(/\btry\s*\{/);
  });

  test("no boolean ephemeral:true (use flags: MessageFlags.Ephemeral — drift #3/#16)", () => {
    for (const f of glob("src/**/*.ts"))
      expect(read(f), `ephemeral:true in ${f}`).not.toMatch(/ephemeral\s*:\s*true/);
  });

  test("no process.env outside lib/env.ts (§17)", () => {
    for (const f of glob("src/**/*.ts")) {
      if (f.endsWith("lib/env.ts")) continue;
      expect(read(f), `process.env in ${f}`).not.toMatch(/process\.env/);
    }
  });

  test("assertOwner is the first statement in every command execute()", () => {
    for (const f of glob("src/integrations/*/commands/*.ts")) {
      const src = read(f);
      if (!/export\s+(async\s+)?function\s+execute/.test(src)) continue;
      const body = src.slice(src.indexOf("execute"));
      expect(body, `assertOwner not first in ${f}`).toMatch(/\{\s*[^}]*?assertOwner\s*\(/);
    }
  });

  test("no cross-module imports between integrations (seam guard)", () => {
    for (const f of glob("src/integrations/scrypt/**/*.ts"))
      expect(read(f)).not.toMatch(/integrations\/para-raid/);
    for (const f of glob("src/integrations/para-raid/**/*.ts"))
      expect(read(f)).not.toMatch(/integrations\/scrypt/);
  });
});
```

Extra high-value greps worth adding: no write-tool names (`create_note|add_edge|update_note_metadata`) imported in `mcp-client.ts` (v1 reads-only rule), and no `fs.writeFile` against `/vault` anywhere (plane breach, SUP §3). These turn the hardest-to-review rules into red CI.

---

## 9. env validation (zod) + logger redaction tests

**env (`lib/env.ts`)** — Plan Task 4 already sketches this. `parseEnv(source)` should accept an injectable record (default `process.env`) so tests pass a plain object and never touch the real environment. Assert: complete record → typed object; each missing field → `ConfigError` naming that field; a URL field that is not a URL → `ConfigError`. One loop over the field list keeps it tight.

```ts
const required = ["DISCORD_BOT_TOKEN","DISCORD_APP_ID","DISCORD_DEV_GUILD_ID",
  "DISCORD_OWNER_ID","INBOX_CHANNEL_ID","USER_TZ",
  "SCRYPT_SERVER_URL","SCRYPT_AUTH","SCRYPT_MCP_URL"];
for (const field of required) {
  test(`missing ${field} -> ConfigError naming it`, () => {
    const { [field]: _, ...partial } = complete;
    expect(() => parseEnv(partial)).toThrow(field);
  });
}
```

**logger redaction (`lib/log.ts`)** — the security-critical test. Any key containing `BOT_TOKEN|AUTH|SECRET|KEY` must serialize to `[REDACTED]` (Guidelines §17.2). Use `spyOn(console, "log")`, log an object with sensitive keys, parse the captured JSON, assert redaction:

```ts
test("redacts secret-bearing keys", () => {
  const spy = spyOn(console, "log").mockImplementation(() => {});
  log.info("boot", { DISCORD_BOT_TOKEN: "abc", SCRYPT_AUTH: "Bearer x", API_KEY: "k", note: "ok" });
  const payload = JSON.parse(spy.mock.calls[0][0]);
  expect(payload.DISCORD_BOT_TOKEN).toBe("[REDACTED]");
  expect(payload.SCRYPT_AUTH).toBe("[REDACTED]");
  expect(payload.API_KEY).toBe("[REDACTED]");
  expect(payload.note).toBe("ok");           // non-secret passes through
  spy.mockRestore();
});
```
Also assert redaction is **case-insensitive** and applies to **nested** objects (a real-world miss: a token nested under `env: {...}`). And assert the unknown-error path (§6) logs the full stack while the *user message* omits it — same redaction principle for stack traces.

---

## 10. What is explicitly NOT tested in v1 — and why that is correct

Per Design §8.3, with rationale strengthened so future contributors do not "fix" the gap prematurely:

- **No real Discord gateway in CI.** The gateway is Discord's code, not ours; a fake faithful enough to catch real bugs would cost more than the smoke ritual. Hand-rolled `as any` doubles cover the *contract* (defer/reply/edit) we depend on.
- **No real scrypt server in unit tests.** `test:integration` is an empty placeholder. Hitting a live vault in CI introduces network flake and double-write risk; the boundary is fully covered by `withFetch` mapping tests.
- **No embed-markdown snapshots.** Embeds are visual; their *structure* is unit-asserted (`.toJSON()` fields), their *rendering* is eyeballed in smoke steps 2/4/5/7. Full-string snapshots here would be brittle (every copy tweak churns the snapshot) for low bug-catch value. (A *targeted* `.toJSON()` snapshot is a reasonable v1.5 add; full-markdown snapshots stay out — see §15.)
- **No coverage gate in v1 (recommended).** See §12 — measure, do not gate, until the suite stabilizes.

---

## 11. The manual smoke ritual (Design §8.4, hardened per drift #15)

Run against a dev guild with `docker compose up` (both containers). The spec lists 7 happy-path + 3 failure-mode checks. Make the ritual a **recorded checklist in the PR description** so "how smoke testing is run/recorded" stops being undefined (current gap). Proposed `docs/SMOKE.md` checklist, ticked per release:

**Happy path:** 1) `/ping` → "uxie alive … scrypt: ok". 2) `/capture hello` → embed w/ `notes/inbox/…` + permalink. 3) post in `#inbox` → ✅ react + note appears. 4) `/ask …` → semantic embed (or "no matches"). 5) `/search …` → FTS5 embed. 6) `/journal …` → "appended to YYYY-MM-DD.md at HH:MM <tz>". 7) `/brief` → daily-context embed.
**Failure modes:** 8) alt account `/ping` → ephemeral "not for you"; owner still works. 9) stop scrypt, `/ping` → "scrypt: unreachable"; bot stays alive. 10) scrypt down, post `#inbox` → ❌ react; bot stays alive.

"If all ten pass with no unhandled logs, v1 ships." Recommend capturing the result as a checked-off block + a screenshot of step 2's embed pasted into the PR — this is the *de facto* embed-render verification that replaces snapshots.

---

## 12. Coverage targets + `bun test --coverage` + CI shape

**Coverage tooling (Bun-native, no extra deps):**
- `bun test --coverage` prints a per-file `% Funcs / % Lines / Uncovered Lines` table (authoritative Bun docs).
- `bunfig.toml` config:
  ```toml
  [test]
  coverage = true                       # measure on every run
  coverageReporter = ["text", "lcov"]   # text for humans, lcov for CI artifacts
  coverageSkipTestFiles = true
  # coverageThreshold = { lines = 0.85, functions = 0.85 }   # enable in v1.5
  ```
- Add a script: `"test:coverage": "bun test --coverage"`.

**Recommended targets (measure-don't-gate in v1, gate in v1.5):**
- v1: **measure only.** Aim ~85% lines on `lib/` + clients, ~100% on the §7.3 router mapping and redaction (correctness/security-critical). Do *not* set `coverageThreshold` yet — a hard gate on an immature suite produces busywork tests that inflate the number without catching bugs.
- v1.5: turn on `coverageThreshold = { lines = 0.85, functions = 0.85 }` once the surface is stable. Setting any threshold auto-enables `fail_on_low_coverage` (Bun docs), so the CI gate is one line.
- Explicitly **exclude** `src/index.ts` (boot wiring) and `deploy-commands.ts` (one-shot script) from coverage expectations — they are integration-only and covered by smoke.

**CI shape (GitHub Actions, Bun-native):** `bun test` auto-detects GitHub Actions and emits annotations with **zero config** (Bun docs). Minimal workflow:

```yaml
# .github/workflows/ci.yml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: latest }   # pin to a concrete 1.x in v1.5
      - run: bun install --frozen-lockfile
      - run: bun x tsc --noEmit          # typecheck (Plan Task 1 script)
      - run: bun test --coverage         # unit + anti-pattern + router; integration suite is empty
```

Notes: `test:integration` is **not** wired into CI in v1 (empty + needs live scrypt). When it gets real tests (v2), gate it behind a separate job with a scrypt service container or a Tailscale-reachable endpoint — *not* the default `bun test` job. Pin `bun-version` to a concrete `1.x` once chosen (avoid `latest` drift). Use `--bail` locally for fast feedback; full run in CI. `--randomize` (Bun) is worth enabling in CI to surface order-dependent tests — but only after the suite is green, since uxie tests should be order-independent by design (stateless).

---

## 13. Recommended file layout (mirrors `src/`)

```
tests/
├── helpers.ts                         # fakeInteraction, fakeMessage, withFetch, OWNER_ID
├── anti-patterns.test.ts              # §4.7 static invariants
├── lib/
│   ├── env.test.ts                    # zod happy + each-missing-field
│   ├── errors.test.ts                 # taxonomy, toUserMessage
│   ├── log.test.ts                    # redaction (security)
│   ├── tz.test.ts                     # journalDateKey, nowInZone
│   ├── auth.test.ts                   # assertOwner throws NotOwnerError
│   ├── client-tag.test.ts             # uxie-<id> / uxie-msg-<id>
│   ├── command-builder.test.ts        # withOwnerGate sets contexts/perms
│   └── embed.test.ts                  # capture/search/semantic/brief shape + caps
├── bot/
│   ├── interaction-router.test.ts     # §7.3 mapping contract (HIGH VALUE)
│   └── message-router.test.ts         # ✅/❌ ack + gate
├── integrations/scrypt/
│   ├── rest-client.test.ts            # withFetch HTTP mappings
│   ├── mcp-client.test.ts             # same shape, tool parsing
│   └── commands/
│       ├── ping.test.ts
│       ├── capture.test.ts
│       ├── search.test.ts
│       ├── ask.test.ts
│       ├── journal.test.ts
│       └── brief.test.ts
└── integration/                        # EMPTY in v1 (test:integration placeholder)
```

`package.json` scripts: `test: "bun test"` (excludes `tests/integration/` by convention — keep it empty so it's a no-op), `test:integration: "bun test tests/integration/"`, `test:coverage: "bun test --coverage"`, `typecheck: "bun x tsc --noEmit"`.

---

## 14. Highest-value tests to write FIRST (TDD order)

Because every Plan task starts with its failing test, the *order* follows the wave order. Within that, these earn their keep first:

1. **`lib/env.test.ts`** — boot fails loudly on misconfig; everything depends on env. (Wave 0/1)
2. **`lib/log.test.ts` redaction** — security; a leaked token in logs is the worst v1 failure. (Wave 1)
3. **`lib/errors.test.ts` + `interaction-router.test.ts` mapping** — the §7.3 contract is the app's behavioral spine. Write the router contract test *as* the spec of `toUserMessage`. (Wave 2)
4. **`rest-client.test.ts` / `mcp-client.test.ts` mappings** — the boundary that produces every `ScryptError`. (Waves 2–3)
5. **`anti-patterns.test.ts`** — once `commands/` exist, lock the invariants before they drift. (early Wave 3)
6. **command tests** — one per command, the §8.2 three-assertion matrix. (Waves 3–4)
7. **`embed.test.ts`** — shape + truncation/cap; the structural stand-in for snapshots. (Wave 3)

---

## 15. Prioritized recommendation summary

See the structured output table for the full prioritized list. Headlines: DI-into-commands (v1, the enabling decision), router-mapping contract test (v1, highest value), anti-pattern lint test (v1), redaction test (v1, security), `bun test --coverage` measure-don't-gate (v1) → threshold gate (v1.5), GitHub Actions CI (v1), recorded smoke checklist (v1), targeted embed `.toJSON()` snapshots (v1.5), real integration suite + scrypt service container (v2).

---

## 16. Open questions

1. **Command signature:** does the build adopt `execute(i, deps)` DI, or keep `execute(i)` + a module-singleton client? DI makes tests trivial and avoids Bun's `mock.module` cache footgun; confirm this small spec refinement is acceptable (it does not add state). *(Affects every command test.)*
2. **MCP transport mockability:** can `@modelcontextprotocol/sdk`'s `StreamableHTTPClientTransport` be exercised via `withFetch` (does it use `globalThis.fetch`?), or must the test stub the transport object? Verify before writing `mcp-client.test.ts`. If not fetch-based, inject the transport.
3. **"Six vs seven" mappings:** Design §8.2/§7.3 text says "six HTTP-failure mappings" but the §7.3 table lists **seven** rows (unreachable, auth, bad_request, server, timeout, tool_error + the catch-all "uxie crashed"). Which is canonical? The router test should cover all rows regardless; flag for a doc bump.
4. **Coverage threshold value:** is 85% the right v1.5 gate, or should the security-critical files (router, log) carry a 100% sub-target while the rest sit at 80%? Bun supports a single global threshold, not per-file — per-file gating needs lcov + an external check.
5. **Embed verification of record:** is a pasted screenshot of the `/capture` embed in the PR an acceptable substitute for snapshots in v1, and should a `.toJSON()` snapshot be added in v1.5?
6. **Bun version pin:** `setup-bun` with `latest` vs a pinned `1.x` — when does the project lock a concrete Bun version for reproducible CI?
7. **v15 async-listener catch:** does the planned interaction-router catch rejected promises from listener bodies (v15 AsyncEventEmitter), and is there a test that proves it? (api-surface §7 Q1.)

---

## Sources

- **Primary docs (source of truth):**
  - `docs/superpowers/specs/2026-04-14-uxie-design.md` — §7.2 Catch sites, §7.3 User-facing messages, §7.4 Retry policy, §8.1–8.5 Testing.
  - `docs/superpowers/plans/2026-04-14-uxie.md` — Task 1 (package.json/tsconfig/scripts), Task 4 (env test), Task 15 (`withFetch` rest-client test), Task 20 (embed tests), per-task "Step 1: failing test".
  - `docs/UXIE-DISCORD-GUIDELINES.md` — §3 (bun test), §5.2 (owner gate), §7/§8 (defer + ephemeral), §12.3 (degrade-don't-crash), §14.1–14.2 (error taxonomy + three catch sites), §17 (env/redaction), §19 (smoke), §22 (anti-patterns).
  - `docs/SUP-GUIDELINES.md` — §3 (no direct vault writes), §13 (protect the boundary).
  - `docs/spec-consistency-report.md` — §4.7 #7 (anti-pattern lint test), drift #3/#13/#15/#16 (boolean ephemeral, try/catch guardrail, smoke failure modes, stub flags).
  - `docs/discordjs-api-surface.md` — §7 open questions (Q1 v15 async-listener rejected-promise catch).
- **Bun test runner (authoritative):**
  - https://bun.com/docs/cli/test — runner, file patterns (`*.test.ts` / `*.spec.ts`), lifecycle hooks, `--preload`, `--bail`, `--randomize`, `--seed`, GitHub Actions auto-annotations, snapshot `--update-snapshots`.
  - https://bun.com/docs/test/mocks — `mock()`, `mock.module()` (and its cache-not-reset-by-restore footgun), `spyOn`, `mock.restore()` / `clearAllMocks()`, `mockResolvedValue`/`mockRejectedValue`, `vi`/`jest` aliases.
  - https://bun.com/docs/test/coverage — `--coverage`, `bunfig.toml` `coverage` / `coverageThreshold` (simple + `{ lines, functions, statements }`) / `coverageReporter` (`text`, `lcov`) / `coverageSkipTestFiles`, `fail_on_low_coverage`.
- **discord.js (authoritative, via context7 `/discordjs/guide`):**
  - guide/slash-commands/response-methods.md — `deferReply({ flags: MessageFlags.Ephemeral })`, `editReply`, 3-second defer rule.
  - guide/creating-your-bot/command-handling.md — official error-handling pattern (`if (interaction.replied || interaction.deferred) followUp else reply`), the model for `replyWithError`.
- **2025–26 best practice (web):**
  - OneUptime, "How to Write Tests with Bun Test Runner" (2026-01-31) — DI for testability, mock network/DB, `afterEach` cleanup, `mockResolvedValue`/`mockRejectedValue` for deterministic async. https://oneuptime.com/blog/post/2026-01-31-bun-testing/view
