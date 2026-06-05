// Pure embed builders (no IO) — UXIE-DISCORD-GUIDELINES §8 + ratified decision 14.
//
// v1 ships **classic embeds only**. Components V2 builders (ContainerBuilder,
// SectionBuilder, TextDisplayBuilder, etc.) are USE LATER (v1.5+) and are **mutually
// exclusive** with `embeds` in the same message — Discord rejects mixed payloads at
// runtime. Do NOT import them here (UXIE §8 + discordjs-api-surface §6).
//
// Conventions enforced here so the command files cannot drift:
//   - ONE accent color across every embed (ACCENT).
//   - Discord field caps: title 256, description 4096 (we leave slack), fields 25.
//   - Web-UI permalinks: a real http(s) permalink becomes a tappable title via setURL
//     (UXIE §8 "setURL on the embed title gives a tappable header"); a degraded raw path
//     is shown in the body only.
//   - Renderers are pure: they take data, never perform IO. Overflow handling for the
//     read commands (Wave 3) uses top-N caps + an AttachmentBuilder overflow file, never
//     pagination (decision 14) — added alongside searchResultEmbed.
import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import type { SearchHit, SemanticHit } from "../integrations/scrypt/mcp-client.ts";
import type { DailyContext } from "../integrations/scrypt/rest-client.ts";

// Single accent color for every uxie embed (decision 14). Discord blurple.
export const ACCENT = 0x5865f2;

export const TITLE_CAP = 256;
export const DESC_CAP = 4000; // 4096 theoretical, leave slack
export const FIELD_CAP = 1000; // per-field render budget (Discord hard cap is 1024)
export const FIELD_VALUE_CAP = 1024; // Discord's absolute field-value limit
// Placeholder for an empty field value: Discord rejects "" but accepts a non-empty string.
const EMPTY_FIELD = "_(none)_";

// Top-N cap for the read commands (decision 14): the embed shows at most TOP_N hit lines;
// anything beyond spills into a single .txt AttachmentBuilder. We NEVER paginate (no
// Discord component pager) — overflow is a one-shot file the owner can scroll locally.
export const TOP_N = 10;

// Deterministic truncation (no randomness, so tests are stable). Reserves one char for the
// ellipsis so the result never exceeds `n`.
export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…";
}

// A permalink is only a tappable link if it is an absolute http(s) URL. When the contract
// permalink scheme degraded to a raw vault path (scrypt-contract §3 BLOCKER), we keep it in
// the body but do not call setURL (Discord rejects a non-URL title link).
function asHttpUrl(permalink: string): string | undefined {
  return /^https?:\/\//i.test(permalink) ? permalink : undefined;
}

// /capture + #inbox success embed (Design §6.1). Shows the vault path and the permalink;
// title links to the web UI when available.
export function captureEmbed(r: { path: string; permalink: string }): EmbedBuilder {
  const url = asHttpUrl(r.permalink);
  const e = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(truncate("captured", TITLE_CAP))
    .setDescription(truncate(`\`${r.path}\`\n${r.permalink}`, DESC_CAP));
  if (url) e.setURL(url);
  return e;
}

// A command reply payload: the visible embed(s) plus an optional overflow attachment.
// Returned by the *Payload helpers so the /search + /ask command bodies can editReply a
// single object. `files` is present only when hits exceeded TOP_N (decision 14).
export interface ResultPayload {
  embeds: EmbedBuilder[];
  files?: AttachmentBuilder[];
}

// /search result embed (Design §6.4). FTS5 keyword hits. Pure (no IO): caps the visible
// lines to TOP_N and the whole description to DESC_CAP. Overflow handling lives in
// searchResultPayload so this stays a plain renderer the tests can toJSON().
export function searchResultEmbed(query: string, hits: SearchHit[]): EmbedBuilder {
  const e = new EmbedBuilder().setColor(ACCENT).setTitle(truncate(`search: ${query}`, TITLE_CAP));
  if (hits.length === 0) return e.setDescription("no matches");
  const lines = hits
    .slice(0, TOP_N)
    .map((h) => `• \`${h.note_path}\` — ${truncate(h.match_preview, 180)}`);
  return e.setDescription(truncate(lines.join("\n"), DESC_CAP));
}

// /ask result embed (Design §6.3). Semantic hits with a similarity score + chunk preview
// (the "citations" are the note paths). Same TOP_N + DESC_CAP discipline as search.
export function semanticResultEmbed(query: string, hits: SemanticHit[]): EmbedBuilder {
  const e = new EmbedBuilder().setColor(ACCENT).setTitle(truncate(`ask: ${query}`, TITLE_CAP));
  if (hits.length === 0) return e.setDescription("no matches");
  const lines = hits
    .slice(0, TOP_N)
    .map((h) => `• \`${h.note_path}\` (${h.score.toFixed(2)}) — ${truncate(h.chunk_text, 200)}`);
  return e.setDescription(truncate(lines.join("\n"), DESC_CAP));
}

