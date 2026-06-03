// /capture <text> [kind=note|thought|idea] — the slash-command write path (Design §6.1).
//
// Command body is a strict adapter: read options, call rest.ingest, render captureEmbed,
// editReply. NO try/catch here — interaction-router is the only catch site (decision 10 /
// UXIE §14.2 + §22). NO owner gate here — that is ROUTER-LOCATED (decision 9). The reply is
// ephemeral (the router already deferred with MessageFlags.Ephemeral) and suppresses
// mentions (decision 8).
//
// Kind choices are deliberately limited to note/thought/idea (Design §6.1): journal has its
// own command, memory needs an active flag, and research_run/spec/plan/log are not
// daily-capture shapes. note routes into notes/inbox/ on the scrypt side.
import { SlashCommandBuilder } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import type { ScryptRestClient } from "../rest-client.ts";
import { captureEmbed } from "../../../lib/embed.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";

export function buildCaptureCommand(rest: ScryptRestClient): LoadedCommand {
  return {
    data: withOwnerGate(
      new SlashCommandBuilder()
        .setName("capture")
        .setDescription("Capture a note into scrypt")
        .addStringOption((o) =>
          o.setName("text").setDescription("What to capture").setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName("kind")
            .setDescription("Type of capture")
            .addChoices(
              { name: "note (inbox)", value: "note" },
              { name: "thought", value: "thought" },
              { name: "idea", value: "idea" },
            ),
        ),
    ),
    async execute(i, ctx) {
      const text = i.options.getString("text", true);
      const kind = i.options.getString("kind") ?? "note";
      const out = await rest.ingest({ kind, content: text, clientTag: ctx.clientTag });
      await i.editReply({ embeds: [captureEmbed(out)], allowedMentions: { parse: [] } });
    },
  };
}
