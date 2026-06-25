# uxie

Single-user Discord bot for running a personal guild — member onboarding with owner-approved
role grants, server-structure slash commands, and a Scrypt second-brain integration. Built on
Bun + TypeScript + discord.js v14.

## Modules

- **Onboarding** — new members land as a guest and get a welcome message with a role picker.
  A request posts an Access Request card (Approve / Deny) to the `#access-requests` channel for
  **owner-only** review. Repeated requests for the same role are throttled per user (5-min
  default) so the review channel can't be flooded.
- **Server management** — owner-only `/create-channel`, `/create-category`, and `/create-role`,
  including private-channel permission overwrites and role permission presets.
- **Scrypt** — a `/ping` health panel (Components V2) with refresh / retry / auto-retry recovery
  buttons and an **optional, owner-only** "Restart Scrypt" button (off by default). Connectivity
  up/down transitions are logged. _Capture/query (`/capture`, `/search`, …) is deferred pending
  Scrypt's ingestion rework — see `src/integrations/scrypt/README.md`._

Each module documents itself in `src/integrations/<module>/README.md`.

## Discord prerequisites

1. Create an application at https://discord.com/developers/applications
2. Create a bot user; copy the token → `.env` `DISCORD_BOT_TOKEN`
3. Copy the application id → `DISCORD_APP_ID`
4. Invite the bot to your guild with scopes `bot` + `applications.commands`
5. Copy the guild id → `DISCORD_DEV_GUILD_ID`
6. Copy your own user id → `DISCORD_OWNER_ID`

The bot's top role must sit **above** the guest and pickable roles in the hierarchy so it can
assign them.

## Configuration

Secrets and runtime flags live in `.env` (copy `.env.example`). The guild structure used by
onboarding — welcome/access-requests channel ids, the guest role, and the pickable roles — lives
in `src/config/guild.ts` (operator-edited snowflakes, validated loudly at boot; not secrets).

### Environment (`.env`)

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `DISCORD_BOT_TOKEN` | yes | — | Bot token (secret) |
| `DISCORD_APP_ID` | yes | — | Application id |
| `DISCORD_DEV_GUILD_ID` | yes | — | Guild the bot operates in |
| `DISCORD_OWNER_ID` | yes | — | The single owner; gates every privileged action |
| `SCRYPT_SERVER_URL` | yes | — | Scrypt REST base — see scheme rule below |
| `SCRYPT_AUTH` | yes | — | Scrypt bearer token (secret) |
| `UXIE_ENV` | no | `local` | Label shown in the `/ping` Host row (e.g. `local`, `vps`) |
| `ALLOW_SCRYPT_RESTART` | no | `0` | Opt-in for the owner-only Restart Scrypt button |
| `SCRYPT_RESTART_CMD` | no | `docker compose restart scrypt` | Fixed-argv restart command (no shell; leading binary allowlisted) |

### Scrypt URL scheme rule (security)

To keep the `SCRYPT_AUTH` bearer off untrusted wire, `SCRYPT_SERVER_URL`
accepts `https://` to any host but `http://` **only to a loopback host** (`localhost` /
`127.0.0.1` / `[::1]`). Pointing Scrypt at a non-loopback host over plaintext `http://` fails
boot with a `ConfigError`. For a remote or docker-internal Scrypt, use `https://`.

## Run

```sh
cp .env.example .env   # fill in values
bun install
bun run typecheck      # tsc --noEmit
bun test
bun run deploy         # register slash commands to the dev guild
bun run start          # or: docker compose up uxie
```

## Security

Privileged interactions (server commands, the restart button, onboarding approvals) are gated to
the **owner** — and, for component clicks, to the **dev guild** — *before* any side effect.
`src/lib/env.ts` is the sole reader of secrets; the Restart Scrypt path uses a no-shell,
allowlisted `execFile` with a minimal child env (never the bot/Scrypt secrets), a confirm nonce,
single-flight, and a cooldown.

A standing security audit, threat model, remediation plan, and a `/security-check` pre-merge
checklist skill are maintained under `docs/security/` and `.claude/skills/` (kept local; both
paths are gitignored). Run `/security-check` as the final gate before approving a PR.
