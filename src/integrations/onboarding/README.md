# onboarding

Event-driven guest onboarding for a single guild. **No slash commands** — it reacts to gateway
events and `onboard:*` button interactions. Built by `buildOnboardingModule(env, client)`
(`index.ts`), which registers the `GuildMemberAdd` + `ClientReady` listeners and returns the button
handlers the interaction router dispatches.

## Flow
1. **Join** (`member-join.ts`, `GuildMemberAdd`) — assign the guest role (`guildConfig.guestRoleId`).
2. **Welcome picker** (`welcome-message.ts`, reconciled at `ClientReady`) — a pinned Components-V2
   message in `welcomeChannelId`: one Section per role in `guildConfig.pickableRoleIds` (live name +
   `roleMeta` blurb + member count) with a **Request** button. Edited in place on restart.
3. **Request** (`role-pick-handler.ts`) — a guest taps Request; an access-request card is posted to
   `accessRequestsChannelId` with Approve/Deny. A per-user+role cooldown throttles re-request spam
   (UX-SEC-001).
4. **Decision** (`approval-handler.ts`, **owner-gated**) — Approve grants the role (add-first, then
   strips guest) and DMs the member; Deny DMs the reason. The card is edited to the final state.

## Files
- `index.ts` — module factory + event wiring
- `member-join.ts` — guest-role assignment on join
- `welcome-message.ts` — welcome picker build + ready-time reconcile
- `role-pick-handler.ts` — Request button + re-request throttle
- `approval-handler.ts` — owner-gated Approve/Deny + grant + DM
- `ui.ts` — pure Components-V2 builders (`buildWelcomeContainer`, `buildAccessRequestContainer`,
  `buildDecisionContainer`, `buildDmContainer`); `ACCENT`, `MAX_ROLE_SECTIONS` (10)
- `custom-id.ts` — `onboard:*` custom-id encode/decode
- `types.ts` — shared types

## Config & observability
Channels/roles come from `src/config/guild.ts` (`welcomeChannelId`, `accessRequestsChannelId`,
`guestRoleId`, `pickableRoleIds`, `roleMeta`). Grant/DM/reconcile failures log `warn`/`error`, which
are mirrored to the log channel when `guildConfig.logChannelId` is set.
