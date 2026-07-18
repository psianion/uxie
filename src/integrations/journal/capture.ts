// #journal mirror (journal enrichment #1+#2): every owner message in the journal channel is
// appended to today's scrypt journal — journaling becomes chatting. The returned entry id is
// remembered per message, so a Discord edit PATCHes the entry and a Discord delete removes it:
// the channel is a live mirror of the day file, not a one-way pipe.
//
// A7-style, CRITICAL: like relayMessage, these run on raw gateway events with NO router catch
// site above them — the entire body of each handler is one try/catch; nothing may escape into
// index.ts's unhandledRejection handler.
import { Events, type Client, type Message, type PartialMessage } from "discord.js";
import type { ScryptRestClient } from "../scrypt/rest-client.ts";
import { makeMessageClientTag } from "../../lib/client-tag.ts";
import { log } from "../../lib/log.ts";

export interface JournalMirrorConfig {
  channelId: string;
  ownerId: string;
}

// ponytail: in-memory message→entry map. A restart loses it, so edits/deletes only mirror for
// messages captured since boot — the entries themselves are safe in the vault. Persist the map
// (or resolve by timestamp) if stale-edit mirroring ever matters.
export function startJournalMirror(
  client: Client,
  rest: ScryptRestClient,
  cfg: JournalMirrorConfig,
): { stop(): void; entryCount(): number } {
  const entries = new Map<string, { date: string; entryId: string }>();

  const eligible = (m: Message | PartialMessage): boolean =>
    m.channelId === cfg.channelId && !m.author?.bot && m.author?.id === cfg.ownerId;

  async function onCreate(m: Message): Promise<void> {
    try {
      if (!eligible(m) || !m.content) return;
      const bundle = await rest.journalEntry(m.content, makeMessageClientTag(m));
      const last = bundle.entries[bundle.entries.length - 1];
      if (last) entries.set(m.id, { date: bundle.date, entryId: last.id });
      await m.react("✅").catch(() => {});
      log.info("journal entry mirrored", { messageId: m.id, date: bundle.date });
    } catch (err) {
      log.warn("journal mirror append failed", { messageId: m.id, err });
      await m.react("❌").catch(() => {});
    }
  }

  async function onUpdate(_old: Message | PartialMessage, m: Message | PartialMessage): Promise<void> {
    try {
      const ref = entries.get(m.id);
      // Unmapped (pre-boot or non-journal) or partial-without-content edits are ignored.
      if (!ref || !eligible(m) || !m.content) return;
      await rest.journalEditEntry(ref.date, ref.entryId, m.content, makeMessageClientTag(m));
      log.info("journal entry edited via mirror", { messageId: m.id, date: ref.date });
    } catch (err) {
      log.warn("journal mirror edit failed", { messageId: m.id, err });
    }
  }

  async function onDelete(m: Message | PartialMessage): Promise<void> {
    try {
      const ref = entries.get(m.id);
      if (!ref) return;
      entries.delete(m.id);
      await rest.journalDeleteEntry(ref.date, ref.entryId, makeMessageClientTag(m));
      log.info("journal entry deleted via mirror", { messageId: m.id, date: ref.date });
    } catch (err) {
      log.warn("journal mirror delete failed", { messageId: m.id, err });
    }
  }

  const create = (m: Message) => void onCreate(m);
  const update = (o: Message | PartialMessage, n: Message | PartialMessage) => void onUpdate(o, n);
  const del = (m: Message | PartialMessage) => void onDelete(m);
  client.on(Events.MessageCreate, create);
  client.on(Events.MessageUpdate, update);
  client.on(Events.MessageDelete, del);

  return {
    stop() {
      client.off(Events.MessageCreate, create);
      client.off(Events.MessageUpdate, update);
      client.off(Events.MessageDelete, del);
    },
    entryCount: () => entries.size,
  };
}
