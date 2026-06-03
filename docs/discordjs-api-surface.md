# discord.js Public API Surface — uxie verdicts

> **Status:** Living. Pin to `discord.js@^14.26.2`; flag deltas for v15 migration.
> **Last updated:** 2026-04-26
> **Maintainer:** sainayan.mahto@goveva.com
> **Audience:** anyone considering reaching for a discord.js symbol from inside uxie.
> **Inputs:** `docs/UXIE-DISCORD-GUIDELINES.md`, `docs/SUP-GUIDELINES.md`, `docs/discordjs-research.md`. This doc *applies the verdicts* those three lock in; if a verdict here contradicts them, those documents win.

---

## §1. Scope & method

This document audits **every public symbol of discord.js v14.26.2 and its sibling subpackages** that a uxie developer might plausibly reach for, and assigns one of three verdicts grounded in uxie's actual scope timeline:

- **v1** — single guild, **single user** (owner-only). Slash-first, ephemeral classic embeds, `#inbox` capture, owner-gated in code. The six commands `/ping`, `/capture`, `/search`, `/ask`, `/journal`, `/brief` are the entire surface.
- **v1.5+** — single guild, **multi-user**. Other humans in the same dev guild use uxie. Still one guild, still not public, still not multi-tenant in any SaaS sense — but no longer owner-only. Per-user permission gating, role-aware command access, member-aware UX, and onboarding for non-owners all become real.
- **Far future (per SUP §11)** — multi-tenant, multi-guild. Aspirational; nothing in the codebase blocks it yet, but nothing in the codebase exists for it.
- **Migration target:** **discord.js v15**. We will adopt it once it stabilizes. Anything Discord/discord.js *removed or deprecated* on the v15 path stays NEVER even though we run v14 today — *because* our v15 commitment is explicit, adopting a removed symbol now creates migration debt against a destination we've already chosen.

Verdicts are therefore:

- **USE NOW** — required or natural for the v1 surface.
- **USE LATER** — plausible at v1.5 (single-guild multi-user) or far-future (SUP-§11 multi-tenant) or as part of the Para-RAID ops console. Modals, autocomplete, context-menu commands, threads-as-conversations, Components V2 progressive disclosure, *plus* the multi-user infrastructure: `GuildMembers` intent, `PermissionFlagsBits`, `setDefaultMemberPermissions` with non-zero values, `GuildMember` / `Role` / `RoleManager`, light moderation surfaces, polls.
- **NEVER USE** — incompatible with our architecture (Bun + voice, stateless rule, single-process), out of scope for the SUP User plane (audit-log writes, full moderation), or removed/deprecated on the v15 path. The horizontal-scaling subpackages — `brokers`, `proxy`, `next` — stay NEVER even far-future, because their problem (multiple processes/hosts coordinating one bot) only arrives at multi-tenant SaaS scale we have no concrete plan for.

### What I fetched

Fully indexed in this session via `ctx_fetch_and_index` (raw output stayed in sandbox; only relevant excerpts were searched). The full URL list is in §8.

- discord.js v14.26.2 hub + the 25 most-used class/enum/interface pages explicitly named in the brief.
- Subpackage index pages for `builders`, `rest`, `ws`, `voice`, `util`, `collection`, `core`, `formatters`, `brokers`, `proxy`, `next`.
- v15 migration guide (`discordjs.guide/v15`) and the discord.js CHANGELOG for the recent 14.x arc.
- Discord platform docs: rate limits, interactions reference, components reference, components overview.
- Premium-bot patterns: discord.js sharding & cache-customization guides; OpenAI streaming guide as the closest authoritative source on AI-streaming UX.

### How to read the tables

```
| Symbol | Kind | Verdict | Why | uxie touchpoint |
```

- **Symbol** — exact export name. Methods/properties only listed when the verdict differs from the parent class or when uxie touches them specifically (e.g., `Client#sweepers`).
- **Kind** — Class / Fn / Enum / Iface / Type / Var.
- **Verdict** — `USE NOW` / `USE LATER` / `NEVER`.
- **Why** — a single short clause grounded in our use case. No generic API descriptions.
- **uxie touchpoint** — `bot/client.ts`, `lib/embed.ts`, etc., or `—` for NEVER.

Internal type re-exports (e.g., `APIBlah` mirrors of discord-api-types) are not enumerated unless they affect a verdict; uxie should **import them from `discord-api-types/v10` directly** when needed, never from the discord.js root.

When two symbols overlap I call out the preferred one inline. The high-traffic example: **EmbedBuilder is preferred over ContainerBuilder for v1**, the latter is the upgrade path. See §2.1.

---

## §2. By-subpackage symbol catalog

### §2.1 `discord.js` (the umbrella package)

#### Client lifecycle, options, intents

| Symbol | Kind | Verdict | Why | uxie touchpoint |
|---|---|---|---|---|
| `Client` | Class | USE NOW | Single bot process, owner-gated. `new Client({ intents, partials })` is the boot. | `bot/client.ts` |
| `Client#login(token)` | Fn | USE NOW | Boot. | `bot/client.ts` |
| `Client#destroy()` | Fn | USE NOW | Graceful systemd `SIGTERM` shutdown. | `bot/client.ts` |
| `Client#isReady()` | Fn | USE NOW | Used by `/ping` to assert gateway state. | `commands/ping.ts` |
| `Client#options.sweepers` | Iface | NEVER | Stateless rule §15: we don't cache enough for sweep tuning to matter. Default is fine. | — |
| `Client#options.makeCache` | Fn | NEVER | Same — stateless v1 doesn't shape caches. Revisit only if memory profiling at v2 says so. | — |
| `Client#options.allowedMentions` | Iface | USE NOW | Set `{ parse: [], repliedUser: false }` once at construction; ephemeral output should never @anyone. | `bot/client.ts` |
| `Client#options.shards`/`shardCount` | num/arr | NEVER | Single-guild bot; deleted in v15 anyway (moved to `ws.shardIds`/`ws.shardCount`). | — |
| `Client#options.presence` | Iface | USE LATER | Set "watching scrypt" once stable; cosmetic. v1.5. | `bot/presence.ts` (later) |
| `Client#options.rest` | Iface | USE LATER | Pass a custom `REST` only if we need a Tailscale proxy or custom UA. v1 default. | — |
| `Client#options.ws` | Iface | NEVER | Single shard; defaults are fine. | — |
| `Client#options.failIfNotExists` | bool | NEVER | We don't reply-to messages. | — |
| `Client#options.partials` | Enum[] | USE NOW | `Partials.Channel`, `Partials.Message` for `#inbox` capture. | `bot/client.ts` |
| `Client#sweepers` | Class | NEVER | Manual sweep — stateless rule. | — |
| `Client#rest` | Class | USE LATER | Direct REST escape hatch (e.g., command registration); usually go through builders. | `scripts/register-commands.ts` |
| `Client#ws` | Class | USE LATER | Read `ws.ping` for `/ping`. (v15 moves to `Client#ping`.) | `commands/ping.ts` |
| `Client#user` | ClientUser | USE NOW | Bot identity in `/ping`. | `commands/ping.ts` |
| `Client#application` | ClientApplication | USE LATER | Needed if we ever programmatically register global commands from runtime. | — |
| `Client#guilds` | Manager | USE NOW | Resolve the single owner guild on boot. | `bot/client.ts` |
| `Client#users` | Manager | USE LATER | v1.5 multi-user: resolve message authors / display names in audit traces. v1 owner-only doesn't need it. | — |
| `Client#channels` | Manager | USE NOW | Resolve `INBOX_CHANNEL_ID` on boot. | `bot/client.ts` |
| `Client#emojis` | Manager | NEVER | Removed in v15 (use `resolveGuildEmoji` util). Don't bind to it now. | — |
| `Client#voice` | Manager | NEVER | Bun + `@discordjs/voice` is broken (`oven-sh/bun#11313`). | — |
| `Client#shard` (`ShardClientUtil`) | Class | NEVER | We don't run under `ShardingManager`. | — |
| `BaseClient` | Class | NEVER | Internal; only the `extends` chain matters. v15 makes it `AsyncEventEmitter`-based — listeners can be async, no breaking change for us. | — |
| `ClientOptions` | Iface | USE NOW | Construction shape. | `bot/client.ts` |
| `ClientUser` | Class | USE LATER | Only if we want to programmatically set username/avatar; not v1. | — |
| `ClientPresence` | Class | USE LATER | Companion to presence above. | — |

**Key intents — `GatewayIntentBits` enum**

| Member | Verdict | Why |
|---|---|---|
| `Guilds` | USE NOW | Required for `interactionCreate`. |
| `GuildMessages` | USE NOW | Required for `messageCreate` in `#inbox`. |
| `MessageContent` | USE NOW | Privileged; required to read `#inbox` body. Free for unverified bots. |
| `DirectMessages` | USE LATER | v1.5 if we open DM capture. Adds attack surface. |
| `GuildMembers` | USE LATER | Privileged. **Enable in dev portal when v1.5 ships** — needed for per-user permission gating, role-aware command access, and member events. v1 stays without it (owner-gate is `i.user.id === DISCORD_OWNER_ID`). |
| `GuildPresences` | NEVER | Privileged with no concrete uxie feature attached even at v1.5. Presence is rarely the right signal; revisit only if a specific feature demands it. |
| `GuildMessageReactions` | USE LATER | Reaction-as-UX (🔍 → search) plus v1.5 multi-user reaction acks. |
| `DirectMessageReactions` / `DirectMessageTyping` / `DirectMessagePolls` | USE LATER | DMs land in v1.5 if they land at all; companions to `DirectMessages`. |
| `GuildVoiceStates` | NEVER | No voice (Bun + `@discordjs/voice` broken). |
| `GuildExpressions` / `GuildIntegrations` / `GuildWebhooks` / `GuildInvites` | NEVER | None map to uxie's surface even at v1.5. |
| `GuildScheduledEvents` | NEVER | Cron belongs in Para-RAID, not uxie. |
| `AutoModerationConfiguration` / `AutoModerationExecution` | NEVER | uxie's User plane explicitly excludes moderation tooling — SUP-§3 boundary. |
| `MessageContent` (deprecated `GuildBans`/`GuildEmojisAndStickers`) | NEVER | Deprecated; use the new names if ever needed. |

