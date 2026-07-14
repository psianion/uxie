// Webhook receiver (D3): para-raid's only way to push events to us. Loopback-only Bun.serve,
// one route. Signature verify happens BEFORE the body is trusted at all — reference-adapter
// algorithm (para-raid/examples/reference-adapter/receiver.ts): constant-time compare of
// `sha256=<hex>` = HMAC-SHA256(secret, `${timestamp}.${rawBody}`). No timestamp-freshness
// window: this is a loopback listener and a legitimate retry re-signs with a fresh timestamp
// anyway.
//
// Dedup ordering (A5, CRITICAL — do NOT copy the reference receiver here): the event id is
// recorded as seen ONLY after the injected handler resolves successfully. Marking it before a
// failed post would falsely dedupe the daemon's redelivery and lose the message for good.
// ponytail: this leaves a small duplicate-delivery window — a handler that posts to Discord and
// then crashes before we return 200 gets redelivered and posts twice. Accepted per spec (A5);
// only a durable (WAL-backed) dedup store would close it, and nothing here needs that guarantee.
import { createHmac, timingSafeEqual } from "node:crypto";
import { log } from "../../lib/log.ts";

export interface ParaRaidEvent {
  eventId: string;
  eventType: string;
  sessionId: string | null;
  body: Record<string, unknown>;
}

// Resolve (2xx) to ack + dedup the delivery. Throw for a transient failure — the receiver
// returns 500 so para-raid's outbox retries. A permanent failure (e.g. the target Discord
// thread is gone) is handled INSIDE the handler (A2): it resolves normally instead of throwing.
export type EventHandler = (evt: ParaRaidEvent) => Promise<void>;

export interface ReceiverOpts {
  port: number;
  secret: string;
  handler: EventHandler;
}

export interface Receiver {
  port: number;
  stop(): void;
}

const WEBHOOK_PATH = "/api/webhooks/para-raid";
const DEDUP_PRUNE_MS = 20 * 60 * 1000; // retry_window_ms is 10 min (config.example.toml); 2x margin

export function startReceiver(opts: ReceiverOpts): Receiver {
  const seen = new Map<string, number>(); // eventId -> receivedAt

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== WEBHOOK_PATH) {
        return new Response("not found", { status: 404 });
      }

      const raw = await req.text();
      const ts = req.headers.get("X-Para-Raid-Timestamp") ?? "";
      const sig = req.headers.get("X-Para-Raid-Signature") ?? "";
      if (!verifySignature(opts.secret, ts, raw, sig)) {
        return new Response("invalid signature", { status: 401 });
      }

      const eventId = req.headers.get("X-Para-Raid-Event-Id") ?? "";
      prune(seen);
      if (eventId && seen.has(eventId)) {
        return new Response("ok (duplicate)");
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return new Response("invalid json", { status: 400 });
      }

      const evt: ParaRaidEvent = {
        eventId,
        eventType: String(parsed.event_type ?? ""),
        sessionId: (parsed.session_id as string | null) ?? null,
        body: parsed,
      };

      try {
        await opts.handler(evt);
      } catch (err) {
        log.error("para-raid webhook handler failed", { eventType: evt.eventType, eventId, err });
        return new Response("handler error", { status: 500 });
      }

      // A5: mark seen only now, after the handler has already succeeded.
      if (eventId) seen.set(eventId, Date.now());
      return new Response("ok");
    },
  });

  // server.port is `number | undefined` in bun-types (undefined only for a unix-socket
  // listener, which we never use here) — fall back to the requested port defensively.
  return { port: server.port ?? opts.port, stop: () => server.stop(true) };
}

function prune(seen: Map<string, number>): void {
  const cutoff = Date.now() - DEDUP_PRUNE_MS;
  for (const [id, at] of seen) {
    if (at < cutoff) seen.delete(id);
  }
}

/** Constant-time check of `sha256=<hex>` over `${ts}.${rawBody}`. Exported for tests. */
export function verifySignature(secret: string, ts: string, rawBody: string, signature: string): boolean {
  if (!ts || !signature) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
