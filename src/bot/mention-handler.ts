// Owner @-mention handler (bot-core). For now it replies with a help overview of the
// registered slash commands and auto-deletes that reply after HELP_TTL_MS to keep channels
// clean. This function is the seam where the future agentic intent-parser (interpret the
// message -> route to Scrypt / Para-RAID / tools) will attach — same signature, same gate.
//
// CATCH SITE NOTE: this handler owns its OWN narrow try/catch (the message-boundary
// equivalent of interaction-router's replyWithError). The message-router stays catch-free,
// so the three catch sites (decision 10) are unchanged.
//
// STATELESS NOTE: the self-delete timer is a transient, per-message UX cleanup — not a
// scheduler/queue/cron (Guidelines §15). It schedules nothing across restarts; if uxie
// restarts inside the window the stray help message simply survives. Acceptable.
import type { Collection, Message } from "discord.js";
import type { LoadedCommand } from "./command-loader.ts";
import type { Logger } from "../lib/log.ts";
import { helpEmbed, type CommandSummary } from "../lib/embed.ts";

export const HELP_TTL_MS = 30_000;

export interface MentionHandlerOpts {
  ttlMs?: number;
  // Injectable so tests fire the deletion deterministically; defaults to setTimeout.
  schedule?: (fn: () => void, ms: number) => void;
}

export async function handleMention(
  msg: Message,
  commands: Collection<string, LoadedCommand>,
  log: Logger,
  opts: MentionHandlerOpts = {},
): Promise<void> {
  const ttlMs = opts.ttlMs ?? HELP_TTL_MS;
  const schedule =
    opts.schedule ??
    ((fn, ms) => {
      setTimeout(fn, ms);
    });
  const scoped = log.child({ messageId: msg.id, channel: msg.channelId, kind: "mention" });
  scoped.info("mention help start");
  try {
    const summaries: CommandSummary[] = [...commands.values()].map((c) => ({
      name: c.data.name,
      description: "description" in c.data ? c.data.description : "",
    }));
    const reply = await msg.reply({
      embeds: [helpEmbed(summaries)],
      allowedMentions: { parse: [] },
    });
    schedule(() => {
      void reply.delete().catch(() => {
        /* best-effort: message may already be gone or perms lost */
      });
    }, ttlMs);
    scoped.info("mention help ok");
  } catch (err) {
    // Best-effort, non-fatal by design: a failed help reply just means the owner re-tags.
    // We log at warn (not error) and never rethrow — this is the message-boundary catch
    // site (decision 10), so nothing may escape into the gateway dispatcher.
    scoped.warn("mention help failed", { err });
  }
}
