// /capture <text> — file the text into the vault's unintegrated inbox (projects/_inbox) via
// the MCP create_note write path. Owner gate + defer are router-located (decisions 9/10); the
// body stays try/catch-free — a thrown ScryptError funnels to the router's `scrypt error`
// branch. Retry-safe: ctx.clientTag is deterministic per interaction (decision 3), and
// create_note dedups by client_tag server-side, so a Discord retry replays the cached write.
import { SlashCommandBuilder } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";
import type { ScryptRestClient } from "../rest-client.ts";

const TITLE_MAX = 80;

// Title = first non-empty line, whitespace-collapsed, capped. The full text is the body.
export function titleFrom(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? "capture";
  const collapsed = line.replace(/\s+/g, " ");
  return collapsed.length > TITLE_MAX ? `${collapsed.slice(0, TITLE_MAX - 1)}…` : collapsed;
}

export function buildCaptureCommand(rest: ScryptRestClient): LoadedCommand {
  return {
    data: withOwnerGate(
      new SlashCommandBuilder()
        .setName("capture")
        .setDescription("File a quick note into scrypt's inbox (projects/_inbox)")
        .addStringOption((o) =>
          o.setName("text").setDescription("What to capture").setRequired(true),
        ),
    ),
    async execute(i, ctx) {
      const text = i.options.getString("text", true);
      const { path } = await rest.createNote({
        title: titleFrom(text),
        content: text,
        clientTag: ctx.clientTag,
      });
      await i.editReply(`captured → \`${path}\``);
    },
  };
}
