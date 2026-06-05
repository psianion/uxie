// messageCreate boundary — owner @-mention trigger, server-wide (mention-trigger spec).
// Replaces the #inbox channel capture model.
//
// CATCH SITE #2 of 3 (decision 10): interaction-router (#1), message-router (#2),
// src/index.ts process.on (#3). The onMention handler owns its own try/catch; this router
// additionally guarantees nothing escapes into the gateway dispatcher (a throw out of a
// discord.js listener becomes an unhandledRejection -> process.exit(1) via catch site #3).
//
// Gate (router-located, decision 9): not-a-bot, owner-only, and a DIRECT @-mention of uxie
// (an @everyone / role / replied-user ping does NOT count). Non-matching messages are
// silently dropped — no reply, no reaction.
import type { Message } from "discord.js";
import { log } from "../lib/log.ts";

export interface MessageRouterConfig {
  ownerId: string;
}

export async function handleMessage(
  msg: Message,
  cfg: MessageRouterConfig,
  onMention: (msg: Message) => Promise<void>,
): Promise<void> {
  if (msg.author.bot) return;
  if (msg.author.id !== cfg.ownerId) return;
  const me = msg.client.user;
  if (!me) return; // gateway not READY yet
  if (!msg.mentions.has(me.id, { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true })) {
    return;
  }

  try {
    await onMention(msg);
  } catch (err) {
    // Defensive: onMention owns a try/catch, but the catch site must never let anything
    // escape (decision 10). Anything reaching here is a handler bug, not a routine fault.
    log.error("message-router unhandled", { messageId: msg.id, err });
  }
}
