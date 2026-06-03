// Scrypt REST client. v1 write path is POST /api/ingest (added in Wave 2); this
// wave introduces only health(). Auth is Bearer ${SCRYPT_AUTH} (scrypt-contract §0);
// REST calls that carry an interaction send X-Correlation-Id: <client_tag> for tracing
// (scrypt-contract §0). Timeouts via AbortSignal.timeout: 10s default, 500ms for the
// /ping health probe (ratified decision 5).
import { ScryptError } from "../../lib/errors.ts";

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

  // Base headers for every REST call. `correlationId` is the deterministic client_tag;
  // omitted on the health probe (no interaction context). Authorization is redacted
  // by the logger before any of this reaches stdout.
  private headers(correlationId?: string): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.bearer}`,
      "Content-Type": "application/json",
    };
    if (correlationId !== undefined) h["X-Correlation-Id"] = correlationId;
    return h;
  }

  // REST health probe used by /ping (Design §6.7). Scrypt exposes no /api/health, so we
  // hit the shallow GET /api/daily_context. Degrade-don't-crash: returns {ok,reason}
  // and never throws, so /ping always replies even when scrypt is down.
  async health(): Promise<HealthResult> {
    try {
      const res = await fetch(`${this.baseUrl}/api/daily_context`, {
        method: "GET",
        headers: this.headers(),
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
}

// Re-export so callers needing to narrow on scrypt faults import from the client module
// alongside the client itself; the taxonomy itself lives in lib/errors.ts.
export { ScryptError };
