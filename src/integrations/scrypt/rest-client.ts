// Scrypt REST client. Today this is JUST the /ping health probe + connectivity tracking — the
// write/read methods (ingest, daily_context) were removed pending Scrypt's ingestion rework (see
// ./README.md). Auth is Bearer ${SCRYPT_AUTH}; the bearer must stay off untrusted wire, enforced
// at boot by env.ts (UX-SEC-002).
import { log } from "../../lib/log.ts";

export type HealthReason = "unreachable" | "auth" | "server" | "timeout";

export interface HealthResult {
  ok: boolean;
  reason?: HealthReason;
}

export class ScryptRestClient {
  constructor(
    private baseUrl: string,
    private bearer: string,
  ) {}

  // Last observed connectivity (null = not yet probed). Scrypt's reachability is only ever
  // observed through this probe, so up↔down transitions are logged here — once each — rather
  // than on every probe; repeat-down probes (e.g. the /ping auto-retry loop) stay silent.
  private lastHealthy: boolean | null = null;

  // REST health probe used by /ping (Design §6.7). Scrypt exposes no /api/health, so we hit the
  // shallow GET /api/daily_context. Degrade-don't-crash: returns {ok,reason} and never throws, so
  // /ping always replies even when scrypt is down.
  // ponytail: probe path predates Scrypt's API rework — revisit against the new contract in v2.
  async health(): Promise<HealthResult> {
    const result = await this.probeHealth();
    this.noteTransition(result);
    return result;
  }

  private async probeHealth(): Promise<HealthResult> {
    try {
      const res = await fetch(`${this.baseUrl}/api/daily_context`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.bearer}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(500),
      });
      if (res.status === 200) return { ok: true };
      if (res.status === 401 || res.status === 403) return { ok: false, reason: "auth" };
      if (res.status >= 500) return { ok: false, reason: "server" };
      return { ok: false, reason: "server" };
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") {
        return { ok: false, reason: "timeout" };
      }
      return { ok: false, reason: "unreachable" };
    }
  }

  // Log only when reachability flips, so the operator's log channel (warn+error) shows Scrypt
  // going down and coming back without a line per probe. A first-ever healthy probe is no news.
  private noteTransition(result: HealthResult): void {
    if (result.ok === this.lastHealthy) return;
    const first = this.lastHealthy === null;
    this.lastHealthy = result.ok;
    if (!result.ok) {
      log.warn("scrypt connectivity lost", { reason: result.reason });
    } else if (!first) {
      log.warn("scrypt connectivity restored");
    }
  }
}
