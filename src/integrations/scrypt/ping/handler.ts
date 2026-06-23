// Owner+guild gating already happened in the router; this just dispatches ping:* button
// actions. Each action re-probes Scrypt and updates the same ephemeral V2 message in place.
import { MessageFlags, type ButtonInteraction } from "discord.js";
import type { ComponentHandler } from "../../../bot/interaction-router.ts";
import type { ScryptRestClient } from "../rest-client.ts";
import { buildStatusContainer } from "../../../lib/ui/status-container.ts";
import { buildPingModel, type PingProbe } from "./model.ts";

export interface PingHandlerOpts {
  version: string;
  scryptHost: string;
  allowRestart: boolean;
}

const V2 = MessageFlags.IsComponentsV2;

const DETAILS: Record<string, string> = {
  auth: "Scrypt returned 401/403 — the `SCRYPT_AUTH` bearer is wrong or expired. Fix the token in `.env` and restart uxie. (uxie can't fix this for you.)",
  server: "Scrypt returned a 5xx — it's up but erroring. Check Scrypt's logs; a restart may help.",
  timeout: "Scrypt didn't answer within the probe window — it may be overloaded or starting up.",
  unreachable: "Couldn't connect to Scrypt at all — the process/container is likely down.",
};

async function probe(rest: ScryptRestClient): Promise<PingProbe> {
  const t0 = performance.now();
  const h = await rest.health();
  return { ok: h.ok, reason: h.reason, latencyMs: Math.round(performance.now() - t0) };
}

function sysFrom(i: ButtonInteraction) {
  const ws = i.client?.ws?.ping;
  return { heartbeatMs: typeof ws === "number" ? ws : null, uptimeSec: Math.floor(process.uptime()) };
}

async function render(
  i: ButtonInteraction,
  rest: ScryptRestClient,
  opts: PingHandlerOpts,
): Promise<PingProbe> {
  const p = await probe(rest);
  await i.update({ flags: V2, components: [buildStatusContainer(buildPingModel(p, sysFrom(i), opts))] });
  return p;
}

export function buildPingComponentHandler(
  rest: ScryptRestClient,
  opts: PingHandlerOpts,
): ComponentHandler {
  return {
    namespace: "ping",
    async handle(i, _ctx, tuning) {
      const action = i.customId.split(":")[1];

      if (action === "refresh" || action === "retry") {
        await render(i, rest, opts);
        return;
      }

      if (action === "autoretry") {
        const delayMs = tuning?.delayMs ?? 2_000;
        const maxAttempts = tuning?.maxAttempts ?? 10;
        for (let n = 0; n < maxAttempts; n++) {
          const p = await render(i, rest, opts);
          if (p.ok) return;
          if (n < maxAttempts - 1 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        }
        return;
      }

      if (action === "details") {
        const p = await probe(rest);
        const msg = p.ok
          ? "All good — Scrypt is reachable."
          : (DETAILS[p.reason ?? "unreachable"] ?? "Unknown Scrypt fault.");
        await i.reply({ content: `🩺 ${msg}`, flags: MessageFlags.Ephemeral });
        return;
      }
    },
  };
}
