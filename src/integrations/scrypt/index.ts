// scrypt module entry. Builds the REST + MCP clients from validated env and the command
// collection. The module owns its clients and commands; the boot path wires the command
// collection into the interaction-router. Only /ping is wired today, but the full connection
// layer (REST write/health + MCP read) is constructed and kept ready for the commands being
// rebuilt next.
import { buildCommandCollection, type LoadedCommand } from "../../bot/command-loader.ts";
import { ScryptRestClient } from "./rest-client.ts";
import { ScryptMcpClient } from "./mcp-client.ts";
import { buildPingCommand } from "./commands/ping.ts";
import type { Env } from "../../lib/env.ts";

export interface ScryptModule {
  commands: ReturnType<typeof buildCommandCollection>;
  rest: ScryptRestClient;
  mcp: ScryptMcpClient;
}

export function buildScryptModule(env: Env): ScryptModule {
  const rest = new ScryptRestClient(env.SCRYPT_SERVER_URL, env.SCRYPT_AUTH);
  // Reads use the MCP streamable-http endpoint (decision 2 / scrypt-contract §2); writes use
  // REST. Same SCRYPT_AUTH bearer; different base URL.
  const mcp = new ScryptMcpClient(env.SCRYPT_MCP_URL, env.SCRYPT_AUTH);
  const cmds: LoadedCommand[] = [
    buildPingCommand(rest, {
      version: "0.1.0",
      scryptHost: new URL(env.SCRYPT_SERVER_URL).host,
      allowRestart: false,
    }),
  ];
  return {
    commands: buildCommandCollection(cmds),
    rest,
    mcp,
  };
}
