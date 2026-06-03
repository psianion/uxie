// /search <query> — FTS5 keyword search over the scrypt vault (Design §6.4).
//
// Strict adapter: read the query option, call mcp.searchNotes(query, 10), render the result
// embed (top-N caps + AttachmentBuilder overflow live in lib/embed — never pagination,
// decision 14), editReply ephemerally with mentions suppressed (decision 8). NO try/catch
// here — interaction-router is the only catch site (decision 10 / UXIE §14.2 + §22). NO
// owner gate here — that is ROUTER-LOCATED (decision 9).
//
// Empty results are a normal outcome, not an error: reply a plain "no matches" and emit the
// closed-vocabulary outcome:"empty" log event (decision 4).
import { SlashCommandBuilder } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import type { ScryptMcpClient } from "../mcp-client.ts";
import { searchResultPayload } from "../../../lib/embed.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";

const LIMIT = 10;

export function buildSearchCommand(mcp: ScryptMcpClient): LoadedCommand {
  return {
    data: withOwnerGate(
      new SlashCommandBuilder()
        .setName("search")
        .setDescription("FTS5 keyword search over the scrypt vault")
        .addStringOption((o) =>
          o.setName("query").setDescription("Search text").setRequired(true),
        ),
    ),
    async execute(i, ctx) {
      const query = i.options.getString("query", true);
      const hits = await mcp.searchNotes(query, LIMIT);
      if (hits.length === 0) {
        ctx.log.info("search", { outcome: "empty" });
        await i.editReply({ content: "no matches", allowedMentions: { parse: [] } });
        return;
      }
      ctx.log.info("search", { results: hits.length });
      const payload = searchResultPayload(query, hits);
      await i.editReply({ ...payload, allowedMentions: { parse: [] } });
    },
  };
}
