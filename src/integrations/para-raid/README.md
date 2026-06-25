# para-raid (v2 module placeholder)

Reserved seam for a future v2 orchestration module. Intentionally inert — nothing here is wired into
the boot path.

- `orchestrator-stub.ts` — `dispatch()` throws `NotImplementedError`. It marks where a para-raid
  orchestrator would attach without committing the bot to any of its behaviour.

Lives under `integrations/`, NOT under `scrypt/` (ratified decision 12).
