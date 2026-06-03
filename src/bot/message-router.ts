// messageCreate boundary — #inbox passive capture only (Design §6.2 / decision 10).
//
// This is CATCH SITE #2 of 3 (decision 10): interaction-router (#1), message-router (#2),
// src/index.ts top-level process.on (#3). Command/handler bodies stay try/catch-free; any
// fault from the inbox handler funnels here and is swallowed+logged so it can never escape
// into the gateway dispatcher (a throw out of a discord.js event listener becomes an
// unhandledRejection -> process.exit(1) via catch site #3, which we must not trigger on a
// routine ingest failure).
//
// Gate (router-located, decision 9): not-a-bot, owner-only, channel == INBOX_CHANNEL_ID,
// non-empty. Non-matching messages are SILENTLY dropped (no reaction) — the ✅/❌ ack is
// reserved for messages we actually attempt to capture (Design §6.2). The owner check is
// the message-shaped half of the same allowlist the interaction-router enforces.
import type { Message } from "discord.js";
import { isInboxChannel } from "../integrations/scrypt/channels.ts";
import { log } from "../lib/log.ts";

export interface MessageRouterConfig {
  ownerId: string;
  inboxId: string;
}

export async function handleMessage(
  msg: Message,
  cfg: MessageRouterConfig,
  onInbox: (msg: Message) => Promise<void>,
): Promise<void> {
  if (msg.author.bot) return;
  if (msg.author.id !== cfg.ownerId) return;
  if (!isInboxChannel(msg.channelId, cfg.inboxId)) return;
  if (!msg.content || msg.content.trim() === "") return;

  try {
    await onInbox(msg);
  } catch (err) {
    // Defensive: the inbox handler already owns a try/catch that reacts ❌, but the catch
    // site must never let anything escape (decision 10). Anything reaching here is a
    // handler bug, not a routine scrypt fault.
    log.error("message-router unhandled", { messageId: msg.id, err });
  }
}
