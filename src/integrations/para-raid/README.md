# para-raid (v2 orchestration module)

Discord → live tmux Claude session → reply back in Discord (ratified decision 12). No longer a
stub: `/raid open` opens a session in a fresh thread, owner messages in that thread become
`send_turn` calls, and the daemon's webhook events post back into it. See the module's design
doc (`raid-v2-spec.md`, amendments A1-A12) for the full contract.

- `client.ts` — `ParaRaidClient`, a thin control client over the daemon's unix socket.
- `sessions.ts` — in-memory thread↔session cache (v1's statelessness invariant carries over: no
  disk state, a cache miss just costs one `GET /v1/sessions` refresh).
- `receiver.ts` — the webhook receiver (HMAC verify + dedup; pure transport).
- `events.ts` — one handler per webhook event type (the business logic side of the receiver).
- `relay.ts` — the `MessageCreate` → `send_turn` relay.
- `commands/raid.ts` — `/raid open|status|close`.
- `index.ts` — `buildParaRaidModule(env)` (side-effect free, safe for `deploy-commands.ts`) and
  `startParaRaidRuntime(mod, client, env)` (boot-only: starts the receiver + relay listener).

## Enabling it

Off by default. Set the whole `PARARAID_SOCKET` / `PARARAID_ADAPTER_TOKEN` /
`PARARAID_SIGNING_SECRET` group together (all-or-none, enforced at boot — see `lib/env.ts`) plus
optionally `PARARAID_WEBHOOK_PORT` (default `18901`). See `scripts/vps/uxie.env.example` for the
commented block and `docker-compose.vps.yml` for the socket-dir mount recipe.

Turning it on also flips the bot's Discord intents: `GuildMessages` + `MessageContent` get added
(`bot/client.ts`), and `MessageContent` is privileged — enable it in the Discord dev portal
(Bot > Privileged Gateway Intents) or login fails with "disallowed intents".

Optionally set `LIBRARIAN_CHANNEL_ID` (a text-channel id, independent of the group) to handle
the nightly CLI-opened librarian sessions (`adapter_ref` `librarian:<utc-date>`): their events
get a thread named after the adapter_ref in that channel (reused if one already exists), and
owner messages in it relay like any `/raid` thread. Absent = librarian events are logged and
dropped.

For a full local end-to-end walkthrough (para-raid + uxie + a real `/raid` round trip), see
`docs/e2e-local.md`.
