// /journal <text> — append a line to today's journal (Design §6.6).
//
// Strict adapter: read the text option, call rest.ingest({ kind: "journal", ... }) with the
// deterministic clientTag (decision 3) and USER_TZ, then editReply a confirmation stamped
// with the USER_TZ-local date/time. NO try/catch here — interaction-router is the only catch
// site (decision 10 / UXIE §14.2 + §22). NO owner gate here — that is ROUTER-LOCATED
// (decision 9). The reply is ephemeral (the router deferred ephemerally) with mentions
// suppressed (decision 8).
//
// tz handling (contract BLOCKER 1): the SERVER stamps the stored journal entry in UTC and
// ignores any tz hint. `tz: userTz` is still passed to ingest (uxie-facing), but rest-client
// deliberately does NOT forward it to the journal body — it only shapes uxie's own reply
// text here via nowInZone, so the owner sees their local time even though the vault stores
// UTC.
import { SlashCommandBuilder } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import type { ScryptRestClient } from "../rest-client.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";
import { nowInZone } from "../../../lib/tz.ts";

export function buildJournalCommand(rest: ScryptRestClient, userTz: string): LoadedCommand {
  return {
    data: withOwnerGate(
      new SlashCommandBuilder()
        .setName("journal")
        .setDescription("Append a line to today's journal")
        .addStringOption((o) => o.setName("text").setDescription("Journal entry").setRequired(true)),
    ),
    async execute(i, ctx) {
      const text = i.options.getString("text", true);
      const out = await rest.ingest({
        kind: "journal",
        content: text,
        clientTag: ctx.clientTag,
        tz: userTz,
      });
      const { date, time } = nowInZone(userTz);
      ctx.log.info("journal", { path: out.path });
      await i.editReply({
        content: `📓 appended to \`${out.path}\` at ${date} ${time} ${userTz}`,
        allowedMentions: { parse: [] },
      });
    },
  };
}