**`Partials` enum**

| Member | Verdict | Why |
|---|---|---|
| `Channel` | USE NOW | `#inbox` may dispatch a partial. |
| `Message` | USE NOW | Same. |
| `User` / `GuildMember` / `ThreadMember` | USE LATER | v1.5 multi-user / threads-as-conversations may dispatch partials. |
| `Reaction` | USE LATER | Required if `GuildMessageReactions` is enabled and a reaction arrives uncached. |
| `Poll` / `PollAnswer` | USE LATER | Companion to `Poll` class — see misc table. |
| `GuildScheduledEvent` / `SoundboardSound` | NEVER | Out of scope. |

**`Events` enum** — only events uxie listens for

| Member | Verdict | Why |
|---|---|---|
| `ClientReady` (`"clientReady"`) | USE NOW | Boot signal. **String value differs from v14's `"ready"`** — discord.js v14.26 already exposes this constant; subscribing via `Events.ClientReady` is forward-compatible with v15. *Do not* subscribe with the literal `"ready"`. |
| `InteractionCreate` | USE NOW | Slash command + autocomplete (later) + modal (later) router. |
| `MessageCreate` | USE NOW | `#inbox` capture. |
| `Error` | USE NOW | Top-level catch site §14.2 of guidelines. |
| `Warn` | USE NOW | Log to journald. |
| `Debug` | USE LATER | Only when chasing a gateway bug. Off by default. |
| `ShardError` / `ShardReady` / `ShardReconnecting` / `ShardResume` / `ShardDisconnect` | NEVER | Single-shard, and **all five are removed in v15**. Listen on `Client#ws` (now, then `Client#ping` in v15). |
| `WebhooksUpdate` | NEVER | We don't manage webhooks. (Note the v15 string rename `webhookUpdate` → `webhooksUpdate`.) |
| `GuildAuditLogEntryCreate` | NEVER | Audit-log telemetry is Ops-plane (Para-RAID), not uxie. Pairs with the `GuildAuditLogs` verdict. |
| `MessageReactionAdd` / `Remove` / `RemoveAll` / `RemoveEmoji` | USE LATER | Reaction-as-UX is a v1.5 candidate. |
| `MessageUpdate` / `MessageDelete` / `MessageDeleteBulk` | NEVER | Inbox capture is fire-and-forget; don't chase edits. |
| `ThreadCreate` / `ThreadUpdate` / `ThreadDelete` / `ThreadListSync` / `ThreadMember*` | USE LATER | Threads-as-conversations (v1.5). |
| `GuildMemberAdd` / `GuildMemberUpdate` / `GuildMemberRemove` / `GuildMemberAvailable` / `GuildMembersChunk` | USE LATER | v1.5 multi-user: onboarding for new humans, role-change reactions. Requires `GuildMembers` intent. |
| `GuildRoleCreate` / `GuildRoleUpdate` / `GuildRoleDelete` | USE LATER | v1.5 role-gated commands rebuild their permission map on these. |
| `GuildBanAdd` / `GuildBanRemove` | USE LATER | v1.5 light moderation surfaces (an ops command may need to react). |
| `ApplicationCommandPermissionsUpdate` | USE LATER | v1.5 if we use Discord-side per-command permission overrides. |
| `Typing*`, `Presence*`, `VoiceState*`, `VoiceServerUpdate`, `VoiceChannelEffectSend`, `Soundboard*`, `StageInstance*`, `GuildScheduledEvent*`, `AutoModeration*`, `Invite*`, `Sticker*`, `Emoji*`, `EntitlementCreate/Delete/Update`, `GuildIntegrationsUpdate` | NEVER | None map to uxie's surface even at v1.5. Voice/stage are Bun-blocked; AutoMod is plane-excluded; entitlements/stickers/scheduled-events are out of scope. |
| `Raw` | NEVER | We never parse raw gateway payloads. |
| `CacheSweep` | NEVER | Stateless. |

#### Slash command builders & interactions

