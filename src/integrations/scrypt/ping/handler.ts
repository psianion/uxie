// Owner+guild gating already happened in the router; this just dispatches ping:* button
// actions. Each action re-probes Scrypt and updates the same ephemeral V2 message in place.
import { ButtonStyle, MessageFlags, type ButtonInteraction } from "discord.js";
import type { ComponentHandler } from "../../../bot/interaction-router.ts";
import type { ScryptRestClient } from "../rest-client.ts";
import { buildStatusContainer } from "../../../lib/ui/status-container.ts";
import { buildPingModel, type PingProbe } from "./model.ts";
import { restartScrypt, createRestartGuard, type RestartRunner } from "../../../lib/exec/restart-scrypt.ts";

export interface PingHandlerOpts {
  version: string;
  scryptHost: string;
  allowRestart: boolean;
  host: string;
}

// Injected restart capability. Absent ⇒ the restart actions are inert even if a button id
// is forged. `runner`/`guard`/`now`/`newNonce` are injectable for deterministic tests.
export interface RestartDeps {
  command: string;
  secrets: string[];
  runner?: RestartRunner;
  guard?: ReturnType<typeof createRestartGuard>;
  now?: () => number;
  newNonce?: () => string;
}

const NONCE_TTL_MS = 30_000;

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
  restart?: RestartDeps,
): ComponentHandler {
  const guard = restart?.guard ?? createRestartGuard(restart?.now);
  const now = restart?.now ?? Date.now;
  const newNonce = restart?.newNonce ?? (() => crypto.randomUUID());
  // Single pending-confirm slot — uxie is single-user, so one in-flight confirmation is enough.
  let pending: { nonce: string; expiresAt: number } | null = null;

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

      // --- Privileged restart path (inert unless explicitly enabled) ---
      if (action === "restart") {
        if (!opts.allowRestart || !restart) return;
        const nonce = newNonce();
        pending = { nonce, expiresAt: now() + NONCE_TTL_MS };
        const confirm = buildStatusContainer({
          title: "Uxie · Confirm restart",
          health: "degraded",
          badge: "⚠️ CONFIRM",
          rows: [{ icon: "🔧", label: "Action", value: "Restart the Scrypt service?" }],
          footer: "This runs the configured restart command on the host.",
          buttons: [
            { id: `ping:restart-confirm:${nonce}`, label: "Confirm restart", emoji: "✅", style: ButtonStyle.Danger },
            { id: "ping:restart-cancel", label: "Cancel", emoji: "✖️", style: ButtonStyle.Secondary },
          ],
        });
        await i.update({ flags: V2, components: [confirm] });
        return;
      }

      if (action === "restart-cancel") {
        pending = null;
        await render(i, rest, opts);
        return;
      }

      if (action === "restart-confirm") {
        if (!opts.allowRestart || !restart) return;
        const got = i.customId.split(":")[2];
        if (!pending || got !== pending.nonce || now() > pending.expiresAt) {
          pending = null;
          await i.reply({ content: "⚠️ That confirmation expired — run /ping again.", flags: MessageFlags.Ephemeral });
          return;
        }
        pending = null;
        const lease = guard.tryAcquire();
        if (!lease.ok) {
          const why =
            lease.reason === "in_flight"
              ? "a restart is already running"
              : `cooling down (${Math.ceil(lease.retryInMs / 1000)}s)`;
          await i.reply({ content: `⏳ Can't restart — ${why}.`, flags: MessageFlags.Ephemeral });
          return;
        }
        try {
          await i.deferUpdate();
          const restartingProbe = await probe(rest);
          await i.editReply({
            flags: V2,
            components: [buildStatusContainer(buildPingModel(restartingProbe, sysFrom(i), { ...opts, restarting: true }))],
          });
          const result = await restartScrypt({ command: restart.command, secrets: restart.secrets }, restart.runner);
          const after = await probe(rest);
          if (result.ok && after.ok) {
            await i.editReply({
              flags: V2,
              components: [buildStatusContainer(buildPingModel(after, sysFrom(i), opts))],
            });
          } else {
            const failed = buildStatusContainer({
              title: "Uxie · Restart failed",
              health: "down",
              badge: "🔴 RESTART FAILED",
              rows: [
                { icon: "🔧", label: "Exit", value: result.code === null ? "n/a" : String(result.code) },
                { icon: "🪵", label: "stderr", value: result.stderr ? `\`\`\`\n${result.stderr}\n\`\`\`` : "(none)" },
              ],
              footer: "Scrypt still unhealthy — check the host.",
              buttons: [{ id: "ping:retry", label: "Retry", emoji: "🔁", style: ButtonStyle.Primary }],
            });
            await i.editReply({ flags: V2, components: [failed] });
          }
        } finally {
          guard.release();
        }
        return;
      }
    },
  };
}
