// scrypt module entry. Builds the REST client from validated env, the command collection
// (/ping + /capture in Wave 2), and the #inbox handler. The module owns its clients and
// commands; the boot path only calls buildScryptModule and wires the resulting collection
// into the interaction-router and the onInbox callback into the message-router.
import { buildCommandCollection, type LoadedCommand } from "../../bot/command-loader.ts";
import { ScryptRestClient } from "./rest-client.ts";
import { buildPingCommand } from "./commands/ping.ts";
import { buildCaptureCommand } from "./commands/capture.ts";
import { handleInboxMessage } from "./inbox-handler.ts";
import type { Env } from "../../lib/env.ts";
import type { Message } from "discord.js";
import { log } from "../../lib/log.ts";

export interface ScryptModule {
  commands: ReturnType<typeof buildCommandCollection>;
  rest: ScryptRestClient;
  onInbox: (msg: Message) => Promise<void>;
}

export function buildScryptModule(env: Env): ScryptModule {
  const rest = new ScryptRestClient(env.SCRYPT_SERVER_URL, env.SCRYPT_AUTH);
  const cmds: LoadedCommand[] = [buildPingCommand(rest), buildCaptureCommand(rest)];
  return {
    commands: buildCommandCollection(cmds),
    rest,
    onInbox: (msg) => handleInboxMessage(msg, rest, log),
  };
}
