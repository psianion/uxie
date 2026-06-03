// /brief — today's scrypt daily brief (Design §6.5). MANUAL ONLY: there is no scheduler
// (decision 16 — uxie is stateless: no caches, no queues, no scheduler). The owner runs
// /brief on demand.
//
// Strict adapter: call rest.getDailyContext(), compute the USER_TZ-local "today" for the
// title (so the brief shows the owner's local date, not the bot host's UTC date), render
// briefEmbed, editReply ephemerally with mentions suppressed (decision 8). NO try/catch here
// — interaction-router is the only catch site (decision 10 / UXIE §14.2 + §22). NO owner
// gate here — that is ROUTER-LOCATED (decision 9).
import { SlashCommandBuilder } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import type { ScryptRestClient } from "../rest-client.ts";
import { briefEmbed } from "../../../lib/embed.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";
import { journalDateKey } from "../../../lib/tz.ts";

export function buildBriefCommand(rest: ScryptRestClient, userTz: string): LoadedCommand {
  return {
    data: withOwnerGate(
      new SlashCommandBuilder().setName("brief").setDescription("Today's scrypt daily brief"),
    ),
    async execute(i, ctx) {
      const daily = await rest.getDailyContext();
      const date = journalDateKey(userTz);
      ctx.log.info("brief", {
        threads: daily.open_threads.length,
        recent: daily.recent_notes.length,
        memories: daily.active_memories.length,
      });
      await i.editReply({ embeds: [briefEmbed(daily, date)], allowedMentions: { parse: [] } });
    },
  };
}
