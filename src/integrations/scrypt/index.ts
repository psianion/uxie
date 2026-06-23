// scrypt module entry. Builds the REST + MCP clients from validated env and the command
// collection. The module owns its clients and commands; the boot path wires the command
// collection into the interaction-router. Only /ping is wired today, but the full connection
// layer (REST write/health + MCP read) is constructed and kept ready for the commands being
// rebuilt next.
import { hostname } from "node:os";
import { Collection } from "discord.js";
import { buildCommandCollection, type LoadedCommand } from "../../bot/command-loader.ts";
import type { ComponentHandler } from "../../bot/interaction-router.ts";
import { ScryptRestClient } from "./rest-client.ts";
import { ScryptMcpClient } from "./mcp-client.ts";
import { buildPingCommand } from "./commands/ping.ts";
import { buildPingComponentHandler } from "./ping/handler.ts";
import type { Env } from "../../lib/env.ts";

export interface ScryptModule {
  commands: ReturnType<typeof buildCommandCollection>;
  components: Collection<string, ComponentHandler>;
  rest: ScryptRestClient;
  mcp: ScryptMcpClient;
}

const VERSION = "0.1.0";

export function buildScryptModule(env: Env): ScryptModule {
  const rest = new ScryptRestClient(env.SCRYPT_SERVER_URL, env.SCRYPT_AUTH);
  // Reads use the MCP streamable-http endpoint (decision 2 / scrypt-contract §2); writes use
  // REST. Same SCRYPT_AUTH bearer; different base URL.
  const mcp = new ScryptMcpClient(env.SCRYPT_MCP_URL, env.SCRYPT_AUTH);

  const pingOpts = {
    version: VERSION,
    scryptHost: new URL(env.SCRYPT_SERVER_URL).host,
    allowRestart: env.ALLOW_SCRYPT_RESTART,
    // "<env label> · <machine hostname>" — tells you at a glance whether the responding
    // instance is local or the VPS (a token holds one live gateway connection at a time).
    host: `${env.UXIE_ENV} · ${hostname()}`,
  };

  const cmds: LoadedCommand[] = [buildPingCommand(rest, pingOpts)];

  // Restart deps are wired ONLY when the capability is enabled; secrets are passed so any
  // restart stderr surfaced to the owner is redacted of them.
  const pingHandler = buildPingComponentHandler(
    rest,
    pingOpts,
    env.ALLOW_SCRYPT_RESTART
      ? { command: env.SCRYPT_RESTART_CMD, secrets: [env.SCRYPT_AUTH, env.DISCORD_BOT_TOKEN] }
      : undefined,
  );
  const components = new Collection<string, ComponentHandler>();
  components.set(pingHandler.namespace, pingHandler);

  return {
    commands: buildCommandCollection(cmds),
    components,
    rest,
    mcp,
  };
}
