// /raid — para-raid session control (D1). Subcommands: open (new session thread + launch),
// status (compact session list, A3 orphan marking), close (end a session; optional `session`
// id so an orphan can be closed without its thread, A3). Owner gate + defer are router-located
// (decisions 9/10); this file stays try/catch-free — thrown ParaRaidError/ConfigError funnel to
// the router's existing catch path.
import { ChannelType, SlashCommandBuilder, ThreadAutoArchiveDuration } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";
import { ConfigError, ParaRaidError } from "../../../lib/errors.ts";
import type { ParaRaidClient } from "../client.ts";
import type { SessionCache } from "../sessions.ts";

const THREAD_NAME_MAX = 80;

export function buildRaidCommand(api: ParaRaidClient, sessions: SessionCache): LoadedCommand {
  return {
    data: withOwnerGate(
      new SlashCommandBuilder()
        .setName("raid")
        .setDescription("Control para-raid sessions")
        .addSubcommand((s) =>
          s
            .setName("open")
            .setDescription("Open a new para-raid session in a fresh thread")
            .addStringOption((o) =>
              o.setName("prompt").setDescription("Initial prompt").setRequired(true),
            )
            .addStringOption((o) => o.setName("bundle").setDescription("MCP bundle name")),
        )
        .addSubcommand((s) => s.setName("status").setDescription("List para-raid sessions"))
        .addSubcommand((s) =>
          s
            .setName("close")
            .setDescription("Close a para-raid session")
            .addStringOption((o) =>
              o.setName("session").setDescription("Session id (defaults to this thread's session)"),
            ),
        ),
    ),
    async execute(i) {
      const sub = i.options.getSubcommand(true);
      if (sub === "open") return openRaid(i, api);
      if (sub === "status") return statusRaid(i, api);
      if (sub === "close") return closeRaid(i, api, sessions);
      throw new ConfigError("raid_subcommand", `unknown /raid subcommand: ${sub}`);
    },
  };
}

async function openRaid(i: ChatInputCommandInteraction, api: ParaRaidClient): Promise<void> {
  if (i.channel?.isThread()) {
    throw new ParaRaidError(
      "raid_open_in_thread",
      "run /raid open from a regular channel, not inside a session thread",
    );
  }
  const channel = i.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new ConfigError("raid_open", "no text channel context");
  }

  const prompt = i.options.getString("prompt", true);
  const bundle = i.options.getString("bundle") ?? undefined;
  const name = prompt.length > THREAD_NAME_MAX ? `${prompt.slice(0, THREAD_NAME_MAX - 1)}…` : prompt;

  const thread = await channel.threads.create({
    name,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    type: ChannelType.PublicThread,
  });

  const res = await api.openSession({ adapter_ref: thread.id, prompt, bundle_name: bundle });
  if (res.status !== 202 && res.status !== 200) {
    throw new ParaRaidError("raid_open_failed", `open_session failed (${res.status})`);
  }

  await thread.send(`session ${res.body.status} — session_id \`${res.body.session_id}\``);
  await i.editReply(`opened <#${thread.id}>`);
}

async function statusRaid(i: ChatInputCommandInteraction, api: ParaRaidClient): Promise<void> {
  const res = await api.listSessions();
  if (res.status !== 200) {
    throw new ParaRaidError("raid_status_failed", `listSessions failed (${res.status})`);
  }
  if (res.body.sessions.length === 0) {
    await i.editReply("no para-raid sessions");
    return;
  }

  // A3: a session whose adapter_ref no longer resolves to a fetchable thread is orphaned —
  // flag it so the operator knows `/raid close session:<id>` is the only way to reap it.
  const lines = await Promise.all(
    res.body.sessions.map(async (s) => {
      const thread = await i.client.channels.fetch(s.adapter_ref).catch(() => null);
      const orphan = thread ? "" : " (orphaned — thread not found)";
      const lastTurn = s.last_turn_at ? `, last turn <t:${Math.floor(s.last_turn_at / 1000)}:R>` : "";
      return `\`${s.id}\` — ${s.status} — <#${s.adapter_ref}>${lastTurn}${orphan}`;
    }),
  );
  await i.editReply(lines.join("\n").slice(0, 2000));
}

async function closeRaid(
  i: ChatInputCommandInteraction,
  api: ParaRaidClient,
  sessions: SessionCache,
): Promise<void> {
  const sessionId = i.options.getString("session") ?? (await sessionIdFromThread(i, sessions));
  if (!sessionId) {
    throw new ParaRaidError("raid_close_no_session", "not in a session thread — pass session:<id>");
  }
  const res = await api.closeSession({ session_id: sessionId });
  if (res.status !== 200) {
    throw new ParaRaidError("raid_close_failed", `close_session failed (${res.status})`);
  }
  await i.editReply(`closing session \`${sessionId}\``);
}

async function sessionIdFromThread(
  i: ChatInputCommandInteraction,
  sessions: SessionCache,
): Promise<string | undefined> {
  if (!i.channel?.isThread()) return undefined;
  const session = await sessions.resolveByThread(i.channel.id);
  return session?.id;
}
