// /journal — two legs over the scrypt journal surface:
//   add text:<required>  — append an entry to today's (UTC) day file (POST /api/journal/:date/
//                          entries) and confirm with the server-stamped time.
//   read [date]          — render a browsable day panel (Components V2) with prev/next buttons.
// Auto-defer shape (like /sup): journalDay's 5s budget doesn't fit Discord's 3s ack window, so
// the router defers first and we editReply the V2 container. Owner gate + defer are router-
// located; ScryptError/ConfigError funnel to the router catch — no try/catch here.
import { MessageFlags, SlashCommandBuilder, time } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";
import { ConfigError } from "../../../lib/errors.ts";
import { buildStatusContainer } from "../../../lib/ui/status-container.ts";
import { journalDayModel } from "../journal/panel.ts";
import { utcToday, type ScryptRestClient } from "../rest-client.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function buildJournalCommand(rest: ScryptRestClient): LoadedCommand {
  return {
    data: withOwnerGate(
      new SlashCommandBuilder()
        .setName("journal")
        .setDescription("Journal in scrypt")
        .addSubcommand((sc) =>
          sc
            .setName("add")
            .setDescription("Append an entry to today's journal")
            .addStringOption((o) => o.setName("text").setDescription("Journal entry").setRequired(true)),
        )
        .addSubcommand((sc) =>
          sc
            .setName("read")
            .setDescription("Browse a journal day")
            .addStringOption((o) => o.setName("date").setDescription("YYYY-MM-DD (default: today, UTC)")),
        ),
    ),
    async execute(i, ctx) {
      if (i.options.getSubcommand() === "add") {
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
        return;
      }

      const date = i.options.getString("date") ?? utcToday();
      if (!DATE_RE.test(date)) {
        throw new ConfigError("journal_bad_date", `not a YYYY-MM-DD date: ${date}`);
      }
      const bundle = await rest.journalDay(date, ctx.clientTag);
      await i.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [buildStatusContainer(journalDayModel(bundle))],
      });
    },
  };
}
