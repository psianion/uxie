# para-raid v2 — WSL2 end-to-end checklist

One local run through the whole `/raid` loop: scrypt up with real auth, para-raid installed and
logged in, uxie's message intents flipped on, a full open → turn → reply round trip (including a
turn that hits a scrypt MCP tool), a para-raid restart to prove session auto-resume (A6), and a
Tailscale sanity check. Not automated — this is an operator checklist, run by hand after any
change that touches the para-raid module.

## 0. Prerequisites

- WSL2, with `bun`, `tmux`, and `claude` (Claude Code CLI) on PATH.
- `scrypt`, `para-raid`, and `uxie` cloned as sibling repos.
- A throwaway Discord test guild you own, with a bot application already set up per
  `docs/BOT-SETUP.md`.

## 1. scrypt — real auth

```sh
cd scrypt
cp .env.example .env
# fill SCRYPT_AUTH_TOKEN (openssl rand -hex 32), uncomment NODE_ENV=production
bun install
NODE_ENV=production bun run dev
```

`NODE_ENV=production` disables the localhost dev-auth bypass — without it, a turn that calls a
scrypt MCP tool would "work" locally but silently break against a real deployment.

## 2. para-raid — install, log in, smoke-test

```sh
cd para-raid
claude auth login          # one-time, uses your own Claude subscription
./install.sh                # deps + `para-raid setup` (config, token, signing secret, systemd unit, doctor)
para-raid up
para-raid status             # confirm mode=running
```

Edit `~/.config/para-raid/mcp-bundles.toml` to add a bundle pointing at scrypt's MCP endpoint
(needed for step 5's MCP-using turn), then run the reference-adapter smoke test to prove the
daemon + your `claude` login actually work end to end, independent of uxie:

```sh
PARARAID_SOCKET=$(bun -e 'console.log(process.env.XDG_RUNTIME_DIR)')/para-raid.sock \
PARARAID_ADAPTER_TOKEN=<token from [adapters.uxie] in config.toml> \
PARARAID_SIGNING_SECRET=<secret from [signing] in config.toml> \
bun run examples/reference-adapter/main.ts
```

Expect it to exit 0 after printing a verified `turn_replied`.

**A12 gotcha:** `install.sh`/`para-raid setup` only ever rewrite `[auth]` and `[signing]` in
`config.toml` — `[adapters.uxie].webhook_url` ships pointing at `http://localhost/api/webhooks/para-raid`
and must be hand-edited to `http://127.0.0.1:18901/api/webhooks/para-raid` (or whatever
`PARARAID_WEBHOOK_PORT` you choose) before uxie's receiver will ever see a delivery.

## 3. Discord portal — MessageContent intent

Dev Portal → your app → **Bot** → *Privileged Gateway Intents* → enable **Message Content
Intent** (leave *Presence Intent* off). Without this, `bun run dev` below fails at
`client.login()` with "disallowed intents" the moment `PARARAID_SOCKET` is set. Also confirm the
bot's guild permissions include **Create Public Threads**, **Send Messages in Threads**, and
**Add Reactions** (covered already if you invited it with Administrator per `docs/BOT-SETUP.md`).

## 4. uxie — dev, with para-raid enabled

```sh
cd uxie
cp .env.example .env
# fill the usual DISCORD_*/SCRYPT_* vars, then add:
#   PARARAID_SOCKET=<same $XDG_RUNTIME_DIR/para-raid.sock as step 2 — native WSL2 run, so the
#                     daemon's default socket path just works, no container mount needed>
#   PARARAID_ADAPTER_TOKEN=<same token as step 2>
#   PARARAID_SIGNING_SECRET=<same secret as step 2>
#   PARARAID_WEBHOOK_PORT=18901
bun install
bun run dev
```

Confirm the boot log shows `para-raid webhook receiver started` and does NOT show a config
error naming any `PARARAID_*` field (that means the group is partially set — see `lib/env.ts`).

## 5. `/raid` round trip

1. `/raid open prompt:"say hi, then read the scrypt daily_context via MCP" bundle:<your bundle>`
   from a regular channel (not inside a thread). Confirm a new public thread appears and an
   ephemeral reply links to it.
2. In the thread, watch for `session live`, then the turn's reply — this first turn is the one
   that must show a real scrypt MCP call succeeding (check scrypt's own log for the request).
3. Send a follow-up message as the owner in the thread. Confirm a ⏳ reaction appears, then the
   next `turn_replied` note.
4. `/raid status` — confirm the session shows up with the right thread mention and a recent
   `last turn`.
5. `/raid close` (run from inside the thread) — confirm the session closes.

## 6. Restart → auto-resume (A6)

Open a fresh session (`/raid open`), let it go `live`, then:

```sh
systemctl --user restart para-raid
```

Within the 10-minute recovery grace window, confirm the session's thread receives a
`session recovered after restart` note — **without** you running any command. This is the whole
point of A6: without the `resume_session` call in `events.ts`, every daemon restart (including
every `update-para-raid.sh` cron run) silently kills all sessions once the grace window lapses,
because `open_session` can't reclaim them (a fresh thread id never matches the old `adapter_ref`).

**A12 gotcha:** if you change `[daemon].socket_path` in `config.toml`, the systemd unit does
NOT pick it up on its own — run `systemctl --user restart para-raid` explicitly after editing it.

## 7. Tailscale remote access (optional)

If your dev box is on a tailnet, confirm the loopback design holds under it:

- uxie's webhook receiver binds `127.0.0.1` only — a teammate on the tailnet should NOT be able
  to reach `<tailnet-ip>:18901/api/webhooks/para-raid` (connection refused, not 401).
- Discord's gateway connection (outbound from uxie) works unaffected by Tailscale either way.
- If scrypt's `SCRYPT_BIND_ADDR` is set to a tailnet IP for cross-box access, re-confirm step 1's
  turn still resolves scrypt over `https://` or a loopback `http://` per `lib/env.ts`'s
  UX-SEC-002 URL check — a plaintext `http://` to the tailnet IP fails uxie's boot validation.
