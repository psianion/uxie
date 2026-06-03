# integrations

Outward-facing modules live here, one folder per module. Each module owns its
commands, channel predicates, and clients, and exposes a single
`register<Module>Integration(bot)` entry point.

- `scrypt/` — the v1 module: REST writes (`POST /api/ingest`) + MCP reads
  (`searchNotes`, `semanticSearch`, `getNote`). Hosts the six slash commands and
  the passive `#inbox` capture.
- `para-raid/` — v2 module placeholder. `orchestrator-stub.ts` defines the seam
  (`dispatch()` throws `NotImplemented`) so v1 stays a pure translation layer.

Modules go here.
