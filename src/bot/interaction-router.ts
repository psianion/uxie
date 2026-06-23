// Catch site #1 of 3 (ratified decision 10): the whole-body try/catch for every slash
// command. Command bodies stay try/catch-free; all faults funnel here.
//
// Owner gate is ROUTER-LOCATED and fires BEFORE deferReply (decision 9): a non-owner is
// rejected with i.reply (NOT editReply) and the command never runs / never defers.
//
// Every ephemeral payload uses { flags: MessageFlags.Ephemeral } — never the deprecated
// boolean ephemeral:true (decision 8). replyWithError can never throw: each Discord call
// is defensively .catch()ed (decision 10) so a failed acknowledgement (e.g. a 10062
// expired interaction) can't escape into the gateway dispatcher.
import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Collection,
  type Interaction,
} from "discord.js";
import { UxieError, NotOwnerError, ScryptError } from "../lib/errors.ts";
import { assertOwner } from "../lib/auth.ts";
import { makeClientTag } from "../lib/client-tag.ts";
import { log } from "../lib/log.ts";
import type { LoadedCommand } from "./command-loader.ts";

interface ScopedLogger {
  info: (m: string, f?: Record<string, unknown>) => void;
  warn: (m: string, f?: Record<string, unknown>) => void;
  error: (m: string, f?: Record<string, unknown>) => void;
}

export async function handleInteraction(
  i: Interaction,
  commands: Collection<string, LoadedCommand>,
  ownerId: string,
): Promise<void> {
  if (!i.isChatInputCommand()) return;
  const cmd = commands.get(i.commandName);
  if (!cmd) return;

  const ci = i as ChatInputCommandInteraction;
  const clientTag = makeClientTag(i);
  const scoped = log.child({ interactionId: i.id, command: i.commandName, clientTag });

  try {
    // Decision 9: gate BEFORE defer. Non-owner -> NotOwnerError -> pre-defer i.reply path.
    assertOwner(i, ownerId);
    scoped.info("command start");
    // Components V2 commands (defer:false) must set IsComponentsV2 at reply time, which a
    // pre-created deferred placeholder can't carry — so they own their single reply.
    if (cmd.defer !== false) {
      await ci.deferReply({ flags: MessageFlags.Ephemeral });
    }
    await cmd.execute(ci, { clientTag, log: scoped });
    scoped.info("command ok");
  } catch (err) {
    await replyWithError(ci, err, scoped);
  }
}

// Maps an error to a user-facing message and acknowledges the interaction. NEVER throws:
// each Discord call is wrapped in safeReply / safeEdit which swallow their own rejection.
async function replyWithError(
  i: ChatInputCommandInteraction,
  err: unknown,
  scoped: ScopedLogger,
): Promise<void> {
  if (err instanceof NotOwnerError) {
    scoped.info("not owner");
    // Pre-defer path: the gate ran before defer, so use reply, not editReply.
    if (!i.deferred && !i.replied) {
      await safeReply(i, "not for you");
    }
    return;
  }
  if (err instanceof ScryptError) {
    scoped.warn("scrypt error", { err });
    await ack(i, err.message);
    return;
  }
  if (err instanceof UxieError) {
    scoped.warn("uxie error", { err });
    await ack(i, `uxie: ${err.message}`);
    return;
  }
  scoped.error("unhandled", { err });
  await ack(i, "uxie crashed, check logs");
}

// editReply if we already deferred, otherwise an ephemeral reply.
async function ack(i: ChatInputCommandInteraction, msg: string): Promise<void> {
  if (i.deferred) {
    await safeEdit(i, msg);
  } else {
    await safeReply(i, msg);
  }
}

async function safeEdit(i: ChatInputCommandInteraction, msg: string): Promise<void> {
  await i.editReply(msg).catch(() => {});
}

async function safeReply(i: ChatInputCommandInteraction, msg: string): Promise<void> {
  await i
    .reply({ content: msg, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } })
    .catch(() => {});
}
