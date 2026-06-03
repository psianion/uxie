// /ping — REST health probe ONLY (Design §6.7 / decision 15). No MCP probe: streamable-http
// MCP endpoints don't answer unauthenticated probes and the REST surface is the truer
// end-to-end signal (same process, same auth path). Reply is a STRING (not an embed).
// Enriched with the gateway heartbeat (null-safe i.client.ws.ping before READY), a Status
// enum, the editReply roundtrip, and process.uptime().
//
// No try/catch in the command body — interaction-router is the only catch site (decision 10).
import { SlashCommandBuilder } from "discord.js";
import type { LoadedCommand } from "../../../bot/command-loader.ts";
import type { ScryptRestClient } from "../rest-client.ts";
import { withOwnerGate } from "../../../lib/command-builder.ts";

enum Status {
  Ok = "ok",
  Degraded = "degraded",
}

export function buildPingCommand(rest: ScryptRestClient): LoadedCommand {
  return {
    data: withOwnerGate(
      new SlashCommandBuilder().setName("ping").setDescription("Check uxie + scrypt health"),
    ),
    async execute(i) {
      const h = await rest.health();
      const status = h.ok ? Status.Ok : Status.Degraded;
      const scryptPart = h.ok ? "ok" : (h.reason ?? "unreachable");

      // i.client.ws.ping is -1 before READY in some builds and may be absent in stubs.
      const wsPing = i.client?.ws?.ping;
      const heartbeat = typeof wsPing === "number" && wsPing >= 0 ? `${Math.round(wsPing)}ms` : "n/a";

      const uptimeSec = Math.floor(process.uptime());
      const reply = `🏓 uxie alive — status: ${status} — heartbeat ${heartbeat} — uptime ${uptimeSec}s — scrypt: ${scryptPart}`;

      // editReply returns the message; measuring around it gives the REST roundtrip.
      const sent = await i.editReply(reply);
      const roundtrip =
        sent && typeof (sent as { createdTimestamp?: number }).createdTimestamp === "number"
          ? (sent as { createdTimestamp: number }).createdTimestamp - i.createdTimestamp
          : undefined;
      if (roundtrip !== undefined && roundtrip >= 0) {
        await i.editReply(`${reply} — roundtrip ${roundtrip}ms`);
      }
    },
  };
}
