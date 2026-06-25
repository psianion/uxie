# Uxie — Discord Bot Setup Guide

Step-by-step setup for the **uxie** bot, grounded in the live discord.js docs
(<https://discord.js.org/docs/>) and the Discord Developer Portal. Ends with a
**Claude browser-extension runbook** you can hand to the extension to do the
portal clicks for you.

This bot uses **discord.js `^14.26.0`** (latest on npm: **14.26.4**) and the
Discord **REST API v10**. Runtime is **Bun**, not Node.

---

## Part A — Pick the right docs version on discord.js.org

1. Open <https://discord.js.org/docs/>.
2. Top-left there are **two dropdowns**: a *package* selector and a *version*
   selector (it shows `Loading versions...` then a list).
3. Set **package = `discord.js`** and **version = `main`**.
   - `main` tracks the current **stable 14.x** line — the same major this repo
     pins (`^14.26.0`). Do **not** pick an old tag like `14.0.0`, and do **not**
     pick `next` (that is the unreleased v15 line and will not match this code).
4. When a page references `REST({ version: '10' })`, that is the **API**
   version (v10) — separate from the library version. This repo already uses
   v10 in `src/bot/deploy-commands.ts`; leave it as-is.
5. Useful library pages while wiring things up: `Client`, `GatewayIntentBits`,
   `Partials`, `REST`, `Routes`.

> The docs landing page also notes "Node.js 22.12.0 or newer is required" — this
> only applies if you run on Node. We run on Bun, so that requirement is moot.

---

## Part B — Create the application & bot (Developer Portal)

| # | URL | Action | What you get |
|---|-----|--------|--------------|
| 1 | <https://discord.com/developers/applications> | Click **New Application**, name it `uxie`, accept ToS, **Create** | The app |
| 2 | App → **General Information** | Copy **Application ID** | `DISCORD_APP_ID` |
| 3 | App → **Bot** | Click **Reset Token** → confirm → **Copy** (shown once) | `DISCORD_BOT_TOKEN` |
| 4 | App → **Bot** → *Privileged Gateway Intents* | **Enable `SERVER MEMBERS INTENT`**. Leave *Presence* and *Message Content* **OFF**. **Save Changes** | Lets onboarding receive `GuildMemberAdd` on join |
| 5 | App → **Installation** (or legacy **OAuth2 → URL Generator**) | Build the invite URL (Part C below) | Invite link |

### Intents this bot needs (must match `src/bot/client.ts`)
- `Guilds` — receives slash-command + button interactions. *(not privileged)*
- `GuildMembers` — **privileged**, toggled in step 4 above. Without it,
  onboarding's `GuildMemberAdd` listener never fires, so joiners get no guest role.

> Intentionally **NOT** enabled: *Presence Intent*, *Message Content Intent*,
> DirectMessages — minimum attack surface (ratified design decision 6). Sending
> DMs (onboarding grant notices) needs no intent.

---

## How uxie's channels & replies actually work

uxie's privileged surface is owner-only (`DISCORD_OWNER_ID`):

- **Slash commands → ephemeral Components V2 responses.** `/ping` (Scrypt health panel) plus the
  owner-only server-admin commands `/create-category`, `/create-channel`, `/create-role` defer, then
  `editReply` with a Components V2 container and `flags: MessageFlags.Ephemeral` — private to you.
- **Onboarding is event-driven** (not a command): new members get a guest role + a welcome role
  picker; a role request posts an owner-reviewed Approve/Deny card to the access-requests channel,
  and an owner-gated grant DMs the member. See `src/integrations/onboarding/`.

---

## Part C — Invite URL, scopes & permissions

**Scopes:** `bot` + `applications.commands`
**Bot permissions:** **Administrator** — uxie is a personal, owner-only bot that will grow
to "handle everything" (including future Para-RAID ops), so it is invited with full
permissions rather than a hand-tuned set. The gate is enforced in code (owner id), not by
Discord permission bits.

**Permissions integer = `8` (Administrator).**

Ready-made invite URL (replace `APP_ID` with your `DISCORD_APP_ID`):

```
https://discord.com/api/oauth2/authorize?client_id=APP_ID&scope=bot%20applications.commands&permissions=8
```

Open that URL, pick your **test server**, keep **Administrator** ticked, click **Authorize**.

---

## Part D — IDs that come from the Discord *client* (not the portal)

These are **not** in the Developer Portal. Get them from the Discord app:

1. **User Settings → Advanced → enable Developer Mode.**
2. Right-click your **test server** icon → **Copy Server ID** → `DISCORD_DEV_GUILD_ID`.
3. Right-click **your own name** → **Copy User ID** → `DISCORD_OWNER_ID` (owner gate, decision 9).

---

## Part E — Fill `.env`

Copy `.env.example` → `.env` and fill every field (boot validates via Zod in
`src/lib/env.ts` and exits if any is missing):

| Env var | Source |
|---------|--------|
| `DISCORD_BOT_TOKEN` | Portal → Bot → Reset Token (Part B.3) |
| `DISCORD_APP_ID` | Portal → General Information → Application ID (Part B.2) |
| `DISCORD_DEV_GUILD_ID` | Discord client → Copy Server ID (Part D.2) |
| `DISCORD_OWNER_ID` | Discord client → Copy User ID (Part D.3) |
| `SCRYPT_SERVER_URL` | Scrypt REST base, e.g. `http://localhost:3777` (`http://` only to a loopback host; otherwise `https://`) |
| `SCRYPT_AUTH` | Scrypt bearer token (32-byte hex, per Guidelines §17.1) — sent as `Authorization: Bearer ${SCRYPT_AUTH}`; paste the raw token, no `Bearer ` prefix |

---

## Part F — Deploy & run

```bash
bun install
bun run deploy   # PUTs the 4 slash commands to DISCORD_DEV_GUILD_ID (guild-scoped, instant)
bun run start    # boots the gateway client
```

Verify in your test server: type `/ping` → expect a uxie + Scrypt health panel (Components V2).
Commands: `/ping`, `/create-category`, `/create-channel`, `/create-role`.

---

## Part G — Claude browser-extension runbook

Hand these literal steps to the Claude browser extension. It drives the page;
**you** supply login + secrets at the marked STOP points (a bot token is shown
only once and must never be pasted into a chat).

1. **Navigate** to <https://discord.com/developers/applications>.
   **STOP → ask the operator to log in / pass MFA** if a login screen appears.
2. Click **New Application**. Type `uxie` in the name field, tick the ToS box,
   click **Create**.
3. On **General Information**, find the **Application ID** field, click its
   **Copy** button. Tell the operator: *"Save this as `DISCORD_APP_ID`."*
4. In the left sidebar click **Bot**.
5. Click **Reset Token**, confirm in the dialog. The token appears once.
   **STOP → tell the operator to copy it now and store it as `DISCORD_BOT_TOKEN`**
   (do not echo the token back into the conversation).
6. Scroll to **Privileged Gateway Intents**. Toggle **SERVER MEMBERS INTENT**
   **ON**. Leave *Presence Intent* and *Message Content Intent* **OFF**. Click
   **Save Changes**.
7. In the address bar, **navigate** to the invite URL, substituting the app id:
   `https://discord.com/api/oauth2/authorize?client_id=<DISCORD_APP_ID>&scope=bot%20applications.commands&permissions=8`
8. On the authorize screen, open the **"Add to Server"** dropdown, select the
   operator's **test server**, click **Continue**, confirm **Administrator** is ticked,
   click **Authorize**, solve any captcha. **STOP if captcha/MFA blocks.**
9. **Report back** to the operator a checklist: `DISCORD_APP_ID` captured ✅,
   `DISCORD_BOT_TOKEN` captured ✅, SERVER MEMBERS INTENT enabled ✅, bot invited
   to the server ✅.
10. Remind the operator that **three IDs are NOT in the portal** and must be
    copied from the Discord desktop app with Developer Mode on:
    `DISCORD_DEV_GUILD_ID`, `DISCORD_OWNER_ID` (see Part D).

When the `.env` values from Part E are filled, run Part F.