// Build a single .txt overflow attachment listing every hit (used when hits > TOP_N). This
// is the only place an AttachmentBuilder is constructed for reads; still pure (no IO — the
// buffer is in-memory and discord.js does the upload on editReply).
function overflowFile(name: string, body: string): AttachmentBuilder {
  return new AttachmentBuilder(Buffer.from(body, "utf8"), { name });
}

// /search reply payload: embed (TOP_N visible) + overflow .txt when there are more hits.
export function searchResultPayload(query: string, hits: SearchHit[]): ResultPayload {
  const embed = searchResultEmbed(query, hits);
  if (hits.length <= TOP_N) return { embeds: [embed] };
  const body = hits.map((h) => `${h.note_path}\t${h.match_preview}`).join("\n");
  return { embeds: [embed], files: [overflowFile("search-results.txt", body)] };
}

// /ask reply payload: embed (TOP_N visible) + overflow .txt when there are more hits.
export function semanticResultPayload(query: string, hits: SemanticHit[]): ResultPayload {
  const embed = semanticResultEmbed(query, hits);
  if (hits.length <= TOP_N) return { embeds: [embed] };
  const body = hits
    .map((h) => `${h.note_path}\t${h.score.toFixed(2)}\t${h.chunk_text}`)
    .join("\n");
  return { embeds: [embed], files: [overflowFile("ask-results.txt", body)] };
}

// Help overview shown when the owner @-mentions uxie (mention-trigger spec). Pure: takes a
// flat command summary list, returns one classic embed. The list is derived by the caller
// from the registered command collection so this never drifts from the real command set.
export interface CommandSummary {
  name: string;
  description: string;
}

export function helpEmbed(commands: CommandSummary[]): EmbedBuilder {
  const lines = commands.map((c) => `\`/${c.name}\` — ${c.description || "—"}`);
  return new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle("uxie — commands")
    .setDescription(lines.length ? lines.join("\n") : "_(no commands registered)_")
    .setFooter({
      text: "Tag me with a request soon and I'll route it. For now, use the slash commands above.",
    });
}

// /brief embed (Design §6.5 / plan Task 25). A classic ephemeral embed (decision 14 — no
// Components V2) with exactly five fields built from the simplified DailyContext: today's
// journal, open threads, recent captures, active memories, and the tag cloud. Every field
// value is non-empty (Discord rejects "") and capped at Discord's hard 1024-char field
// limit. Pure (no IO): the /brief command body does the editReply. The single ACCENT color
// (decision 14) is set here so /brief matches every other uxie embed.
//
// `date` is the USER_TZ-local "today" (journalDateKey) computed by the command — the title
// must show the owner's local date, not the bot host's UTC date.
export function briefEmbed(ctx: DailyContext, date: string): EmbedBuilder {
  const journalVal = ctx.today_journal ? truncate(ctx.today_journal, FIELD_VALUE_CAP) : EMPTY_FIELD;
  const threadsVal =
    ctx.open_threads.length === 0
      ? EMPTY_FIELD
      : truncate(
          ctx.open_threads.slice(0, 5).map((t) => `• [${t.priority}] \`${t.path}\``).join("\n"),
          FIELD_VALUE_CAP,
        );
  const recentVal =
    ctx.recent_notes.length === 0
      ? EMPTY_FIELD
      : truncate(ctx.recent_notes.slice(0, 5).map((n) => `• \`${n.path}\``).join("\n"), FIELD_VALUE_CAP);
  const memVal =
    ctx.active_memories.length === 0
      ? EMPTY_FIELD
      : truncate(ctx.active_memories.map((m) => m.name).join(", "), FIELD_VALUE_CAP);
  const tagsVal =
    ctx.tag_cloud.length === 0
      ? EMPTY_FIELD
      : truncate(ctx.tag_cloud.slice(0, 10).map((t) => `\`${t.tag}\`(${t.count})`).join(" "), FIELD_VALUE_CAP);

  return new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(truncate(`Daily brief — ${date}`, TITLE_CAP))
    .addFields(
      // Field names carry the lowercase domain keyword (journal/threads/captures/memories/
      // tags) the /brief tests assert on, with a leading emoji glyph for visual grouping.
      { name: "📓 journal", value: journalVal },
      { name: "🧵 threads", value: threadsVal },
      { name: "📥 captures", value: recentVal },
      { name: "🧠 memories", value: memVal },
      { name: "🏷️ tags", value: tagsVal },
    );
}
