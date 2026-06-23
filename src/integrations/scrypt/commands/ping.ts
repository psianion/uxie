// /ping — Components V2 health panel (Design §6.7 / decision 15). REST health probe only.
// Replies IMMEDIATELY (no defer): the probe's 500 ms timeout fits Discord's 3 s window, and
// IsComponentsV2 must be set at reply time (a deferred placeholder can't carry it). The body
// stays try/catch-free — rest.health() degrades-don't-crash, so /ping always renders.
import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import type { ScryptRestClient } from "../rest-client.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";
import { buildStatusContainer } from "../../../lib/ui/status-container.ts";
import { buildPingModel, type PingProbe } from "../ping/model.ts";

export interface PingOpts {
  version: string;
  scryptHost: string;
  allowRestart: boolean;
  host: string;
}

export function buildPingCommand(rest: ScryptRestClient, opts: PingOpts): LoadedCommand {
  return {
    defer: false,
    data: withOwnerGate(
      new SlashCommandBuilder().setName("ping").setDescription("Check uxie + scrypt health"),
    ),
    async execute(i) {
      const t0 = performance.now();
      const h = await rest.health();
      const latencyMs = Math.round(performance.now() - t0);
      const probe: PingProbe = { ok: h.ok, reason: h.reason, latencyMs };

      const wsPing = i.client?.ws?.ping;
      const sys = {
        heartbeatMs: typeof wsPing === "number" ? wsPing : null,
        uptimeSec: Math.floor(process.uptime()),
      };

      const flags = MessageFlags.Ephemeral | MessageFlags.IsComponentsV2;
      await i.reply({ flags, components: [buildStatusContainer(buildPingModel(probe, sys, opts))] });

      // Second render appends the measured API roundtrip (editReply keeps the V2 message).
      const sent = await i.fetchReply().catch(() => null);
      const roundtripMs =
        sent && typeof (sent as { createdTimestamp?: number }).createdTimestamp === "number"
          ? (sent as { createdTimestamp: number }).createdTimestamp - i.createdTimestamp
          : undefined;
      if (roundtripMs !== undefined && roundtripMs >= 0) {
        const withRt = buildStatusContainer(buildPingModel(probe, { ...sys, roundtripMs }, opts));
        await i.editReply({ flags, components: [withRt] }).catch(() => {});
      }
    },
  };
}
