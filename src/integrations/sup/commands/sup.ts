// /sup status — one panel for the whole SUP stack: uxie (this process), scrypt (REST health
// probe), para-raid (session census over the unix socket, when the module is enabled). This is
// the stack-level sibling of /ping's scrypt-only panel. Auto-defer shape — the para-raid probe
// is bounded at 5s (client timeout), which does NOT fit Discord's 3s ack window, so the router
// must acknowledge first (unlike /ping's 500ms probe).
// `status` is a subcommand so /sup can grow update/backup legs once the VPS pipeline lands.
// Probes degrade-don't-crash (health() and the caught listSessions never throw), so the panel
// always renders; NO try/catch beyond the probe boundary — router is the catch site.
import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";
import { ConfigError } from "../../../lib/errors.ts";
import { humanizeDuration } from "../../../lib/format/duration.ts";
import { buildStatusContainer } from "../../../lib/ui/status-container.ts";
import type { Health, StatusModel, StatusRow } from "../../../lib/ui/status-container.ts";
import type { ScryptRestClient } from "../../scrypt/rest-client.ts";
import type { ParaRaidClient, Session } from "../../para-raid/client.ts";

export interface SupOpts {
  host: string; // "<env label> · <machine hostname>", same string /ping shows
}

function censusValue(sessions: Session[]): string {
  if (sessions.length === 0) return "reachable · no sessions";
  const byStatus = new Map<string, number>();
  for (const s of sessions) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
  const parts = [...byStatus.entries()].map(([k, v]) => `${v} ${k}`);
  return `reachable · ${parts.join(", ")}`;
}

export function buildSupCommand(
  rest: ScryptRestClient,
  paraRaid: ParaRaidClient | undefined,
  opts: SupOpts,
): LoadedCommand {
  return {
    data: withOwnerGate(
      new SlashCommandBuilder()
        .setName("sup")
        .setDescription("SUP stack operations")
        .addSubcommand((sc) => sc.setName("status").setDescription("Health of scrypt, uxie, and para-raid")),
    ),
    async execute(i, ctx) {
      const sub = i.options.getSubcommand();
      if (sub !== "status") throw new ConfigError("sup", `unknown subcommand: ${sub}`);

      // scrypt: bounded REST probe (degrades, never throws).
      const t0 = performance.now();
      const h = await rest.health();
      const scryptMs = Math.round(performance.now() - t0);

      // para-raid: absent client = module off (not an error); a probe fault = unreachable.
      let paraValue: string;
      let paraOk: boolean | null; // null = off, excluded from overall health
      if (!paraRaid) {
        paraValue = "module off (PARARAID_* env unset)";
        paraOk = null;
      } else {
        const res = await paraRaid.listSessions().catch(() => null);
        if (res && res.status === 200) {
          paraValue = censusValue(res.body.sessions);
          paraOk = true;
        } else {
          paraValue = res ? `error HTTP ${res.status}` : "unreachable (socket down or timeout)";
          paraOk = false;
        }
      }

      const wsPing = i.client?.ws?.ping;
      const rows: StatusRow[] = [
        {
          icon: "🤖",
          label: "uxie",
          value: `up ${humanizeDuration(process.uptime())} · ws ${typeof wsPing === "number" && wsPing >= 0 ? `${Math.round(wsPing)}ms` : "n/a"}`,
        },
        {
          icon: h.ok ? "🗄" : "🛑",
          label: "scrypt",
          value: h.ok ? `ok · ${scryptMs}ms` : `down · ${h.reason ?? "no response"}`,
        },
        { icon: paraOk === false ? "🛑" : "🧵", label: "para-raid", value: paraValue },
      ];

      const health: Health =
        h.ok && paraOk !== false ? "ok" : h.ok || paraOk !== false ? "degraded" : "down";

      const model: StatusModel = {
        title: "SUP stack",
        health,
        badge: health === "ok" ? "all systems go" : health,
        rows,
        footer: opts.host,
      };

      await i.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [buildStatusContainer(model)],
      });

      ctx.log.info("sup status", { scryptOk: h.ok, scryptMs, paraRaid: paraValue });
    },
  };
}
