// sup module entry — stack-level operations (/sup status today; update/backup legs join once
// the VPS pipeline lands). Deliberately owns NO clients: it borrows scrypt's rest client and
// para-raid's socket client from the already-built modules, so stack probes and per-app
// commands always observe the SAME live connections (the create-once-share-everywhere rule
// from src/index.ts). Does NOT read process.env (decision 11) — env flows in via lib/env.ts.
import { hostname } from "node:os";
import { Collection } from "discord.js";
import { buildCommandCollection, type LoadedCommand } from "../../bot/command-loader.ts";
import type { Env } from "../../lib/env.ts";
import type { ScryptRestClient } from "../scrypt/rest-client.ts";
import type { ParaRaidClient } from "../para-raid/client.ts";
import { buildSupCommand } from "./commands/sup.ts";

export function buildSupModule(
  env: Env,
  rest: ScryptRestClient,
  paraRaid: ParaRaidClient | undefined,
): { commands: Collection<string, LoadedCommand> } {
  const opts = { host: `${env.UXIE_ENV} · ${hostname()}` };
  return { commands: buildCommandCollection([buildSupCommand(rest, paraRaid, opts)]) };
}
