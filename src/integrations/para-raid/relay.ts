// MessageCreate relay (D1): owner messages in a known session thread become send_turn calls.
// A7, CRITICAL: the ENTIRE body is one try/catch. This is NOT dispatched through the
// interaction router — its catch site only covers Interactions (bot/interaction-router.ts) —
// and an unhandled rejection here would hit index.ts's unhandledRejection handler and exit the
// process (index.ts:29-32). Nothing may escape relayMessage.
import type { Client, Message, MessageReaction } from "discord.js";
import type { ParaRaidClient } from "./client.ts";
import type { SessionCache } from "./sessions.ts";
import { PAUSED_HINT } from "./events.ts";
import { log } from "../../lib/log.ts";

export interface RelayDeps {
  client: Client;
  api: ParaRaidClient;
  sessions: SessionCache;
  ownerId: string;
}

export async function relayMessage(message: Message, deps: RelayDeps): Promise<void> {
  let pending: MessageReaction | null = null;
  try {
    if (message.author.bot) return;
    if (message.author.id !== deps.ownerId) return;
    if (!message.content) return;
    if (!message.channel.isThread()) return;

    const session = await deps.sessions.resolveByThread(message.channel.id);
    if (!session) return; // not a known para-raid session thread — ignore silently

    pending = await message.react("⏳").catch(() => null);
    const res = await deps.api.sendTurn({ session_id: session.id, prompt: message.content });

    if (res.status === 503) {
      await fail(message, pending, PAUSED_HINT);
    } else if (res.status === 404) {
      // session_not_live: our cached entry is stale — and a plain re-resolve would HIT that same
      // stale entry. Evict it so the next message in this thread misses → refreshes → sees truth.
      deps.sessions.invalidate(session.id);
      await fail(message, pending, "session is no longer live — run /raid status or open a new one");
    } else if (res.status >= 400) {
      await fail(message, pending, `send_turn failed (${res.status})`);
    }
  } catch (err) {
    log.error("para-raid relay failed", { err });
    await fail(message, pending, "internal error relaying to para-raid");
  }
}

async function fail(message: Message, pending: MessageReaction | null, reason: string): Promise<void> {
  await pending?.users.remove(message.client.user.id).catch(() => {});
  await message.react("❌").catch(() => {});
  await message.reply(reason).catch(() => {});
}
