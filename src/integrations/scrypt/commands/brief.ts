// /brief — today's context from GET /api/daily-context (canonical hyphen path): journal
// presence, recent notes, open threads. Plain markdown editReply — deliberately simple; the
// Components V2 upgrade can come when /brief needs progressive disclosure. Owner gate +
// defer are router-located; ScryptError funnels to the router catch.
import { SlashCommandBuilder } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";
import type { DailyContextResponse } from "../schemas.ts";
import type { ScryptRestClient } from "../rest-client.ts";

const MAX_ITEMS = 5;
const REPLY_MAX = 2000;

// Pure render (unit-testable without a live client).
export function renderBrief(dc: DailyContextResponse): string {
  const lines: string[] = [`**Daily brief — ${dc.today.date}**`];

  lines.push(
    dc.today.journal.exists
      ? `📓 journal started today (\`${dc.today.journal.path}\`)`
      : "📓 no journal entry yet today",
  );

  lines.push("", `**Recent notes** (${dc.recent_notes.length})`);
  if (dc.recent_notes.length === 0) {
    lines.push("-# nothing modified in the last 24h");
  }
  for (const n of dc.recent_notes.slice(0, MAX_ITEMS)) {
    lines.push(`• ${n.title} — \`${n.path}\``);
  }

  lines.push("", `**Open threads** (${dc.open_threads.length})`);
  if (dc.open_threads.length === 0) {
    lines.push("-# none");
  }
  for (const t of dc.open_threads.slice(0, MAX_ITEMS)) {
    lines.push(`• ${t.title} — ${t.status}`);
  }

  return lines.join("\n").slice(0, REPLY_MAX);
}

export function buildBriefCommand(rest: ScryptRestClient): LoadedCommand {
  return {
    data: withOwnerGate(
      new SlashCommandBuilder()
        .setName("brief")
        .setDescription("Today's scrypt context: journal, recent notes, open threads"),
    ),
    async execute(i, ctx) {
      const dc = await rest.dailyContext(ctx.clientTag);
      await i.editReply(renderBrief(dc));
    },
  };
}
