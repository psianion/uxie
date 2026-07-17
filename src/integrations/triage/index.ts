// Triage module entry. Borrows the para-raid client (create-once-share-everywhere, same as
// sup); owns nothing live. Callers gate construction on paraRaidEnabled(env) AND a non-empty
// guildConfig.triageChannelId — off means the command is neither deployed nor routed.
import { buildCommandCollection, type MessageCommand } from "../../bot/command-loader.ts";
import type { Collection } from "discord.js";
import type { ParaRaidClient } from "../para-raid/client.ts";
import { buildTriageCommand, type TriageOpts } from "./command.ts";

export interface TriageModule {
  messageCommands: Collection<string, MessageCommand>;
}

export function buildTriageModule(api: ParaRaidClient, opts: TriageOpts): TriageModule {
  return { messageCommands: buildCommandCollection([buildTriageCommand(api, opts)]) };
}
