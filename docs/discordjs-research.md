# discord.js Technical Brief for `uxie`

_Research date: 2026-04-14. Target: personal, phone-first Discord bot on Oracle Cloud ARM VM, first integration `scrypt` (MCP bearer over `POST /mcp`)._

---

## 1. Current version, changelog, v15 roadmap

- **Stable line:** `discord.js@14.26.x` (docs site currently renders 14.26.2; npm tag `latest` was `14.25.1` at time of research — both are within the same minor). Requires **Node ≥ 22.12**. Source: https://discord.js.org/docs and https://www.npmjs.com/package/discord.js.
- **v14 recent arc:** Components V2 builders and `MessageFlags.IsComponentsV2` landed during the 14.21–14.24 line (2025). The `rest` event was removed — `REST` now uses Undici + a Node Diagnostics Channel. Source: https://github.com/discordjs/discord.js/blob/main/packages/discord.js/CHANGELOG.md.
- **v15 (pre-release, not for production).** Tracked at https://discordjs.guide/v15. Notable breaks:
  - `NewsChannel` → `AnnouncementChannel`.
  - `Events.ClientReady` event name is now `"clientReady"` (previously `"ready"`).
  - `Events.WebhooksUpdate` emits `"webhooksUpdate"` (previously `"webhookUpdate"`).
  - `BaseClient`, `Shard`, `ShardingManager`, `Collector` extend **AsyncEventEmitter** instead of `EventEmitter` — listeners can be async and are awaited.
  - `Message#interaction` removed in favor of `Message#interactionMetadata`.
  - `ActionRow.from()` removed → `ActionRowBuilder.from()`.
  - `ApplicationCommand#dmPermission` removed → use `contexts`.
  - `sendPremiumRequired()` removed (Discord dropped `PREMIUM_REQUIRED` response type); use premium-style buttons.

**Implication for uxie:** pin `discord.js@^14.26` and keep an eye on v15 but do **not** adopt pre-release. When v15 stabilizes, the lift is mostly: rename `"ready"` listener, swap `Events.WebhooksUpdate` string, review any `.from()` calls.

---

## 2. Runtime: Node vs Bun vs Deno

