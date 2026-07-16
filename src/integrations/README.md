# integrations

Outward-facing modules, one folder per module. Each owns its commands / event handlers / clients
and exposes a `build<Module>Module(...)` factory, wired in the boot path (`src/index.ts`) and merged
into the command registry (`src/bot/command-registry.ts`).

| Module | Surface | Entry point |
|--------|---------|-------------|
| [`onboarding/`](./onboarding/README.md) | Event-driven guest onboarding: join → guest role → role picker → request → owner approve/deny → DM. No slash commands. | `buildOnboardingModule(env, client)` |
| [`server/`](./server/README.md) | Owner-gated guild admin: `/create-category`, `/create-channel`, `/create-role`. | `buildServerModule(env)` |
| [`scrypt/`](./scrypt/README.md) | `/ping` health panel + Scrypt restart + connectivity logging, plus the v2 capture/query surface: `/capture`, `/journal`, `/search`, `/brief`. | `buildScryptModule(env)` |
| [`para-raid/`](./para-raid/README.md) | v2 orchestration: `/raid open\|status\|close`, thread↔session relay, webhook receiver. Off unless the `PARARAID_*` env group is set. | `buildParaRaidModule(env)` / `startParaRaidRuntime(mod, client, env)` |
