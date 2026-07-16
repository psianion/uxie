// /search <query> — hybrid (BM25 + embedding) vault search rendered as a Components V2
// panel (same kit as /ping). Like /ping it opts out of auto-defer: IsComponentsV2 must be
// set at reply time, which a deferred placeholder can't carry — hence the client's 2.5s
// search timeout so the whole command beats Discord's 3s initial-response window. A thrown
// ScryptError still funnels to the router catch (pre-defer → ephemeral reply path).
//
// CONFIDENCE GATE: never render junk. RRF (k=60) scores each hit as the sum of 1/(60+rank)
// per ranker, so a hit surfaced by only ONE ranker tops out at 1/61 ≈ 0.0164 (rank 1 in
// that ranker, absent from the other), while any hit BOTH rankers returned scores at least
// 1/85 + 1/85 ≈ 0.0235 within the 25-hit limit. Requiring the TOP score strictly above
// 1/61 therefore means "two independent signals agree" — the cheapest high-confidence test.
// Side effect (deliberate): when the embedder is down every hit is single-source, so the
// gate answers "no confident match" instead of serving FTS-only guesses.
import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";
import { buildStatusContainer, type StatusModel } from "../../../lib/ui/status-container.ts";
import type { HybridHit } from "../schemas.ts";
import type { ScryptRestClient } from "../rest-client.ts";

export const MIN_CONFIDENT_SCORE = 1 / 61;

const LIMIT = 5;
const DESC_MAX = 90;

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// Pure hits → StatusModel mapping (unit-testable without a live client).
export function buildSearchModel(query: string, hits: HybridHit[]): StatusModel {
  return {
    title: "Uxie · Search",
    health: "ok",
    badge: `${hits.length} hit${hits.length === 1 ? "" : "s"}`,
    rows: hits.map((h) => ({
      icon: "📄",
      label: clip(h.title, 60),
      value: `${h.project ?? "—"}/${h.doc_type ?? "—"} · ${clip(h.description ?? h.excerpt, DESC_MAX)}\n\`${h.path}\``,
    })),
    footer: `query: ${clip(query, 80)}`,
  };
}

export function buildSearchCommand(rest: ScryptRestClient): LoadedCommand {
  return {
    defer: false,
    data: withOwnerGate(
      new SlashCommandBuilder()
        .setName("search")
        .setDescription("Search the scrypt vault (hybrid keyword + semantic)")
        .addStringOption((o) =>
          o.setName("query").setDescription("What to look for").setRequired(true),
        ),
    ),
    async execute(i, ctx) {
      const query = i.options.getString("query", true);
      const res = await rest.hybridSearch(query, { limit: LIMIT, clientTag: ctx.clientTag });

      const top = res.hits[0];
      if (!top || top.score <= MIN_CONFIDENT_SCORE) {
        await i.reply({
          content: "no confident match — try `/raid` for a deep answer",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await i.reply({
        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
        components: [buildStatusContainer(buildSearchModel(res.query, res.hits))],
      });
    },
  };
}
