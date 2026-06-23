// Pure mapping from a Scrypt health probe + system snapshot to a StatusModel.
// Owns the colour/badge/copy semantics and which recovery buttons appear. No
// discord.js side effects, no I/O — unit-testable in isolation.
import { ButtonStyle } from "discord.js";
import type { Health, StatusButton, StatusModel } from "../../../lib/ui/status-container.ts";
import { humanizeDuration } from "../../../lib/format/duration.ts";

export type PingReason = "unreachable" | "auth" | "server" | "timeout";

export interface PingProbe {
  ok: boolean;
  reason?: PingReason;
  latencyMs: number;
}

export interface PingSystem {
  heartbeatMs: number | null;
  uptimeSec: number;
  roundtripMs?: number;
}

export interface PingModelOpts {
  version: string;
  scryptHost: string;
  allowRestart: boolean;
  restarting?: boolean;
  // Pre-formatted "label · hostname" of the box this instance runs on (e.g. "vps · prod-1").
  host: string;
}

// reason → (health bucket, human Scrypt line). ok is handled separately.
const REASON: Record<PingReason, { health: Health; line: string }> = {
  auth: { health: "degraded", line: "auth rejected (401/403) — check SCRYPT_AUTH" },
  server: { health: "degraded", line: "server error (5xx)" },
  timeout: { health: "down", line: "timed out" },
  unreachable: { health: "down", line: "unreachable" },
};

const BADGE: Record<Health, string> = {
  ok: "🟢 OK",
  degraded: "🟡 DEGRADED",
  down: "🔴 DOWN",
};

export function buildPingModel(probe: PingProbe, sys: PingSystem, opts: PingModelOpts): StatusModel {
  const health: Health = probe.ok ? "ok" : REASON[probe.reason ?? "unreachable"].health;
  const scryptLine = probe.ok ? `reachable · ${probe.latencyMs} ms` : REASON[probe.reason ?? "unreachable"].line;
  const heartbeat =
    typeof sys.heartbeatMs === "number" && sys.heartbeatMs >= 0 ? `${Math.round(sys.heartbeatMs)} ms` : "n/a";

  const rows = [
    { icon: "🌐", label: "Host", value: opts.host },
    { icon: "⚡", label: "Gateway", value: `connected · ${heartbeat}` },
    { icon: "🗄", label: "Scrypt", value: scryptLine },
    { icon: "⏱", label: "Uptime", value: humanizeDuration(sys.uptimeSec) },
  ];
  if (typeof sys.roundtripMs === "number") {
    rows.push({ icon: "📡", label: "API latency", value: `${sys.roundtripMs} ms roundtrip` });
  }

  const buttons: StatusButton[] = [
    { id: "ping:refresh", label: "Refresh", emoji: "🔄", style: ButtonStyle.Secondary },
  ];
  if (health !== "ok") {
    buttons.push({ id: "ping:retry", label: "Retry", emoji: "🔁", style: ButtonStyle.Primary });
    buttons.push({ id: "ping:autoretry", label: "Auto-retry", emoji: "⏳", style: ButtonStyle.Secondary });
    buttons.push({ id: "ping:details", label: "Details", emoji: "🩺", style: ButtonStyle.Secondary });
    if (opts.allowRestart) {
      buttons.push({
        id: "ping:restart",
        label: "Restart Scrypt",
        emoji: "🔧",
        style: ButtonStyle.Danger,
        disabled: opts.restarting === true,
      });
    }
  }

  return {
    title: "Uxie · Health Check",
    health,
    badge: BADGE[health],
    rows,
    footer: `uxie v${opts.version} · ${opts.scryptHost}`,
    buttons,
  };
}
