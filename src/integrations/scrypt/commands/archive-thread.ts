// /archive-thread — run inside a thread to compile its whole conversation into a markdown
// transcript and file it into the vault via the same create_note write path as /capture.
// Owner gate + defer are router-located (decisions 9/10); the body stays try/catch-free —
// a thrown ConfigError/ScryptError funnels to the router. Retry-safe via ctx.clientTag:
// create_note dedups by client_tag server-side, so a Discord retry replays the cached write.
import { SlashCommandBuilder } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";
import { ConfigError } from "../../../lib/errors.ts";
import type { ScryptRestClient } from "../rest-client.ts";

const MSG_CAP = 500; // ponytail: hard cap — don't drown the vault (or memory) on a giant thread
const BODY_MAX = 60_000; // ponytail: clip from the END (keep newest) if create_note body would be huge

export function buildArchiveThreadCommand(rest: ScryptRestClient): LoadedCommand {
  return {
    data: withOwnerGate(
      new SlashCommandBuilder()
        .setName("archive-thread")
        .setDescription("Archive this thread's conversation into the scrypt vault")
        .addStringOption((o) =>
          o.setName("title").setDescription("Override the note title").setRequired(false),
        ),
    ),
    async execute(i, ctx) {
      const channel = i.channel;
      if (!channel?.isThread()) {
        throw new ConfigError("archive_not_thread", "run this inside a thread");
      }

      // Page backwards (fetch returns newest-first) until exhausted or the cap trips.
      const collected: any[] = [];
      let before: string | undefined;
      let truncated = false;
      while (true) {
        const page = await channel.messages.fetch({ limit: 100, before });
        const msgs = [...page.values()];
        if (msgs.length === 0) break;
        collected.push(...msgs);
        before = msgs[msgs.length - 1]!.id;
        if (collected.length >= MSG_CAP) {
          truncated = true;
          break;
        }
        if (msgs.length < 100) break; // short page ⇒ no older history left
      }

      const chronological = collected.slice(0, MSG_CAP).reverse();
      const kept = chronological.filter(
        (m) => (m.content && m.content.length > 0) || m.attachments?.size > 0,
      );

      const participants = [...new Set(kept.map((m) => m.author?.username ?? "unknown"))];
      const header = [
        `# ${channel.name}`,
        channel.parentId ? `channel: <#${channel.parentId}>` : null,
        `participants: ${participants.join(", ")}`,
        `messages: ${kept.length}`,
        truncated ? `_(older history beyond ${MSG_CAP} messages was truncated)_` : null,
      ]
        .filter((l) => l !== null)
        .join("\n");

      const blocks = kept.map((m) => {
        const time = m.createdAt.toISOString().slice(11, 16); // HH:MM (UTC, ISO-ish)
        const lines = [`**${m.author?.username ?? "unknown"}** (${time}):`, m.content ?? ""];
        for (const a of m.attachments?.values?.() ?? []) {
          lines.push(`- attachment: ${a.name}: ${a.url}`);
        }
        return lines.join("\n");
      });

      let body = `${header}\n\n${blocks.join("\n\n")}`;
      if (body.length > BODY_MAX) {
        body = `${header}\n\n_(transcript clipped to newest ~${BODY_MAX} chars)_\n\n${body.slice(-BODY_MAX)}`;
      }

      const { path } = await rest.createNote({
        title: i.options.getString("title") ?? channel.name,
        content: body,
        clientTag: ctx.clientTag,
      });
      await i.editReply(`archived ${kept.length} messages → \`${path}\``);
    },
  };
}