| Symbol | Kind | Verdict | Why | uxie touchpoint |
|---|---|---|---|---|
| `SlashCommandBuilder` | Class | USE NOW | Build all six v1 commands. | `commands/*/builder` |
| `SlashCommandSubcommandBuilder` | Class | USE NOW | If we group, e.g., `/scrypt search`. | `commands/scrypt/*` |
| `SlashCommandSubcommandGroupBuilder` | Class | USE LATER | Only when surface grows beyond ~6 subcommands. |
| `SlashCommandStringOption` | Class | USE NOW | `/capture text`, `/search query`. | `commands/*` |
| `SlashCommand{Integer,Number,Boolean,User,Role,Channel,Mentionable,Attachment}Option` | Class | varies | `Boolean` USE NOW (toggle flags), `Attachment` USE NOW (`/capture` files), the rest USE LATER. | `commands/*` |
| `SlashCommandBuilder#setContexts([InteractionContextType.Guild])` | Fn | USE NOW | Owner-only, in-guild-only commands. v15-safe replacement for `setDMPermission`. | `commands/*` |
| `SlashCommandBuilder#setIntegrationTypes([ApplicationIntegrationType.GuildInstall])` | Fn | USE NOW | Guild-install only; never user-install. | `commands/*` |
| `SlashCommandBuilder#setDefaultMemberPermissions` | Fn | USE LATER | v1.5 multi-user: Discord-side coarse permission gate ("only roles with `ManageGuild` see `/sup rebuild`") layered on top of in-code gating. v1 still owner-gates in code. |
| `SlashCommandBuilder#setDMPermission` | Fn | NEVER | Deprecated; **removed in v15**. Use `setContexts` now. |
| `SlashCommandBuilder#setDefaultPermission` | Fn | NEVER | Long-deprecated. |
| `SlashCommandBuilder#setNSFW` | Fn | NEVER | Personal vault tooling; irrelevant. |
| `SlashCommandBuilder#setNameLocalizations` / `setDescriptionLocalizations` | Fn | NEVER | Single user, single locale. |
| `ContextMenuCommandBuilder` | Class | USE LATER | "Capture this message" right-click on `#inbox` — natural v1.5 UX. |
| `ApplicationCommandType` | Enum | USE LATER | Companion to context-menu builder. |
| `ChatInputCommandInteraction` | Class | USE NOW | The runtime payload for every command. | `commands/*/execute` |
| `ChatInputCommandInteraction#options` | `CommandInteractionOptionResolver` | USE NOW | Read user input. | `commands/*` |
| `ChatInputCommandInteraction#deferReply({ flags: MessageFlags.Ephemeral })` | Fn | USE NOW | Hard requirement: every handler that touches Scrypt MUST defer within 3s (guidelines §7). | `commands/*` |
| `ChatInputCommandInteraction#editReply` | Fn | USE NOW | Standard reply path post-defer. | `commands/*` |
| `ChatInputCommandInteraction#reply` | Fn | USE NOW | Only for `/ping` and other <3s replies. | `commands/ping.ts` |
| `ChatInputCommandInteraction#followUp` | Fn | USE LATER | Multi-step `/brief` or `/ask` could append followups. v1 single-reply only. |
| `ChatInputCommandInteraction#deleteReply` / `fetchReply` | Fn | USE LATER | v15 pivots to `withResponse` for `fetchReply`; bind only when we need it. |
| `ChatInputCommandInteraction#showModal` | Fn | USE LATER | v1.5 `/journal` modal. |
| `ChatInputCommandInteraction#awaitModalSubmit` | Fn | USE LATER | Companion to `showModal`. |
| `ChatInputCommandInteraction#sendPremiumRequired` | Fn | NEVER | **Removed in v15**; Discord killed `PREMIUM_REQUIRED`. Even if we monetized (we won't — single user), use a premium-style button. |
| `ChatInputCommandInteraction#launchActivity` | Fn | NEVER | Activities are not in scope; SUP plane mismatch. |
| `ChatInputCommandInteraction#isXxx` typeguards | Fn | USE NOW | Used inside the central interaction router to narrow type. | `bot/router.ts` |
| `ChatInputCommandInteraction#isAnySelectMenu` | Fn | NEVER | **Removed in v15** (use `isSelectMenu`). Don't bind. |
| `BaseInteraction` | Class | USE NOW | Type for the central router and `requireOwner(i)`. | `bot/router.ts`, `lib/auth.ts` |
| `CommandInteraction` | Class | USE NOW | Parent of ChatInput/ContextMenu — accept either at the router. | `bot/router.ts` |
| `MessageContextMenuCommandInteraction` / `UserContextMenuCommandInteraction` | Class | USE LATER | Companions to context-menu commands (v1.5). |
| `AutocompleteInteraction` | Class | USE LATER | `/search` autocomplete from MCP `searchNotes`. v1.5. | `commands/search/autocomplete.ts` (later) |
| `AutocompleteInteraction#respond` | Fn | USE LATER | The only response method on autocomplete. |
| `ModalBuilder` / `TextInputBuilder` / `TextInputStyle` | Class/Enum | USE LATER | Modal for `/journal`. v1.5. |
| `ModalSubmitInteraction` | Class | USE LATER | Same. |
| `ModalSubmitFields` | Class | USE LATER | `.getTextInputValue('field')` ergonomics. |

#### Message-output builders

| Symbol | Kind | Verdict | Why | uxie touchpoint |
|---|---|---|---|---|
| `EmbedBuilder` | Class | USE NOW | **Primary v1 output.** Title 256 / desc 4096 / 25 fields / 6000 total — fits ~95% of slash command results. | `lib/embed.ts` |
| `EmbedBuilder#setColor`, `setTitle`, `setDescription`, `setFields`, `setFooter`, `setTimestamp`, `setURL` | Fn | USE NOW | Standard fluent setters used in the embed factory. | `lib/embed.ts` |
| `EmbedAuthorOptions` / `EmbedFooterOptions` / `EmbedFieldOptions` | Iface | USE NOW | Type signatures of the factory. | `lib/embed.ts` |
| `AttachmentBuilder` | Class | USE NOW | Output >1500 chars → attach `.md` per guidelines §8 / research §6. | `lib/attachment.ts` |
| `AttachmentBuilder#setName` / `setDescription` / `setSpoiler` | Fn | USE NOW | All used. | `lib/attachment.ts` |
| `ContainerBuilder` | Class | USE LATER | Components V2 upgrade path for `/brief` (multi-section daily summary). Mutually exclusive with classic embeds in same message. | `lib/components-v2.ts` (later) |
| `SectionBuilder` | Class | USE LATER | V2 building block. |
| `TextDisplayBuilder` | Class | USE LATER | V2 markdown pane; replaces `Embed#description`. |
| `SeparatorBuilder` | Class | USE LATER | V2 visual divider. |
| `MediaGalleryBuilder` / `MediaGalleryItemBuilder` | Class | USE LATER | Multi-image attachment galleries; not v1. |
| `FileBuilder` | Class | USE LATER | V2 attachment representation; we use `AttachmentBuilder` with classic embeds in v1. |
| `ThumbnailBuilder` | Class | USE LATER | Section accessory. |
| `ActionRowBuilder` | Class | USE LATER | First row appears with `/ask` retry buttons or `/brief` "open in Scrypt" link. |
| `ButtonBuilder` | Class | USE LATER | Same. v1 has no buttons. |
| `ButtonStyle` | Enum | USE LATER | Companion. **`Premium` style — NEVER**, single-user bot. |
| `StringSelectMenuBuilder` / `StringSelectMenuOptionBuilder` | Class | USE LATER | If `/search` ever returns a picker. v1.5+. |
| `UserSelectMenuBuilder` / `RoleSelectMenuBuilder` / `MentionableSelectMenuBuilder` / `ChannelSelectMenuBuilder` | Class | USE LATER | v1.5 multi-user: a `/share` or `/notify` command might pick a user/role audience. v1 single-user has nobody to select. |
| `MessageFlags.Ephemeral` (= 64) | Enum | USE NOW | **Default for every reply** (guidelines §8). | `lib/embed.ts` |
| `MessageFlags.IsComponentsV2` (= 32768) | Enum | USE LATER | Required when sending a Components V2 payload. |
| `MessageFlags.SuppressEmbeds` / `SuppressNotifications` | Enum | USE LATER | `SuppressNotifications` is a thoughtful default for `/brief` to avoid a ping; revisit. |
| `MessageFlags.{Crossposted, IsCrosspost, HasThread, IsVoiceMessage, ShouldShowLinkNotDiscordWarning, FailedToMentionSomeRolesInThread, HasSnapshot, …}` | Enum | NEVER | None align with our usage. |

> **Embed vs Container choice:** v1 uses **EmbedBuilder + MessageFlags.Ephemeral** for every reply. ContainerBuilder is the upgrade path the moment a single command's output exceeds the 4096-char description limit or wants progressive disclosure (sections + buttons). Discord forbids mixing them in one message — pick per command, not per project.

#### Permissions, contexts, integration types

| Symbol | Kind | Verdict | Why | uxie touchpoint |
|---|---|---|---|---|
| `PermissionFlagsBits` | Var (BigInt map) | USE LATER | v1.5 multi-user: build the bitmask passed to `setDefaultMemberPermissions` for role-gated commands. | `commands/*/builder` (later) |
| `PermissionsBitField` | Class | USE LATER | v1.5 multi-user: query `member.permissions.has(PermissionFlagsBits.X)` inside guard logic. | `lib/auth.ts` (later) |
| `InteractionContextType` | Enum | USE NOW | `setContexts([Guild])` — guild-only. v15-safe. | `commands/*/builder` |
| `ApplicationIntegrationType` | Enum | USE NOW | `setIntegrationTypes([GuildInstall])` — never user-install. | `commands/*/builder` |
| `ApplicationCommandType` | Enum | USE LATER | For context-menu commands. |
| `ApplicationCommandOptionType` | Enum | USE NOW | Internal to builders; exported in case you build raw JSON. |

#### Channels / messages / reactions

| Symbol | Kind | Verdict | Why | uxie touchpoint |
|---|---|---|---|---|
| `Message` | Class | USE NOW | The `#inbox` payload. | `events/messageCreate.ts` |
| `Message#author`, `#channel`, `#channelId`, `#content`, `#attachments`, `#id`, `#react`, `#url` | Fn/Prop | USE NOW | All used in inbox flow. | `events/messageCreate.ts` |
| `Message#interaction` | Prop | NEVER | **Deprecated in 14.16.2, removed in v15**; use `Message#interactionMetadata`. We don't read it anyway. |
| `Message#interactionMetadata` | Prop | USE LATER | Needed only if we display a thread starter that originated from a slash command. |
| `Message#startThread` | Fn | USE LATER | Threads-as-conversations (guidelines §10). |
| `Message#edit` / `#delete` / `#suppressEmbeds` / `#crosspost` / `#forward` / `#removeAttachments` | Fn | NEVER | Inbox is fire-and-forget. We don't mutate user messages. |
| `Message#reply` | Fn | NEVER | We acknowledge with a reaction, not a reply. |
| `Message#pin` / `#unpin` | Fn | NEVER | Out of scope. |
| `Message#fetchWebhook` / `#fetchReference` / `#poll` | Fn | NEVER | Not used. |
| `Message#createMessageComponentCollector` / `#awaitMessageComponent` / `#awaitReactions` | Fn | USE LATER | Reaction-driven UX (v1.5+). |
| `MessageReaction` | Class | USE LATER | Only if we listen for reactions. |
| `MessageReaction#react` | Fn | USE NOW | Inbox ✅/❌ ack. | `events/messageCreate.ts` |
| `Channel` (`BaseChannel`) family | Class | USE NOW | Channel resolution at boot for inbox. | `bot/client.ts` |
| `TextChannel` | Class | USE NOW | The `#inbox` channel type. | `events/messageCreate.ts` |
| `DMChannel` | Class | USE LATER | v1.5 if DMs land. |
| `ThreadChannel` | Class | USE LATER | Threads-as-conversations. |
| `ThreadChannel#send` / `#join` / `#leave` / `#setArchived` / `#fetchStarterMessage` | Fn | USE LATER | Same. |
| `ForumChannel` | Class | NEVER | Out of scope; user-vault is single-text-channel. |
| `AnnouncementChannel` (formerly `NewsChannel`) | Class | NEVER | Not used. v15 renames `NewsChannel` → `AnnouncementChannel`; if you ever bind, bind to the new name. |
| `VoiceChannel` / `StageChannel` / `MediaChannel` / `CategoryChannel` / `DirectoryChannel` | Class | NEVER | Out of scope. |
| `ChannelType` | Enum | USE NOW | Narrow channel type in `messageCreate`. | `events/messageCreate.ts` |

#### Sharding, gateway, REST

| Symbol | Kind | Verdict | Why | uxie touchpoint |
|---|---|---|---|---|
| `ShardingManager` | Class | NEVER | Single guild — sharding triggers at 2,500 guilds (Discord-mandated). Skip. | — |
| `ShardClientUtil` | Class | NEVER | Companion. | — |
| `Shard` | Class | NEVER | Same. | — |
| `WebSocketManager` | Class | USE LATER | Read `ws.ping` for `/ping`. v15 moves to `Client#ping`. | `commands/ping.ts` |
| `WebSocketShard` | Class | NEVER | Internal. | — |
| `Status` | Enum | USE LATER | Surface gateway state in `/ping` — "connected/identifying/resuming". | `commands/ping.ts` |
| `REST` (re-exported) | Class | USE NOW | Command registration uses `new REST().setToken(token).put(Routes.applicationGuildCommands(...))`. | `scripts/register-commands.ts` |
| `REST#setToken`, `#put`, `#post`, `#get` | Fn | USE NOW | Above. | `scripts/register-commands.ts` |
| `REST#queueRequest` | Fn | NEVER | Internal escape hatch; standard verbs are enough. |
| `Routes` | Var (re-export of discord-api-types) | USE NOW | `Routes.applicationGuildCommands(appId, guildId)` for registration. | `scripts/register-commands.ts` |
| `RateLimitData` | Iface | USE LATER | Pretty-print incoming rate limits to logs (`pino`). Not in v1's "three catch sites" but a useful event listener at boot. | `bot/client.ts` (later) |
| `RESTEvents` | Enum | USE LATER | Only `RateLimited` and `InvalidRequestWarning`; the latter is critical because the 10k-bad-requests/10min window can ban us. | `bot/client.ts` (later) |
| `DiscordAPIError` / `DiscordjsError` / `HTTPError` | Class | USE NOW | Catch and map in the error router (guidelines §14.1 — `DiscordError`). | `lib/errors.ts` |

#### Caching, sweepers, options helpers

| Symbol | Kind | Verdict | Why | uxie touchpoint |
|---|---|---|---|---|
| `Sweepers` | Class | NEVER | Stateless. Don't run sweepers we don't need. | — |
| `Options` | Var (helper) | NEVER | `Options.cacheWithLimits` / `Options.DefaultMakeCacheSettings` — we use defaults. | — |
| `LimitedCollection` | Class | NEVER | Same reason. |
| `Collection` | Class | USE NOW | discord.js managers expose Collections. We read from `client.guilds`/`client.channels`. Don't construct our own. | `bot/client.ts` |

#### Misc symbols a developer might reach for

| Symbol | Kind | Verdict | Why | uxie touchpoint |
|---|---|---|---|---|
| `Constants` | Var | NEVER | Most of its members are gone in v15; use named enums. |
| `Util` (functions like `parseEmoji`, `cleanContent`, `escapeMarkdown`) | Var | USE LATER | Only if we sanitize user content in `/ask` outputs. v1 just forwards raw. |
| `time(date, style)`, `bold`, `italic`, `code`, `codeBlock`, `inlineCode`, `quote`, `blockQuote`, `hyperlink`, `subtext`, `userMention`, `channelMention`, `roleMention`, `formatEmoji` (re-exports of `@discordjs/formatters`) | Fn | USE NOW | Replies use `time(scrypt.lastSyncedAt, 'R')` for relative timestamps; `codeBlock` for note IDs. | `lib/embed.ts` |
| `parseWebhookURL` | Fn | NEVER | We don't ingest webhooks. |
| `WebhookClient` | Class | NEVER | Same. |
| `Activity` / `ActivityType` | Class/Enum | USE LATER | Bot presence ("Listening to scrypt"). v1.5. |
| `Collector` (`MessageCollector`, `ReactionCollector`, `InteractionCollector`) | Class | USE LATER | Components V2 button handling. v15 makes Collector `AsyncEventEmitter`-based — listeners may be awaited; safe upgrade. |
| `BaseManager` / `CachedManager` / individual managers (`GuildManager`, `ChannelManager`, `MessageManager`, etc.) | Class | USE LATER | Read-only; we use `client.channels.fetch(id)` once at boot. Don't bypass via `cache.get` (might be empty under stateless intent set). |
| `ApplicationCommandManager` / `GuildApplicationCommandManager` | Class | USE LATER | We register via REST, not these managers. v15 changes `fetch()` signature; bind cautiously. |
| `GuildMemberManager` / `RoleManager` | Class | USE LATER | v1.5 multi-user: roster lookups, role-by-name resolution for permission maps. |
| `Guild` / `GuildMember` / `Role` | Class | USE LATER | v1.5 multi-user: every guard that checks "is this user permitted" walks `member.roles.cache` / `permissions`. |
| `GuildMember#permissions`, `#roles` | Fn/Prop | USE LATER | v1.5 multi-user guard reads — "does this member have role X". |
| `GuildMember#kick` / `#ban` / `#timeout` | Fn | NEVER | Moderation is not uxie's plane at any horizon. uxie is User-plane translation; server discipline is a separate-bot decision, not a deferred feature. |
| `User` | Class | USE NOW | `i.user.id` for the owner check. | `lib/auth.ts` |
| `GuildAuditLogs` / `GuildAuditLogsEntry` | Class | NEVER | Audit-log reads are Discord-side moderation telemetry — Ops-plane in spirit. Para-RAID owns ops observability; uxie shouldn't echo Discord's audit data. |
| `Invite` / `GuildPreview` / `GuildTemplate` / `Widget` / `OAuth2Guild` | Class | NEVER | Out of scope at every horizon. |
| `Webhook` / `WebhookClient` / `WebhookFetchMessageOptions` | Class/Iface | NEVER | We don't operate webhooks; ingress is gateway-only. |
| `Entitlement` / `SKU` / `Subscription` | Class | NEVER | No monetization at any horizon. |
| `Poll` / `PollAnswer` | Class | USE LATER | v1.5 multi-user: a `/journal poll` ("how was today?" mood capture) is a natural shared-guild feature. v1 has no audience to poll. |
| `StageInstance` / `Soundboard` | Class | NEVER | Voice/stage stack is Bun-blocked. |
| `GuildScheduledEvent` | Class | NEVER | Cron belongs in Para-RAID, not uxie. |
| `AutoModerationRule` / `AutoModerationActionExecution` | Class | NEVER | uxie's User plane explicitly excludes moderation rule authoring (SUP-§3). Reading audit-log entries is fine; authoring rules is not. |
| `Sticker` / `StickerPack` | Class | NEVER | Out of scope. |
| `Emoji` / `GuildEmoji` / `ApplicationEmoji` / `ReactionEmoji` | Class | USE LATER | Custom inbox-ack emoji once we leave the unicode ✅/❌ era; v1.5 reaction-UX. |
| `BaseSelectMenuComponent` and concrete select menu *components* (vs *builders*) | Class | USE LATER | Read-only. We touch them only when a v1.5 select-menu interaction returns. |
| `LaunchActivity` types | varies | NEVER | Activities not in scope. |

---

### §2.2 `@discordjs/builders`

discord.js re-exports everything from `builders` directly — uxie should import builders **from `discord.js`**, not from the subpackage, to avoid version drift. The subpackage is what `discord.js` pulls transitively.

| Symbol | Kind | Verdict | Why | uxie touchpoint |
|---|---|---|---|---|
| `SlashCommandBuilder` (mirror) | Class | USE NOW | Same as §2.1. | `commands/*/builder` |
| `ContextMenuCommandBuilder` (mirror) | Class | USE LATER | v1.5. |
| `EmbedBuilder` (mirror) | Class | USE NOW | Re-export. | `lib/embed.ts` |
| `ContainerBuilder`, `SectionBuilder`, `TextDisplayBuilder`, `SeparatorBuilder`, `MediaGalleryBuilder`, `FileBuilder`, `ThumbnailBuilder`, `MediaGalleryItemBuilder` (mirrors) | Class | USE LATER | Components V2 upgrade. |
| `ActionRowBuilder`, `ButtonBuilder`, `StringSelectMenuBuilder`, `StringSelectMenuOptionBuilder`, `*SelectMenuBuilder` family (mirrors) | Class | USE LATER | Buttons/selects = v1.5+. |
| `ModalBuilder`, `TextInputBuilder` (mirrors) | Class | USE LATER | v1.5. |
| `chatInputApplicationCommandMention()` | Fn | USE NOW | Format `</search:id>` mentions in help text. | `lib/embed.ts` |
| `userMention`, `channelMention`, `roleMention`, etc. (mirrors of formatters) | Fn | USE NOW | Same as §2.1. | `lib/embed.ts` |
| `inlineCode`, `codeBlock`, `bold`, `italic`, `underline`, `strikethrough`, `quote`, `blockQuote`, `subtext`, `heading`, `hyperlink`, `time`, `formatEmoji` | Fn | USE NOW | Markdown helpers. | `lib/embed.ts` |
| `EmbedAssertions`, `validation`, `embedLength` | Var/Fn | NEVER | Internal. |
| Localization helpers (`Locale`, etc.) | Var | NEVER | Single locale. |

---

### §2.3 `@discordjs/rest`

discord.js exposes the same `REST` class. Do not install `@discordjs/rest` separately — let discord.js own the version.

| Symbol | Kind | Verdict | Why | uxie touchpoint |
|---|---|---|---|---|
| `REST` | Class | USE NOW | Command registration script. | `scripts/register-commands.ts` |
| `REST#setToken`, `#put`, `#post`, `#get`, `#patch`, `#delete` | Fn | USE NOW (`put`, `setToken`) / USE LATER (others) | Registration is a single `put`. | `scripts/register-commands.ts` |
| `REST#agent`, `#setAgent` | Fn | USE LATER | Plug an Undici Agent for Tailscale only if registration ever needs to traverse it (it doesn't — Discord is on the public internet). | — |
| `REST#globalRemaining`, `#globalReset`, `#globalDelay`, `#hashes`, `#handlers` | Prop | NEVER | Internal observability. Use `RESTEvents.RateLimited` instead. |
| `REST#cdn` (`CDN` class) | Class | USE LATER | Building an avatar URL for `/ping` cosmetics; cosmetic. | — |
| `RESTOptions` | Iface | USE LATER | Customize UA / version / authPrefix. v1 default. |
| `RESTEvents.RateLimited`, `.InvalidRequestWarning`, `.HashSweep`, `.HandlerSweep`, `.Response`, `.Restart` | Enum | USE LATER (RateLimited, InvalidRequestWarning), NEVER (others) | Subscribe to these once we have observability. The InvalidRequestWarning is critical (10k bad/10min → token ban). | `bot/client.ts` (later) |
| `RateLimitData` | Iface | USE LATER | Logging. |
| `RequestMethod` | Enum | NEVER | Internal. |
| `parseResponse` | Fn | NEVER | Internal. |
| `DefaultRestOptions` / `DefaultUserAgent` / `OAuthErrorData` / `RESTPostAPIChannelMessageJSONBody` (re-exports) | Var/Iface | NEVER | Use the named symbols. |

---

### §2.4 `@discordjs/ws`

| Symbol | Kind | Verdict | Why | uxie touchpoint |
|---|---|---|---|---|
| `WebSocketManager` (subpackage) | Class | NEVER | discord.js's `Client` owns its own gateway. Only `@discordjs/core` users construct this. | — |
| `WebSocketShard` | Class | NEVER | Same. |
| `WebSocketShardEvents` | Enum | NEVER | Subscribe via `Client#ws` instead. |
| `CompressionMethod.ZlibSync` / `.ZlibStream` | Enum | NEVER | `zlib-sync` is on the forbidden list (research §11). Don't enable WS compression for v1. |
| `IdentifyThrottler` / `SimpleIdentifyThrottler` / `IShardingStrategy` / `IContextFetchingStrategy` | Class/Iface | NEVER | Multi-shard infra. |

---

### §2.5 `@discordjs/voice`

| Symbol | Kind | Verdict | Why | uxie touchpoint |
|---|---|---|---|---|
| **All exports** (`joinVoiceChannel`, `createAudioPlayer`, `createAudioResource`, `VoiceConnection`, `AudioPlayer`, `entersState`, `getVoiceConnection`, `StreamType`, `EndBehaviorType`, opus/sodium dependencies) | All | NEVER | Bun + `@discordjs/voice` is broken (`oven-sh/bun#11313`); guidelines §3 is explicit. Never install `@discordjs/voice`, never reach for these. If voice ever becomes a feature, that's a Bun-or-not decision first. | — |

---

### §2.6 `@discordjs/util`

Tiny utility package. All re-exported via discord.js when relevant.

| Symbol | Kind | Verdict | Why | uxie touchpoint |
|---|---|---|---|---|
| `lazy(callback)` | Fn | USE LATER | Lazy initialization helper. We use module-singleton pattern instead. |
| `isJSONEncodable`, `JSONEncodable` | Fn/Iface | NEVER | Internal. |
| `range`, `shouldUseGlobalFetchAndWebSocket`, `calculateShardId` | Fn | NEVER | Edge-runtime only / sharding only. |
| `DiscordSnowflake.timestampFrom` (via `@sapphire/snowflake`, transitively) | Fn | USE LATER | Decode message IDs into timestamps for log traces. |

---

### §2.7 `@discordjs/collection`

| Symbol | Kind | Verdict | Why | uxie touchpoint |
|---|---|---|---|---|
| `Collection` | Class | USE NOW | We **consume** these from discord.js managers; do not construct our own. Importantly: `cache.get(id)` returns `undefined` under our stateless intent set unless `fetch`'d. | `bot/client.ts` |
| `Collection#first`, `#last`, `#find`, `#filter`, `#map`, `#reduce`, `#sort`, `#random` | Fn | USE LATER | Only if a command iterates (e.g., `/journal list`, post-v1). |
| `LimitedCollection` | Class | NEVER | Stateless. |

---

### §2.8 `@discordjs/core`

> "Thin wrapper around REST + gateway." Pairs with `@discordjs/rest` + `@discordjs/ws`. It is **the alternative architecture** to discord.js's `Client` — lower-level, no caching, no managers, you compose your own state model.

**Stance:** locked on discord.js's `Client` with `discord.js@^14.26 → ^15` as the migration target. `@discordjs/core` is a parallel low-level stack; adopting it means rewriting from scratch. If we ever reconsider, that's a fresh design decision, not a deferred one — keeping it on the maybe list is just noise.

| Symbol | Kind | Verdict | Why | uxie touchpoint |
|---|---|---|---|---|
| `Client` (core's) | Class | NEVER | Parallel stack to discord.js's `Client`; adopting it is a from-scratch rewrite, not a migration. v15 (mainline) is our target, not core. | — |
| `API` (core's API namespace) | Class | NEVER | Companion to core's `Client`. |
| `GatewayDispatchEvents`, `InteractionType`, `MessageFlags`, etc. (re-exports of discord-api-types) | Enum | NEVER (from this package) | Import from `discord-api-types/v10` directly if needed. |

---

### §2.9 `@discordjs/formatters`

discord.js re-exports the entire surface. **Use the discord.js root re-exports** to keep imports tidy.

| Symbol | Kind | Verdict | Why | uxie touchpoint |
|---|---|---|---|---|
| `bold`, `italic`, `underline`, `strikethrough`, `spoiler` | Fn | USE NOW (`bold`, `italic`); USE LATER (rest) | Headings in embed descriptions. | `lib/embed.ts` |
| `inlineCode`, `codeBlock` | Fn | USE NOW | Note IDs and short snippets. | `lib/embed.ts` |
| `quote`, `blockQuote`, `subtext`, `heading` | Fn | USE NOW | Layout. `subtext` is great for muted footnote-style metadata. | `lib/embed.ts` |
| `hyperlink` | Fn | USE NOW | "Open in Scrypt" link. | `lib/embed.ts` |
| `time(date, style)` | Fn | USE NOW | Relative-time stamps for "last synced" UX. | `lib/embed.ts` |
| `userMention`, `channelMention`, `roleMention`, `chatInputApplicationCommandMention`, `formatEmoji` | Fn | USE NOW (channelMention, chatInput-mention); USE LATER (rest) | Help text, error messages. | `lib/embed.ts`, `lib/errors.ts` |
| `escapeMarkdown`, `escapeBold`, `escapeItalic`, `escapeCodeBlock`, etc. | Fn | USE LATER | Sanitize user content if we ever echo it back. v1 forwards raw to Scrypt. |
| `messageLink` | Fn | USE NOW | "Captured from `<link>`" in `#inbox` ack later. | `events/messageCreate.ts` |
| `TimestampStyles`, `Faces` | Enum | USE NOW (`TimestampStyles`) | Companion to `time()`. | `lib/embed.ts` |

---

### §2.10 `@discordjs/brokers`

| Symbol | Kind | Verdict | Why | uxie touchpoint |
|---|---|---|---|---|
| `PubSubRedisBroker`, `RPCRedisBroker` | Class | NEVER | Multi-process gateway-event distribution. Stateless rule §15 ("no queue") plus single-Bun-process architecture. v1.5 multi-user inside one guild does not trigger this; only far-future multi-tenant SaaS would, and that's not on the roadmap. | — |
| `IBaseBroker`, `IPubSubBroker`, `IRPCBroker` | Iface | NEVER | Same. |

---

### §2.11 `@discordjs/proxy`

| Symbol | Kind | Verdict | Why | uxie touchpoint |
|---|---|---|---|---|
| `populateGeneralRoute`, `proxyRequests` | Fn | NEVER | HTTP proxy in front of Discord's API for shared rate-limit pools across many processes. Single-process bot doesn't need it at v1, v1.5, or far-future. | — |

---

### §2.12 `@discordjs/next`

> Pre-release / experimental successor stack. discord.js v15 itself is unstable; `next` is more so.

| Symbol | Kind | Verdict | Why | uxie touchpoint |
|---|---|---|---|---|
| **Everything** | All | NEVER | Migration target is **discord.js v15** (the stable line), not `@discordjs/next` (the experimental fork). Adopting `next` would create a fork-vs-mainline migration debt against our explicit v15 commitment. Watch its README for whether it gets folded back into discord.js v16+. | — |

---

## §3. v15 readiness matrix

uxie pins to `discord.js@^14.26`. Below is every v15 break that touches a symbol we use in v1, with the migration shape and effort estimate. Source: <https://discordjs.guide/v15>, the discord.js CHANGELOG, and the v14.26 typings.

| v14 symbol | v15 change | Migration shape | Effort | uxie touchpoint impact |
|---|---|---|---|---|
| `Events.ClientReady` string `"ready"` | Now `"clientReady"` | If you used `Events.ClientReady`, no change. If you ever wrote `client.on("ready", ...)`, swap to `client.on(Events.ClientReady, ...)`. | S | `bot/client.ts` — uses the constant; no change needed. |
| `Events.WebhooksUpdate` string `"webhookUpdate"` | Now `"webhooksUpdate"` | Same — constant is forward-compatible. | S | None; we don't subscribe. |
| `Events.ShardError`/`ShardReady`/`ShardReconnecting`/`ShardResume`/`shardDisconnect` | Removed entirely | Subscribe on `Client#ws` (which delegates to `WebSocketManager`) for the surviving shard events. | S | We don't subscribe — none. |
| `Client#emojis` | Removed | Use `resolveGuildEmoji()` utility. | S | We don't use `emojis`; none. |
| `Client#ws.ping` | `Client#ping` (new), can be `null` until first heartbeat | Replace `client.ws.ping` with `client.ping ?? -1`. | S | `commands/ping.ts` — one line. |
| `Client#fetchPremiumStickerPacks()` | Removed | Use `Client#fetchStickerPacks()`. | S | We don't use it. |
| `ClientOptions#shards` / `#shardCount` | Moved to `ClientOptions#ws.shardIds` / `ws.shardCount` | n/a — we don't set them. | S | None. |
| `ApplicationCommand#dmPermission` / `setDMPermission()` | Removed | Use `setContexts([Guild])`. | S | We already use `setContexts`. None. |
| `SlashCommandBuilder#setDMPermission` | Removed | Use `setContexts`. | S | Same. |
| `Message#interaction` | Removed | Use `Message#interactionMetadata`. | S | We don't read it. |
| `ActionRow.from()` | Removed | Use `ActionRowBuilder.from()`. | S | Not used in v1. |
| `BaseInteraction#isAnySelectMenu()` | Removed | Use `isSelectMenu()` (now matches all select menus). | S | Not used in v1. |
| `interaction.sendPremiumRequired()` | Removed | Use a premium-style button. | S | Not used and never will be. |
| `interaction.reply({ fetchReply: true })` | `fetchReply` removed | Use `withResponse: true`; access `response.resource.message`. | S | Not used in v1; `editReply` returns the message directly. |
| `interaction.reply({ ephemeral: true })` | `ephemeral` option removed | Use `flags: MessageFlags.Ephemeral`. | S–M | We **already** use `flags: MessageFlags.Ephemeral` per guidelines §8. None. |
| `NewsChannel` class | Renamed `AnnouncementChannel` | Type rename only. | S | Not used. |
| `Constants` enum bag | Many entries removed | Use the named enums directly. | S | We import named enums. |
| `Formatters.bold` etc. (legacy aggregate) | Use named functions from `@discordjs/formatters` | Already named. | S | None. |
| `BaseClient`, `Shard`, `ShardingManager`, `Collector` extend `EventEmitter` | Now extend `AsyncEventEmitter` (listeners may be async/awaited) | Listeners can `await`. **Throwing inside a listener now rejects the emitter's internal promise.** Wrap listener bodies in try/catch where needed (we already route through `bot/router.ts`'s error boundary). | M | `bot/router.ts`, `events/messageCreate.ts` — verify the error boundary handles thrown rejections, not just sync throws. |
| `ApplicationCommandManager#fetch(id, options)` | Now `fetch(idOrOptions)` (single arg) | Single-arg call site. | S | Not used (we register via REST). |
| `SelectMenuBuilder` (legacy alias) | Removed | Use `StringSelectMenuBuilder`. | S | We use the named one. |
| `Collector` event names + payloads | Some renamed | Verify if/when we adopt buttons (USE LATER). | M | v1.5+. |

**Total v15 lift for uxie's v1 codebase:** trivial. Mostly cosmetic. The one watchful item is the `AsyncEventEmitter` change — async listeners are awaited, so an unhandled rejection in a `messageCreate` handler will surface differently (we want our error router to catch *rejections*, not just sync throws).

---

## §4. Premium bot patterns we should adopt

Grouped by perf / UX / reliability. Each item names sources and the concrete uxie touchpoint.

### Performance

1. **Rely on the built-in REST queue; don't add our own.** discord.js's `REST` class auto-handles 429s using the `X-RateLimit-*` headers and `retry_after`. For a single-user bot the global 50 req/s cap is unreachable. Adding a Redis-backed broker (Mee6/Carl-bot scale) would violate stateless rule §15. Source: <https://discord.com/developers/docs/topics/rate-limits>, <https://discordjs.guide/legacy/sharding> (companion). **uxie touchpoint:** none — explicit non-action.
2. **Subscribe to `RESTEvents.InvalidRequestWarning` once.** Premium bots watch the 10k-bad-requests/10min window because a token ban is fatal at scale. For uxie it's fatal at any scale. Log a single warning to journald when the watermark is crossed. **uxie touchpoint:** `bot/client.ts` (post-v1, before public).
3. **Skip cache customization in v1.** `Options.cacheWithLimits` and `Sweepers` matter when a bot caches millions of users; uxie's intent set (`Guilds`, `GuildMessages`, `MessageContent`) keeps caches tiny. Revisit only if a memory regression surfaces. Source: <https://discordjs.guide/legacy/miscellaneous/cache-customization>. **uxie touchpoint:** none.
4. **Defer registration to a build script, not boot.** Carl-bot / Dyno register slash commands once per release, not on every start. uxie should follow the same pattern: `scripts/register-commands.ts` runs during deploy, not on `Client#login`. **uxie touchpoint:** `scripts/register-commands.ts`.

### UX

5. **Ephemeral-by-default.** ChatGPT's Discord bot, Mee6's settings panes, and Discord's own first-party docs all default sensitive output to ephemeral. Already locked in guidelines §8. Source: <https://discord.com/developers/docs/interactions/receiving-and-responding>. **uxie touchpoint:** `lib/embed.ts`.
6. **Defer with `flags: MessageFlags.Ephemeral` immediately on commands that touch Scrypt.** Discord's 3-second contract is unforgiving. The Midjourney bot defers and edits; ChatGPT's bot does the same. Already in guidelines §7. **uxie touchpoint:** `commands/*/execute`.
7. **Progressive disclosure for `/brief` (later).** Midjourney edits a single message multiple times as the image progresses; ChatGPT's Discord bot streams a "thinking…" embed and replaces it. For uxie's `/brief`, follow the same: defer → `editReply` with skeleton → `editReply` with full content. **Don't** rapid-fire `editReply` more than ~once a second; each edit is a REST call. Source: OpenAI streaming guide (<https://platform.openai.com/docs/guides/streaming-responses>) — same debounce logic translates. **uxie touchpoint:** `commands/brief/execute.ts` (when streaming lands).
8. **Attach `.md` file when output >1500 chars.** Premium bots (Probot, Pluralkit) attach files to dodge embed-length cliffs. Already in research §6. Use `AttachmentBuilder` + a one-off note in the embed pointing at the attachment. **uxie touchpoint:** `lib/attachment.ts`.
9. **Keep mobile in mind: classic embeds first.** Components V2 mobile rendering is improving but inconsistent; Mee6 and Carl-bot still ship classic embeds for 90%+ of surfaces. Already locked in guidelines §8. Source: <https://discord.com/developers/docs/components/overview>. **uxie touchpoint:** `lib/embed.ts`.

### Reliability

10. **Single error boundary at the router.** Carl-bot and Dyno both centralize. Already locked in guidelines §14.2. **uxie touchpoint:** `bot/router.ts` + `lib/errors.ts`.
11. **Acknowledge `#inbox` with a reaction, not a reply.** Probot and other capture-style bots use reactions for cheap, non-intrusive ack. Already in guidelines §9. **uxie touchpoint:** `events/messageCreate.ts`.
12. **Owner-gate every interaction first thing.** Most premium bots gate by Discord permission bits; uxie's threat model is stricter — hardcode `DISCORD_OWNER_ID` and reject anything else. Already in guidelines §17.3. **uxie touchpoint:** `lib/auth.ts`.
13. **Pin discord.js minor version, watch v15.** Dyno and Carl-bot pin tightly because gateway behavior changes mid-line. Already in guidelines §3. **uxie touchpoint:** `package.json`.
14. **Sanitize before forwarding.** Premium bots strip control sequences before persisting user input; uxie strips shell-shaped strings before forwarding to Scrypt (guidelines §9). **uxie touchpoint:** `events/messageCreate.ts`.

---

## §5. Premium bot patterns we should explicitly reject

15. **Multi-process sharding.** Mee6 / Carl-bot / Dyno shard hundreds of processes; uxie has 1 guild. Discord requires sharding at 2,500. Skip. Source: <https://discordjs.guide/legacy/sharding>. *NEVER for uxie.*
16. **Redis broker / queue between gateway and workers (`@discordjs/brokers`).** Stateless rule §15 — no queue. Failures are immediate and visible.
17. **Long-lived in-memory caches of vault content.** Anti-pattern §22 of guidelines.
18. **Public-bot mode / install discoverability.** SUP plane breach. We never publish, never go on bot lists.
19. **Rapid-fire `editReply` for streaming.** Premium-AI bots that stream every token to Discord burn rate limits and shred the UX. Debounce ≥1s, or use a single placeholder + final edit.
20. **Premium-required popup (`sendPremiumRequired()`).** Removed in v15; even if it existed, single-user.
21. **`MessageContent` on a public bot without privileged-intent approval.** Free for unverified bots <100 guilds; once we'd cross that, we'd need approval. Not a concern at v1, but an explicit "we will never go public" guardrail.
22. **Cooldowns / throttling logic in code.** Single-user. The Discord-side rate-limit is the only relevant ceiling.
23. **Deeply nested Components V2 trees with 5+ ActionRows.** Carl-bot's complex permission UI is gorgeous on desktop and miserable on mobile. Cap at one ContainerBuilder with ≤2 ActionRows when we adopt V2.
24. **Listening to every gateway event "for completeness."** Each adds CPU cost, intent surface, and cache pressure. Subscribe to exactly what we need.
25. **Auto-reconnect retries with custom backoff.** discord.js's gateway does this correctly; reimplementing is how you cause your own ban.

---

## §6. Three lists for fast scanning

> **Note on the v15-removed surface.** Symbols Discord/discord.js removed or deprecated on the v15 path stay in NEVER_USE even though our migration target *is* v15. Adopting them now means writing code we have to delete on the migration. The v15 commitment is what makes them NEVER, not what would make them USE LATER.

### WILL_USE (v1)

```
Client                        — single bot process boot
Client#login                  — boot
Client#destroy                — graceful shutdown
Client#isReady                — /ping check
Client#options.allowedMentions — silence @-pings on ephemeral output
Client#options.partials       — Channel + Message for #inbox
Client#user                   — bot identity in /ping
Client#guilds                 — resolve owner guild on boot
Client#channels               — resolve INBOX_CHANNEL_ID on boot
Client#rest                   — used for command registration script
Client#ws                     — read ws.ping for /ping
ClientOptions                 — construction shape
GatewayIntentBits.Guilds      — interactionCreate
GatewayIntentBits.GuildMessages — messageCreate in #inbox
GatewayIntentBits.MessageContent — read inbox body
Partials.Channel              — #inbox can dispatch partial
Partials.Message              — same
Events.ClientReady            — boot signal (v15-safe constant)
Events.InteractionCreate      — slash router
Events.MessageCreate          — #inbox capture
Events.Error / Events.Warn    — top-level catch site
SlashCommandBuilder           — every v1 command
SlashCommandStringOption      — /capture, /search, /journal
SlashCommandBooleanOption     — toggle flags
SlashCommandAttachmentOption  — /capture files
SlashCommandBuilder#setContexts — guild-only (v15-safe)
SlashCommandBuilder#setIntegrationTypes — guild-install only
ChatInputCommandInteraction   — runtime payload
ChatInputCommandInteraction#options — user input
ChatInputCommandInteraction#deferReply — 3s contract
ChatInputCommandInteraction#editReply — post-defer reply
ChatInputCommandInteraction#reply — /ping <3s
ChatInputCommandInteraction#isXxx — type narrowing in router
BaseInteraction               — router type, owner-gate
CommandInteraction            — router parent type
User                          — i.user.id for owner-gate
EmbedBuilder                  — primary output
EmbedBuilder.set* setters     — fluent embed factory
AttachmentBuilder             — output >1500 chars
AttachmentBuilder.set*        — name/desc/spoiler
MessageFlags.Ephemeral        — every reply
InteractionContextType.Guild  — restrict to guild
ApplicationIntegrationType.GuildInstall — guild-install only
ApplicationCommandOptionType  — internal to builders
ChannelType                   — narrow channel type in messageCreate
TextChannel                   — #inbox channel
Message                       — #inbox payload
Message#author/#channel/#channelId/#content/#attachments/#id/#url — inbox flow
Message#react                 — ✅/❌ ack
MessageReaction               — same
Collection                    — read from managers
REST                          — command registration
REST#setToken                 — registration
REST#put                      — registration
Routes                        — applicationGuildCommands
DiscordAPIError               — error router
DiscordjsError                — error router
HTTPError                     — error router
codeBlock / inlineCode        — note IDs / snippets
bold / italic                 — embed headings
quote / blockQuote / subtext / heading — layout
hyperlink                     — open-in-Scrypt
time / TimestampStyles        — relative timestamps
channelMention                — help text
chatInputApplicationCommandMention — help text
messageLink                   — captured-from links
```

### MIGHT_USE_LATER (v1.5 multi-user / Para-RAID / far-future)

```
SlashCommandSubcommandBuilder — group when surface grows
SlashCommandSubcommandGroupBuilder — same
SlashCommand{Integer,Number,User,Role,Channel,Mentionable}Option — richer args, v1.5 user/role pickers
SlashCommandBuilder#setDefaultMemberPermissions — v1.5 role-gated commands
ContextMenuCommandBuilder     — right-click capture (v1.5)
MessageContextMenuCommandInteraction — same
UserContextMenuCommandInteraction — v1.5 /profile-style ops
ApplicationCommandType        — context-menu commands
AutocompleteInteraction       — /search live results (v1.5)
AutocompleteInteraction#respond — same
ModalBuilder / TextInputBuilder / TextInputStyle — /journal modal (v1.5)
ModalSubmitInteraction / ModalSubmitFields — same
ChatInputCommandInteraction#showModal / #awaitModalSubmit — same
ChatInputCommandInteraction#followUp — multi-step /brief
ChatInputCommandInteraction#deleteReply / #fetchReply — corner cases
ContainerBuilder              — Components V2 upgrade for /brief
SectionBuilder                — V2 building block
TextDisplayBuilder            — V2 markdown pane
SeparatorBuilder              — V2 divider
MediaGalleryBuilder / MediaGalleryItemBuilder — multi-image v2
FileBuilder / ThumbnailBuilder — V2 attachments
ActionRowBuilder              — buttons row in /ask retry
ButtonBuilder / ButtonStyle   — same (ButtonStyle.Premium stays NEVER)
StringSelectMenuBuilder / StringSelectMenuOptionBuilder — picker UX
UserSelectMenu/RoleSelectMenu/MentionableSelectMenu/ChannelSelectMenuBuilder — v1.5 audience pickers
MessageFlags.IsComponentsV2   — required for V2 payloads
MessageFlags.SuppressNotifications — quieter /brief
MessageFlags.SuppressEmbeds   — corner cases
Message#startThread           — threads-as-conversations (v1.5)
Message#createMessageComponentCollector / #awaitMessageComponent — buttons
Message#awaitReactions        — reaction-driven UX
Message#interactionMetadata   — thread starter context
ThreadChannel                 — threads-as-conversations
ThreadChannel#send/#join/#leave/#setArchived/#fetchStarterMessage — same
Events.MessageReactionAdd / Remove / RemoveAll / RemoveEmoji — reaction-as-UX (v1.5)
Events.Thread* events         — threads-as-conversations
Events.GuildMember{Add,Update,Remove,Available,MembersChunk} — v1.5 multi-user onboarding/role-changes
Events.GuildRole{Create,Update,Delete} — v1.5 role-gated commands rebuild perm map
Events.GuildBan{Add,Remove}   — v1.5 surfacing only; uxie never authors bans
Events.ApplicationCommandPermissionsUpdate — v1.5 Discord-side perm overrides
DMChannel                     — DM capture (v1.5)
GatewayIntentBits.DirectMessages — DM capture
GatewayIntentBits.DirectMessageReactions / DirectMessageTyping / DirectMessagePolls — DM companions (v1.5)
GatewayIntentBits.GuildMessageReactions — reactions UX
GatewayIntentBits.GuildMembers — PRIVILEGED, enable in dev portal at v1.5 ship
PermissionFlagsBits           — v1.5 multi-user role-gate bitmask
PermissionsBitField           — v1.5 in-code permission queries
Status                        — surface gateway state in /ping
RateLimitData / RESTEvents.RateLimited / .InvalidRequestWarning — observability
WebSocketManager              — ws.ping today; v15 uses Client#ping
Activity / ActivityType / Client#options.presence — bot presence cosmetic
ClientPresence / ClientUser   — runtime identity tweaks
Collector / MessageCollector / InteractionCollector — V2 button handling
Util.escapeMarkdown / cleanContent / parseEmoji — sanitize echoed content
escapeBold / escapeItalic / escapeCodeBlock — same family
underline / strikethrough / spoiler — extended formatting
userMention / roleMention / formatEmoji — rare cases
Emoji / GuildEmoji / ApplicationEmoji / ReactionEmoji — custom inbox ack emoji
ApplicationCommandManager / GuildApplicationCommandManager — runtime registration if ever needed
GuildMemberManager / RoleManager — v1.5 roster + role-by-name resolution
Guild / GuildMember / Role    — v1.5 multi-user permission walks
GuildMember#permissions / #roles — v1.5 guard reads
Poll / PollAnswer             — v1.5 multi-user collab (e.g., "which note to summarize first")
Partials.User / GuildMember / ThreadMember — v1.5 multi-user / thread partials
Partials.Reaction             — required if reactions intent is on
Partials.Poll / PollAnswer    — companion to Poll
Emoji / GuildEmoji / ApplicationEmoji / ReactionEmoji — custom emoji UX
BaseSelectMenuComponent + concrete select menu *components* — read-only after v1.5 select-menu interactions
Client#users                  — v1.5 author resolution
Client#application            — runtime command registration
Client#rest                   — registration script
Client#ws                     — ws.ping today
ClientUser / ClientPresence   — runtime identity
@discordjs/util lazy() / DiscordSnowflake.timestampFrom — alt init / log traces
```

### NEVER_USE

```
# --- removed/deprecated on the v15 path (NEVER because v15 is our migration target) ---
Client#emojis                 — removed in v15 (use resolveGuildEmoji util)
Client#options.shards / shardCount — moved to ws.shardIds/ws.shardCount in v15
Events.ShardError / ShardReady / ShardReconnecting / ShardResume / ShardDisconnect — removed in v15
Events.WebhooksUpdate (string "webhookUpdate") — string renamed in v15; subscribe via Events constant only
SlashCommandBuilder#setDMPermission — removed in v15 (use setContexts)
SlashCommandBuilder#setDefaultPermission — long-deprecated
ChatInputCommandInteraction#sendPremiumRequired — removed in v15
ChatInputCommandInteraction#isAnySelectMenu — removed in v15 (use isSelectMenu)
Message#interaction           — removed in v15 (use interactionMetadata)
ActionRow.from()              — removed in v15 (use ActionRowBuilder.from())
SelectMenuBuilder (legacy alias) — removed in v15
NewsChannel                   — renamed AnnouncementChannel in v15; bind to neither (out of scope)
Constants                     — many entries gone in v15
Formatters (legacy aggregate) — use named functions
ShardEvents enum              — gone in v15
GatewayIntentBits.GuildBans / GuildEmojisAndStickers — deprecated names
Client#fetchPremiumStickerPacks — removed in v15

# --- architecture-incompatible (Bun, single-process, stateless) ---
Client#voice                  — Bun + @discordjs/voice broken (oven-sh/bun#11313)
Client#shard (ShardClientUtil) — single-guild; sharding only matters past 2,500 guilds
Client#sweepers               — stateless rule §15
Client#options.makeCache      — defaults; stateless
Client#options.ws             — single shard
Client#options.failIfNotExists — we don't reply to messages
Sweepers / Options / LimitedCollection — stateless
ShardingManager / ShardClientUtil / Shard — sharding only
WebSocketShard / WebSocketShardEvents — internal
BaseClient                    — internal
@discordjs/ws CompressionMethod — zlib-sync forbidden (research §11); Bun WS doesn't use it
@discordjs/voice ALL exports  — Bun-incompatible
@discordjs/brokers ALL exports — multi-process; stateless rule + no roadmap to multi-tenant SaaS
@discordjs/proxy ALL exports  — single-process; same reason
@discordjs/next ALL exports   — experimental fork; v15 (mainline) is the migration target
@discordjs/core Client / API  — parallel low-level stack to discord.js; adopting it = from-scratch rewrite, not migration

# --- intents/events with no uxie feature even at v1.5 ---
GatewayIntentBits.GuildPresences — privileged; no presence-driven feature planned
GatewayIntentBits.GuildVoiceStates — voice stack Bun-blocked
GatewayIntentBits.GuildExpressions / GuildIntegrations / GuildWebhooks / GuildInvites — no surface
GatewayIntentBits.GuildScheduledEvents — cron is Para-RAID's plane
GatewayIntentBits.AutoModeration{Configuration,Execution} — moderation is plane-excluded (SUP-§3)
Events.Typing* / Presence* / VoiceState* / Voice* / Soundboard* / StageInstance* / GuildScheduledEvent* / AutoModeration* / Invite* / Sticker* / Emoji* / Entitlement* / GuildIntegrationsUpdate — no surface
Events.GuildAuditLogEntryCreate — audit-log telemetry is Ops-plane (Para-RAID); pairs with GuildAuditLogs verdict
Events.MessageUpdate / MessageDelete / MessageDeleteBulk — #inbox is fire-and-forget; don't chase edits
Events.Raw                    — never parse raw payloads
Events.CacheSweep             — stateless
Partials.GuildScheduledEvent / SoundboardSound — out of scope

# --- slash command fluff ---
SlashCommandBuilder#setNSFW   — personal vault tooling; irrelevant
SlashCommandBuilder#setNameLocalizations / setDescriptionLocalizations — single locale even at v1.5

# --- interaction methods we won't reach for ---
ChatInputCommandInteraction#launchActivity — Activities out of scope at every horizon

# --- message methods incompatible with fire-and-forget inbox ---
Message#edit / #delete / #suppressEmbeds / #crosspost / #forward / #removeAttachments — we don't mutate user messages
Message#reply                 — we ack with reaction, not reply
Message#pin / #unpin          — out of scope
Message#fetchWebhook / #fetchReference / #poll — out of scope (poll is read-only via the Poll class which is USE LATER)

# --- channel types out of scope ---
NewsChannel / AnnouncementChannel — not used
ForumChannel / VoiceChannel / StageChannel / MediaChannel / CategoryChannel / DirectoryChannel — out of scope

# --- moderation / audit-log / discipline (plane-excluded at every horizon) ---
GuildMember#kick / #ban / #timeout — moderation is not uxie's plane; separate-bot decision
GuildAuditLogs / GuildAuditLogsEntry — Discord-side moderation telemetry is Ops-plane (Para-RAID)
AutoModerationRule / AutoModerationActionExecution — mod rule authoring is plane-excluded

# --- monetization, webhooks, voice/stage, scheduled events, stickers ---
ButtonStyle.Premium           — no monetization at any horizon
Invite / GuildPreview / GuildTemplate / Widget / OAuth2Guild — out of scope
Webhook / WebhookClient       — ingress is gateway-only
parseWebhookURL               — we don't ingest webhooks
Entitlement / SKU / Subscription — no monetization
StageInstance / Soundboard    — voice/stage Bun-blocked
GuildScheduledEvent           — cron is Para-RAID's plane
Sticker / StickerPack         — out of scope

# --- internals / non-features ---
RequestMethod / parseResponse — internal
RESTEvents.{HashSweep,HandlerSweep,Response,Restart} — we don't subscribe
@discordjs/util range / shouldUseGlobalFetchAndWebSocket / calculateShardId — edge-runtime / sharding only
LaunchActivity types          — Activities out of scope
```

---

## §7. Open questions / things-to-verify

These can't be fully answered from docs alone — they need a code-level check during implementation.

1. **Async error boundary under v15's `AsyncEventEmitter`.** Verify our error router at `bot/router.ts` catches **rejected promises** thrown from listener bodies, not just synchronous throws. Test by deliberately throwing inside a `messageCreate` handler under a v15-pre install.
2. **`MessageContent` privilege for unverified bots ≤100 guilds.** Confirm with the Developer Portal that the toggle still flips without verification at our scale. (Discord's UI is authoritative.)
3. **Bun's behavior with discord.js's `Client#destroy`.** Bun's signal handling differs slightly from Node's; verify systemd `SIGTERM` triggers the dispose chain cleanly (`Symbol.asyncDispose` is on `Client` in v14.26).
4. **`zlib-sync` and `bufferutil` perf gain on Bun.** Both are flagged as forbidden in research §11, but the research's reasoning was ARM build pain. On Oracle ARM under Bun, do `zlib-sync`'s prebuilds exist? If not, the rule stays. (Likely stays — Bun's WS impl doesn't even use them.)
5. **Default `allowedMentions` shape.** Confirm `{ parse: [], repliedUser: false }` set on the `Client` is inherited by `interaction.reply` and `editReply` (it should be — they go through `BaseMessageOptions` defaults).
6. **`Routes.applicationGuildCommands` vs `Routes.applicationCommands`.** Per-guild registration is instant, global is up to 1h propagation. v1 is per-guild — confirm at registration script.
7. **Components V2 + ephemeral compatibility.** The components docs imply both work together but we should verify with a minimal test before committing `/brief` to the upgrade path.
8. **`@discordjs/next` direction.** It's labeled experimental and the docs page is sparse. Watch for whether it becomes the default in discord.js v16 or stays a separate stack — affects our v2 architecture decisions.
9. **Forward-compat of `Events.ClientReady` constant.** v15 changes the *string* but the *enum member* is stable. Spot-check that v14.26's `Events.ClientReady === 'clientReady'` already (the changelog implies it does — confirm by `console.log(Events.ClientReady)` at boot).
10. **Per-guild slash command cap.** Discord's documented cap is 100 guild commands. We have 6. No issue, but if Para-RAID adds another 5–10 ops commands, confirm we're well clear.

---

## §8. Source index

URLs fetched and indexed in this audit, in order. Each was retrieved via `ctx_fetch_and_index` (raw output stayed in sandbox).

- <https://discord.js.org/docs/packages/discord.js/14.26.2>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/Client:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/ClientOptions:Interface>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/GatewayIntentBits:Enum>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/Events:Enum>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/Partials:Enum>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/SlashCommandBuilder:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/ChatInputCommandInteraction:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/AutocompleteInteraction:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/ContextMenuCommandBuilder:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/ModalBuilder:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/ModalSubmitInteraction:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/EmbedBuilder:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/ContainerBuilder:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/SectionBuilder:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/TextDisplayBuilder:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/SeparatorBuilder:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/MediaGalleryBuilder:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/FileBuilder:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/ActionRowBuilder:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/ButtonBuilder:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/StringSelectMenuBuilder:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/MessageFlags:Enum>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/InteractionContextType:Enum>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/ApplicationIntegrationType:Enum>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/PermissionFlagsBits:Variable>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/ChannelType:Enum>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/ThreadChannel:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/ForumChannel:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/Message:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/MessageReaction:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/AttachmentBuilder:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/Collection:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/REST:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/Routes:Variable>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/ShardingManager:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/ShardClientUtil:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/WebSocketManager:Class>
- <https://discord.js.org/docs/packages/discord.js/14.26.2/RateLimitData:Interface>
- <https://discord.js.org/docs/packages/builders/main>
- <https://discord.js.org/docs/packages/rest/main>
- <https://discord.js.org/docs/packages/ws/main>
- <https://discord.js.org/docs/packages/voice/main>
- <https://discord.js.org/docs/packages/util/main>
- <https://discord.js.org/docs/packages/collection/main>
- <https://discord.js.org/docs/packages/core/main>
- <https://discord.js.org/docs/packages/formatters/main>
- <https://discord.js.org/docs/packages/brokers/main>
- <https://discord.js.org/docs/packages/proxy/main>
- <https://discord.js.org/docs/packages/next/main>
- <https://discordjs.guide/v15>
- <https://github.com/discordjs/discord.js/blob/main/packages/discord.js/CHANGELOG.md>
- <https://discordjs.guide/sharding/>
- <https://discordjs.guide/miscellaneous/cache-customization>
- <https://discord.com/developers/docs/components/reference>
- <https://discord.com/developers/docs/components/overview>
- <https://discord.com/developers/docs/topics/rate-limits>
- <https://discord.com/developers/docs/interactions/receiving-and-responding>
- <https://platform.openai.com/docs/guides/streaming-responses>

Skipped (HTTP 404, original brief paths): `https://discordjs.guide/popular-topics/sharding.html`, `https://discordjs.guide/miscellaneous/cache-customization.html` — the modern guide moved to `/sharding/` and `/miscellaneous/cache-customization` (no `.html`); both fetched successfully under the new paths and are listed above.
