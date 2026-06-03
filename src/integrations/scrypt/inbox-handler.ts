// #inbox passive capture handler (Design §6.2). Posting a message in #inbox ingests it as
// a note into notes/inbox/; the "reply" is a ✅ / ❌ reaction (deliberate v1 simplification
// to minimise channel noise — no embed echo).
//
// CATCH SITE NOTE: this handler owns its OWN narrow try/catch because the user-facing
// acknowledgement is a reaction, not an editReply — it is the message-boundary equivalent
// of interaction-router's replyWithError. The message-router itself stays catch-free; the
// only other scrypt-call catch sites are the two routers (decision 10). The clientTag is
// the deterministic uxie-msg-<id> (decision 3) so scrypt's server-side dedup turns a retry
// (re-posting the same message) into a no-op.
import type { Message } from "discord.js";
import type { ScryptRestClient } from "./rest-client.ts";
import { makeMessageClientTag } from "../../lib/client-tag.ts";
import type { Logger } from "../../lib/log.ts";

export async function handleInboxMessage(
  msg: Message,
  rest: ScryptRestClient,
  log: Logger,
): Promise<void> {
  const clientTag = makeMessageClientTag(msg);
  const scoped = log.child({ messageId: msg.id, channel: "inbox", clientTag });
  scoped.info("inbox start");
  try {
    const out = await rest.ingest({
      kind: "note",
      content: msg.content,
      clientTag,
    });
    await msg.react("✅");
    scoped.info("inbox ok", { path: out.path });
  } catch (err) {
    scoped.warn("inbox failed", { err });
    // The ❌ react is itself best-effort: a failed reaction (e.g. lost perms) must not
    // escape into the gateway dispatcher, so swallow its rejection.
    try {
      await msg.react("❌");
    } catch {
      /* react failed; already logged the underlying failure above */
    }
  }
}
