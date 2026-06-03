// /ask <query> — semantic search over the scrypt vault (Design §6.3).
//
// Strict adapter: read the query option, call mcp.semanticSearch(query, 5), render the
// semantic embed where the note paths are the citations (top-N caps + AttachmentBuilder
// overflow live in lib/embed — never pagination, decision 14), editReply ephemerally with
// mentions suppressed (decision 8). NO try/catch here — interaction-router is the only catch
// site (decision 10 / UXIE §14.2 + §22). NO owner gate here — ROUTER-LOCATED (decision 9).
//
// Empty results are a normal outcome, not an error: reply a plain "no matches" and emit the
// closed-vocabulary outcome:"empty" log event (decision 4).
import { SlashCommandBuilder } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import type { ScryptMcpClient } from "../mcp-client.ts";
import { semanticResultPayload } from "../../../lib/embed.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";

const LIMIT = 5;

export function buildAskCommand(mcp: ScryptMcpClient): LoadedCommand {
  return {
    data: withOwnerGate(
      new SlashCommandBuilder()
        .setName("ask")
        .setDescription("Semantic search over the scrypt vault")
        .addStringOption((o) =>
          o.setName("query").setDescription("Natural-language query").setRequired(true),
        ),
    ),
    async execute(i, ctx) {
      const query = i.options.getString("query", true);
      const hits = await mcp.semanticSearch(query, LIMIT);
      if (hits.length === 0) {
        ctx.log.info("ask", { outcome: "empty" });
        await i.editReply({ content: "no matches", allowedMentions: { parse: [] } });
        return;
      }
      ctx.log.info("ask", { results: hits.length });
      const payload = semanticResultPayload(query, hits);
      await i.editReply({ ...payload, allowedMentions: { parse: [] } });
    },
  };
}
