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
import { EmbedBuilder } from "discord.js";

// Single accent color for every uxie embed (decision 14). Discord blurple.
export const ACCENT = 0x5865f2;

export const TITLE_CAP = 256;
export const DESC_CAP = 4000; // 4096 theoretical, leave slack
export const FIELD_CAP = 1000;

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
