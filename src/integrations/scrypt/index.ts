// scrypt module entry. Builds the REST client from validated env and the command
// collection (just /ping in Wave 1). The module owns its clients and commands; the boot
// path only calls buildScryptModule and wires the resulting collection into the router.
import { buildCommandCollection, type LoadedCommand } from "../../bot/command-loader.ts";
import { ScryptRestClient } from "./rest-client.ts";
import { buildPingCommand } from "./commands/ping.ts";
import type { Env } from "../../lib/env.ts";

export interface ScryptModule {
  commands: ReturnType<typeof buildCommandCollection>;
  rest: ScryptRestClient;
}

export function buildScryptModule(env: Env): ScryptModule {
  const rest = new ScryptRestClient(env.SCRYPT_SERVER_URL, env.SCRYPT_AUTH);
  const cmds: LoadedCommand[] = [buildPingCommand(rest)];
  return { commands: buildCommandCollection(cmds), rest };
}
