// "Triage" message context-menu command: right-click any message with a link/image/doc →
// Apps → Triage. Creates a thread in the triage channel and opens a para-raid session on it
// (adapter_ref = thread id, same contract as /raid open) with a quick-check prompt. The
// session's summary arrives in the thread via the existing webhook→thread plumbing; deciding
// IF/HOW to research + ingest is just typing in the thread (the owner relay forwards it as a
// turn), and /raid close ends it. No new event plumbing — the flow IS a raid session.
//
// Owner gate + defer are router-located (decisions 9/10); this file stays try/catch-free.
import {
  ApplicationCommandType,
  ApplicationIntegrationType,
  ChannelType,
  ContextMenuCommandBuilder,
  InteractionContextType,
  ThreadAutoArchiveDuration,
  type MessageContextMenuCommandInteraction,
} from "discord.js";
import type { MessageCommand } from "../../bot/command-loader.ts";
import { ConfigError, ParaRaidError } from "../../lib/errors.ts";
import type { ParaRaidClient } from "../para-raid/client.ts";
import { extractItems, type TriageItem } from "./extract.ts";

export interface TriageOpts {
  triageChannelId: string;
  bundle?: string; // MCP bundle for the session (e.g. "scrypt"); undefined = none
}

const THREAD_NAME_MAX = 80;

export function buildTriageCommand(api: ParaRaidClient, opts: TriageOpts): MessageCommand {
  // ContextMenuCommandBuilder is not a SharedSlashCommand, so the decision-7 default shape
  // (guild-only, guild-install, owner-locked) is applied directly rather than via withOwnerGate.
  const data = new ContextMenuCommandBuilder()
    .setName("Triage")
    .setType(ApplicationCommandType.Message)
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .setDefaultMemberPermissions(0n);

  return {
    data,
    async execute(i, ctx) {
      const msg = i.targetMessage;
      const items = extractItems({
        content: msg.content,
        attachments: msg.attachments.values(),
        embeds: msg.embeds,
      });
      if (items.length === 0) {
        throw new ParaRaidError("triage_nothing", "no links or attachments on that message");
      }

      const channel = await i.client.channels.fetch(opts.triageChannelId);
      if (!channel || channel.type !== ChannelType.GuildText) {
        throw new ConfigError("triage_channel", "triageChannelId is not a text channel");
      }

      const first = items[0]!;
      const name = clip(`triage: ${first.label}`, THREAD_NAME_MAX);
      const thread = await channel.threads.create({
        name,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        type: ChannelType.PublicThread,
      });

      // Source card first, so the thread is self-describing even before the session replies.
      await thread.send(sourceCard(msg, items));

      const res = await api.openSession({
        adapter_ref: thread.id,
        prompt: triagePrompt(msg.content, items),
        bundle_name: opts.bundle,
      });
      if (res.status !== 202 && res.status !== 200) {
        throw new ParaRaidError("triage_open_failed", `open_session failed (${res.status})`);
      }

      ctx.log.info("triage opened", { threadId: thread.id, sessionId: res.body.session_id, items: items.length });
      await i.editReply(`triaged → <#${thread.id}>`);
    },
  };
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function itemLine(it: TriageItem): string {
  const type = it.kind === "attachment" ? ` (${it.contentType ?? "file"})` : "";
  return `- ${it.label}${type}: ${it.url}`;
}

function sourceCard(
  msg: { url: string; channelId: string; author: { tag: string } },
  items: TriageItem[],
): string {
  const lines = [
    `**Triage** — from ${msg.author.tag} in <#${msg.channelId}> · [jump](${msg.url})`,
    ...items.map(itemLine),
  ];
  return clip(lines.join("\n"), 2000);
}

// The quick-check contract: summarize fast, then WAIT — the owner directs research/ingestion
// by typing in the thread (relayed as turns), so the prompt must forbid unprompted ingestion.
function triagePrompt(content: string, items: TriageItem[]): string {
  return [
    "You are triaging item(s) shared on Discord.",
    "",
    "Items:",
    ...items.map(itemLine),
    ...(content.trim() ? ["", `Message context: ${clip(content.trim(), 500)}`] : []),
    "",
    "Step 1 — quick check, do it now: fetch/inspect each item and reply with a compact summary",
    "(max ~8 lines): what it is (blog / reddit / X / YouTube / paper / repo / doc), the source,",
    "what it's about, and whether it looks worth ingesting into the vault. Then STOP and wait.",
    "",
    "Step 2 — only if the operator replies with instructions: follow them (deeper research,",
    "then ingest into scrypt via the MCP tools, doc_type research unless told otherwise).",
    "Never ingest anything without an explicit instruction.",
  ].join("\n");
}
