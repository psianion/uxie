# para-raid (v2 module placeholder)

Reserved seam for the v2 orchestration module. It is intentionally inert in v1:
`uxie` stays a stateless translation layer (Discord → Scrypt). Nothing here is
wired into the boot path.

- `orchestrator-stub.ts` — `dispatch()` throws `NotImplemented`. It marks where the
  para-raid orchestrator will attach without committing v1 to any of its behaviour.

This folder lives under `integrations/`, NOT under `scrypt/` (ratified decision 12).