| Runtime | discord.js core | `@discordjs/voice` | ARM Linux | Verdict |
|---|---|---|---|---|
| **Node 22 LTS** | Official target | Works | First-class | ✅ default |
| **Bun ≥ 1.x** | "Works out of the box" per Bun docs (https://bun.com/docs/guides/ecosystem/discordjs) | **Broken** — opus native binding fails to load (oven-sh/bun#11313) | arm64 supported | ⚠️ fine if no voice |
| **Deno** | Works via npm specifier; rarely covered in community docs | Voice unreliable | arm64 supported | ❌ not worth the tooling drift |

**ARM-specific gotcha:** any native deps (`zlib-sync` for faster WS, `@discordjs/opus`, `sodium-native`) need prebuilds for `linux-arm64`. `zlib-sync` is **optional** — discord.js falls back to `node:zlib`. Skip native zlib unless gateway throughput becomes a real problem.

---

## 3. Slash commands & interactions

- **Builder API:** `SlashCommandBuilder` with `.addSubcommand` / `.addSubcommandGroup`, `.addStringOption`, `.addUserOption`, `.addChannelOption`, `.addAttachmentOption`, `.addNumberOption`. Source: https://discordjs.guide/slash-commands.
- **Registration:**
  - **Global** (`Routes.applicationCommands(appId)`) — propagates in seconds to minutes; use for production.
  - **Guild** (`Routes.applicationGuildCommands(appId, guildId)`) — instant; use during dev against your personal test guild.
  - For uxie (single user, single guild realistically), guild-scoped is fine and gives instant iteration. Also keeps commands hidden from `applications.commands` discovery.
- **Autocomplete:** second interaction type fires per keystroke on an option; respond with `interaction.respond([{name, value}, ...])` within 3s. Cap 25 choices.
- **Permissions model (post-v12 of Discord API):**
  - `.setDefaultMemberPermissions(PermissionFlagsBits.X)` — coarse gate by guild permission bit.
  - `.setContexts(InteractionContextType.Guild | BotDM | PrivateChannel)` — where the command is usable.
  - `.setIntegrationTypes(ApplicationIntegrationType.GuildInstall | UserInstall)` — user-installable apps can run in any DM/guild the user is in.
- **Response window:** 3s to acknowledge, then 15 min to `editReply`/`followUp`. `deferReply()` is mandatory for anything touching scrypt.

---

## 4. Components V2

Released March 2025. Fundamentally different from classic messages: instead of `content + embeds + components`, the whole message is a tree of components. Source: https://discordjs.guide/legacy/popular-topics/display-components and https://github.com/ZarScape/discord.js-v2-components.

**Opt-in:** send with `flags: MessageFlags.IsComponentsV2`. **Mutually exclusive** with `content` and `embeds` in the same message — you pick one world or the other per message.

**Available builders** (in `discord.js`):
- `ContainerBuilder` — up to **10** child components, optional `accent_color`, optional `spoiler`. Visually mirrors the old embed left-bar.
- `TextDisplayBuilder` — markdown text block. Replaces embed description.
- `SectionBuilder` — text + accessory (thumbnail or button). Like an embed field with an action.
- `SeparatorBuilder` — divider, optional spacing/divider style.
- `MediaGalleryBuilder` — up to 10 images in a grid.
- `FileBuilder` — inline file reference (uses `attachment://` URIs like classic attachments).
- `ActionRowBuilder` — still the host for buttons / selects at the top level or inside containers.

**Why it matters for uxie:** containers with text displays + section accessories give far richer mobile layouts than embeds (e.g., a scrypt note preview with a "Open" button as the section accessory). Embed field/char limits are replaced by an overall **4000-component-character** cap per message.

**Gotcha:** you cannot retrofit — if you want to mix a V2 container with a normal `content` string, you can't. Pick V2 per command.

---

## 5. Classic embeds — limits & mobile

Source: https://discordjs.guide/popular-topics/embeds.

| Field | Limit |
|---|---|
| Title | 256 |
| Description | 4096 |
| Field name | 256 |
| Field value | 1024 |
| Fields per embed | 25 |
| Footer text | 2048 |
| Author name | 256 |
| Embeds per message | 10 |
| **Total chars per message (sum of all embeds)** | **6000** |

**Mobile caveats:**
- Inline fields collapse to 2-wide on phones below ~400dp; plan for 1–2 inline fields max.
- Thumbnails shrink aggressively; prefer `setImage` (full-width) for anything the user needs to read.
- Footer icons are tiny on mobile — don't put information there.
- `setURL` on the title gives a tappable header; very phone-friendly.

**Ephemeral:** `interaction.reply({ embeds: [...], flags: MessageFlags.Ephemeral })`. Ephemeral replies **do not count against rate limits** and are only visible to the invoker — ideal for personal tool output.

---

## 6. Attachments & files

- `AttachmentBuilder.from(buffer | stream | path)` with optional `setName`, `setDescription`, `setSpoiler`.
- Reference in embeds via `attachment://name.ext`.
- **Hard cap:** 25 MB for a non-boosted user upload (Discord raised defaults in 2024). For larger artifacts (logs, PDFs), upload to an external store and link.
- For scrypt: pass markdown as `Buffer.from(md)` + `.md` attachment when output exceeds Components V2 / embed limits.

---

## 7. Threads & forum channels

- `channel.threads.create({ name, autoArchiveDuration, type: ChannelType.PrivateThread | PublicThread })`.
- `ForumChannel#threads.create({ name, message: { ... } })` — forum threads **require** a starter message. Source: https://discord.js.org/docs/packages/discord.js/main/ForumChannel:Class.
- `ThreadChannel#fetchStarterMessage()` retrieves the message that spawned a public thread (GitHub discussion #8807).
- Auto-archive options: 60, 1440, 4320, 10080 minutes. Private threads on boosted guilds only.
- **Useful pattern for uxie:** spawn a thread per "research run" or per long scrypt task. Gives you: scrollable history scoped to one task, mobile notification control, and a natural place to post progress `editReply` updates followed by `channel.send` streamed chunks. Thread titles become the task name → easy to find later on phone.

---

## 8. Voice (`@discordjs/voice`)

Package is separate from `discord.js` core. Requires:
- Native opus encoder (`@discordjs/opus` preferred, or `opusscript` pure-JS fallback).
- `libsodium-wrappers` or `sodium-native` for packet encryption.
- A working prebuild for `linux-arm64` — `@discordjs/opus` has one, but `sodium-native` has historically been the flaky one on ARM.

**Bun incompatibility:** oven-sh/bun#11313 — opus native binding does not resolve under Bun, breaking voice.

**Recommendation for uxie v1: skip.** Voice is a large dependency footprint, adds a privileged-ish UX path you didn't ask for, and blocks adopting Bun later. Add only when you concretely want voice notes into scrypt.

---

## 9. Minimum gateway intents

For a DM-friendly, slash-first assistant bot that can also read text in the one guild you live in:

```ts
intents: [
  GatewayIntentBits.Guilds,             // required for interactionCreate in guilds
  GatewayIntentBits.GuildMessages,      // receive guild message events (not content)
  GatewayIntentBits.DirectMessages,     // receive DM message events
  GatewayIntentBits.MessageContent,     // PRIVILEGED — enable in dev portal
],
partials: [Partials.Channel, Partials.Message], // required so DMs fire at all
```

- **`MessageContent`** is privileged but free for unverified bots (< 100 guilds). Required if you want uxie to respond to plain DM messages (not just slash commands).
- **`GuildMembers`** is privileged — only add if you need member join events / full roster. Not needed for a personal bot.
- **`DirectMessages` needs the `Channel` partial** or DM events never fire. This is the #1 "why doesn't my DM bot work" answer on Answer Overflow.
- Slash commands are delivered via `interactionCreate` which only requires `Guilds`. If you go **slash-only**, you can drop `GuildMessages`, `DirectMessages`, and `MessageContent` entirely and avoid the privileged-intent toggle.

---

## 10. Project layout patterns

Guide-recommended layout (https://discordjs.guide/creating-your-bot/event-handling):

```
uxie/
├── src/
│   ├── commands/
│   │   ├── scrypt/
│   │   │   ├── search.ts
│   │   │   ├── capture.ts
│   │   │   └── recent.ts
│   │   └── meta/
│   │       └── ping.ts
│   ├── events/
│   │   ├── ready.ts
│   │   └── interactionCreate.ts
│   ├── lib/
│   │   ├── mcp.ts           # scrypt MCP client singleton
│   │   └── env.ts           # zod-validated env
│   ├── deploy-commands.ts   # standalone REST PUT
│   └── index.ts
├── .env
├── package.json
└── tsconfig.json
```

**File-based routing pattern:** `commands/<category>/<name>.ts` exports `{ data: SlashCommandBuilder, execute: (i) => Promise<void>, cooldown?: number }`. A boot-time loader globs `commands/**/*.ts`, fills a `Collection<string, Command>`, and `interactionCreate` dispatches by `interaction.commandName`.

**ESM dynamic imports:** use `import()` with `pathToFileURL` for Windows-safe imports (not relevant on ARM Linux but cheap to keep):

```ts
const mod = await import(pathToFileURL(file).href);
```

**Event handler loader:** mirror the command loader for `src/events/*.ts`, exporting `{ name: Events.X, once?: boolean, execute }`.

**Cooldowns:** `client.cooldowns = new Collection<string, Collection<string, number>>()`, checked in `interactionCreate`. For a single-user bot this is basically unnecessary — skip it.

---

## 11. TypeScript + ESM setup

discord.js ships its own types — no `@types/discord.js`.

**Recommended `tsconfig.json` (pragmatic, not maximally strict):**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
```

- `"type": "module"` in package.json.
- Node 22 can run `.ts` directly via `--experimental-strip-types` for dev (`node --env-file=.env --experimental-strip-types src/index.ts`). In production, build once with `tsc` and run `dist/index.js` under systemd — no transformer at runtime.
- `verbatimModuleSyntax` catches accidental type/value imports, important when mixing discord.js runtime classes and types.
- Skip `noUncheckedIndexedAccess` if it fights too much with command option lookups.

---

## 12. Testing interaction handlers

There's no official discord.js test harness. Pragmatic approach:

1. **Separate pure logic from interaction glue.** A scrypt search command's body should be `(query: string) => Promise<RenderableResult>`; the slash handler is a 10-line adapter that calls it and formats.
2. **Unit test the pure functions** with `vitest` or `node --test`. No Discord involved.
3. **Mock interactions** for the adapter layer with a hand-rolled double: `{ deferReply: vi.fn(), editReply: vi.fn(), options: { getString: () => 'foo' } }`. Cast as `any` — the real `ChatInputCommandInteraction` type is famously hostile to fake construction.
4. **End-to-end smoke:** your dev guild + a `/ping` or `/scrypt-health` command. Faster feedback than any unit test because the real surface is Discord's rendering.

For uxie specifically, prioritize **logic tests for the MCP client wrapper** (response parsing, error mapping) and **manual smoke** on the bot side.

---

## 13. Deployment on Oracle Cloud ARM

- **Image:** Ubuntu 24.04 LTS arm64 on an Ampere A1 Flex shape (free tier gives up to 4 OCPU / 24 GB RAM).
- **Node install:** NodeSource apt repo or `fnm` — NodeSource gives you arm64 debs for Node 22 LTS directly.
- **Tailscale:** `curl -fsSL https://tailscale.com/install.sh | sh`, then `tailscale up`. The bot only needs outbound to Discord gateway + inbound (none) — Tailscale is there so you can SSH and so the MCP client can reach scrypt over the tailnet.
- **scrypt MCP endpoint:** call `POST http://<scrypt-host>.ts.net:PORT/mcp` — use the tailnet MagicDNS name, not an IP.

**systemd unit** (`/etc/systemd/system/uxie.service`):

```ini
[Unit]
Description=uxie Discord bot
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=uxie
WorkingDirectory=/opt/uxie
EnvironmentFile=/opt/uxie/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
# light hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/uxie/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

- `journalctl -u uxie -f` for logs — don't bother with winston/pino files, journald is enough for a single-user bot.
- **PM2 vs systemd:** systemd wins on a single-purpose VM (one less dep, one less thing to restart on reboot, native log aggregation). PM2 only makes sense if you're running multiple bots in cluster mode.

**Env / token rotation:**
- Store `DISCORD_TOKEN`, `SCRYPT_MCP_URL`, `SCRYPT_BEARER` in `/opt/uxie/.env`, mode `600`, owner `uxie:uxie`.
- Rotate by editing `.env` and `systemctl restart uxie`. For anything fancier, Oracle Vault or `sops` + age — overkill for v1.
- Never commit `.env`. Keep a `.env.example`.

---

## 14. Rate limits & best practices

Sources: https://docs.discord.com/developers/topics/rate-limits, https://deepwiki.com/discordjs/discord.js/5.3-rate-limits-and-api-optimization.

- **Global:** 50 requests/sec across all routes, per bot token.
- **Per-route:** varies, communicated via `X-RateLimit-*` headers — never hardcode.
- **Invalid request budget:** 10,000 invalid (401/403/429) requests per 10 min → bot token gets temp-banned. Relevant if you're logging permission failures in a loop.
- **discord.js REST queue** handles 429s automatically by inspecting `retry_after` and replaying the request. Usually invisible.
- **Ephemeral interaction responses don't count** toward message rate limits — bias toward ephemeral for personal output.
- **Don't rapid-edit `editReply`** during streaming — each edit is a REST call. Debounce updates to ≥1s intervals, or better, append as followups / edit at logical checkpoints.
- **Sharding:** not relevant until ~2000 guilds. Skip.

---

## 15. AI-assistant bot patterns

- **Defer early.** First line of `execute`: `await interaction.deferReply({ flags: MessageFlags.Ephemeral })`. Anything after this has 15 min, not 3s.
- **Channel typing indicator** (`channel.sendTyping()`) lasts ~10s and is only useful for message-based handlers, not interactions — interactions already show "uxie is thinking…" from `deferReply`.
- **Chunked replies.** Discord message limit is 2000 chars content / 4000 for Nitro. For longer markdown (scrypt note dumps): chunk on paragraph boundaries, send first via `editReply`, rest via `followUp`. If the output is a full document, post once as a `.md` attachment instead — mobile users get an in-app markdown viewer.
- **Progress edits.** Long MCP calls → update `editReply` with step markers ("Searching scrypt…", "Found 12 notes, ranking…"). Keep edits ≥1s apart. Use a compact Components V2 `ContainerBuilder` with a single `TextDisplay` you mutate.
- **Thread-as-conversation.** For multi-turn research: slash command opens a private thread, bot follows up inside the thread so every subsequent message is scoped. Thread title = task name. `autoArchiveDuration: 10080` (7 days) so mobile notifications die naturally.
- **MCP client library.** Use `@modelcontextprotocol/sdk` (the official TypeScript SDK — runs on Node/Bun/Deno). For scrypt's `POST /mcp` with bearer auth, use `StreamableHTTPClientTransport`:

  ```ts
  import { Client } from "@modelcontextprotocol/sdk/client/index.js";
  import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

  const transport = new StreamableHTTPClientTransport(
    new URL(process.env.SCRYPT_MCP_URL!),
    { requestInit: { headers: { Authorization: `Bearer ${process.env.SCRYPT_BEARER}` } } }
  );
  const mcp = new Client({ name: "uxie", version: "0.1.0" });
  await mcp.connect(transport);
  const tools = await mcp.listTools();
  const res = await mcp.callTool({ name: "scrypt.search", arguments: { q } });
  ```

  Source: https://github.com/modelcontextprotocol/typescript-sdk and https://ts.sdk.modelcontextprotocol.io/.

- **Wrap the client in a singleton** with lazy reconnect — you don't want every slash command re-handshaking MCP.
- **Surface tool errors as ephemeral text** with the raw error in a collapsed quote. Debuggable on phone.

---

## Recommendations for uxie

**Runtime: Node 22 LTS.** Bun is tempting but the `@discordjs/voice` incompat signals that native-module friction will keep biting. You can always migrate later if voice stays off-table. Install via NodeSource apt on Ubuntu 24.04 arm64.

**TypeScript: pragmatic strict.** `strict: true`, `noUncheckedIndexedAccess: true`, `verbatimModuleSyntax: true`. Skip `exactOptionalPropertyTypes` — fights with discord.js builders. ESM + `NodeNext`. Build with `tsc` to `dist/`, run compiled JS under systemd. No ts-node/tsx at runtime.

**Project layout:** file-based routing under `src/commands/<category>/<name>.ts` with a boot-time loader. Match it for `src/events/*.ts`. Keep MCP client in `src/lib/mcp.ts` as a module singleton.

**Primary interaction model: slash-first, hybrid later.**
- v1: everything is a slash command, registered per-guild against your personal test guild for instant iteration. No `MessageContent` intent needed — drop privileged intents entirely.
- v1.5 (if you want DM free-text): add `DirectMessages` + `MessageContent` + `Partials.Channel`, add a lightweight `messageCreate` handler that only reacts in DMs and routes to the same underlying functions the slash commands use.
- Why slash-first: no privileged intent toggle, mobile users get native autocomplete, each scrypt verb becomes a discoverable command (`/scrypt search`, `/scrypt capture`, `/scrypt recent`).

**Defer past v1:**
- Voice (`@discordjs/voice`) — large surface, no clear win yet.
- Sharding — irrelevant at 1 guild.
- Cooldowns — single user, skip entirely.
- Components V2 for everything — start with classic embeds + ephemeral, upgrade specific commands to V2 containers once you feel embed limits.
- Full test suite — keep pure functions testable, rely on manual smoke for the adapter layer.
- Secret manager — plain `.env` + systemd `EnvironmentFile` is fine for a personal bot on your own VM.

**Adopt at v1:**
- `discord.js@^14.26`, `@discordjs/rest` (pulled transitively).
- `@modelcontextprotocol/sdk` with `StreamableHTTPClientTransport` for scrypt.
- `zod` for env validation and for parsing MCP tool results.
- `pino` or just `console` — journald captures either. `pino` only if you want structured fields later.
- systemd unit on Ubuntu 24.04 arm64, Tailscale for reaching scrypt, MagicDNS for the MCP URL.
- A single `/scrypt` command with subcommands: `search`, `capture`, `recent`, `open`. Map 1:1 to scrypt MCP tools.
- Ephemeral replies by default. Attach `.md` files when output exceeds ~1500 chars.

**Watch:** v15 stabilization (rename `ready` → `clientReady`, drop `Message#interaction`). Pin to v14 until v15 is `latest` on npm for at least a month.

---

## Source index

- discord.js docs — https://discord.js.org/docs
- discord.js guide — https://discordjs.guide
- v15 migration — https://discordjs.guide/v15
- Components V2 reference — https://docs.discord.com/developers/components/reference
- Components V2 sample repo — https://github.com/ZarScape/discord.js-v2-components
- Rate limits — https://docs.discord.com/developers/topics/rate-limits
- Rate limits deep dive — https://deepwiki.com/discordjs/discord.js/5.3-rate-limits-and-api-optimization
- Bun + discord.js guide — https://bun.com/docs/guides/ecosystem/discordjs
- Bun voice incompat — https://github.com/oven-sh/bun/issues/11313
- MCP TypeScript SDK — https://github.com/modelcontextprotocol/typescript-sdk
- MCP TS SDK site — https://ts.sdk.modelcontextprotocol.io/
- ForumChannel class — https://discord.js.org/docs/packages/discord.js/main/ForumChannel:Class
- Threads guide — https://discordjs.guide/popular-topics/threads.html
- Embeds guide — https://discordjs.guide/popular-topics/embeds
- Intents guide — https://github.com/discordjs/guide/blob/main/guide/popular-topics/intents.md
- Changelog — https://github.com/discordjs/discord.js/blob/main/packages/discord.js/CHANGELOG.md
