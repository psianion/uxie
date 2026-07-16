// /journal <text> — append an entry to today's (UTC) journal day file via the new journal
// surface (POST /api/journal/:date/entries — kind:journal was removed from /api/ingest).
// Owner gate + defer are router-located; ScryptError funnels to the router catch.
import { SlashCommandBuilder, time } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";
import type { ScryptRestClient } from "../rest-client.ts";

export function buildJournalCommand(rest: ScryptRestClient): LoadedCommand {
  return {
    data: withOwnerGate(
      new SlashCommandBuilder()
        .setName("journal")
        .setDescription("Append an entry to today's journal in scrypt")
        .addStringOption((o) =>
          o.setName("text").setDescription("Journal entry").setRequired(true),
        ),
    ),
    async execute(i, ctx) {
      const text = i.options.getString("text", true);
      const bundle = await rest.journalEntry(text, ctx.clientTag);
      // The appended entry is the bundle's last one; its id is the server-stamped UTC ISO
      // instant — render it in the viewer's timezone via a Discord timestamp.
      const last = bundle.entries[bundle.entries.length - 1];
      const stamp = last ? ` at ${time(new Date(last.id), "t")}` : "";
      const n = bundle.entries.length;
      await i.editReply(
        `journal ${bundle.date} — entry #${n} added${stamp} (\`journal/${bundle.date}.md\`)`,
      );
    },
  };
}
