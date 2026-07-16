// Repo's first tests for the para-raid module. Placed under tests/ (mirroring every other
// module's tests/<path>.test.ts, e.g. tests/integrations/onboarding/) rather than colocated in
// src/, matching this repo's one existing test-layout convention.
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  startReceiver,
  verifySignature,
  type ParaRaidEvent,
} from "../../../src/integrations/para-raid/receiver.ts";
import { formatReply } from "../../../src/integrations/para-raid/events.ts";

const SECRET = "test-secret";
const PATH = "/api/webhooks/para-raid";

function sign(ts: string, body: string): string {
  return "sha256=" + createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
}

function post(port: number, body: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${PATH}`, { method: "POST", body, headers });
}

describe("verifySignature", () => {
  test("accepts a correctly signed payload", () => {
    const ts = "1700000000";
    const body = '{"a":1}';
    expect(verifySignature(SECRET, ts, body, sign(ts, body))).toBe(true);
  });

  test("rejects a tampered body", () => {
    const ts = "1700000000";
    const body = '{"a":1}';
    const sig = sign(ts, body);
    expect(verifySignature(SECRET, ts, '{"a":2}', sig)).toBe(false);
  });

  test("rejects a signature made with the wrong secret", () => {
    const ts = "1700000000";
    const body = '{"a":1}';
    const sig = "sha256=" + createHmac("sha256", "wrong-secret").update(`${ts}.${body}`).digest("hex");
    expect(verifySignature(SECRET, ts, body, sig)).toBe(false);
  });

  test("rejects a missing timestamp or signature", () => {
    expect(verifySignature(SECRET, "", "body", "sha256=x")).toBe(false);
    expect(verifySignature(SECRET, "1700000000", "body", "")).toBe(false);
  });
});

describe("startReceiver — routing + signature", () => {
  test("404s any route other than POST /api/webhooks/para-raid", async () => {
    const r = startReceiver({ port: 0, secret: SECRET, handler: async () => {} });
    try {
      const wrongPath = await fetch(`http://127.0.0.1:${r.port}/nope`, { method: "POST", body: "{}" });
      expect(wrongPath.status).toBe(404);
      const wrongMethod = await fetch(`http://127.0.0.1:${r.port}${PATH}`, { method: "GET" });
      expect(wrongMethod.status).toBe(404);
    } finally {
      r.stop();
    }
  });

  test("401s on an invalid signature", async () => {
    const r = startReceiver({ port: 0, secret: SECRET, handler: async () => {} });
    try {
      const body = JSON.stringify({ event_type: "session_live", session_id: "s1" });
      const res = await post(r.port, body, {
        "X-Para-Raid-Timestamp": "1700000000",
        "X-Para-Raid-Signature": "sha256=deadbeef",
        "X-Para-Raid-Event-Id": "evt-1",
      });
      expect(res.status).toBe(401);
    } finally {
      r.stop();
    }
  });

  test("200s and dispatches the parsed event on a valid signature", async () => {
    const received: ParaRaidEvent[] = [];
    const r = startReceiver({
      port: 0,
      secret: SECRET,
      handler: async (evt) => {
        received.push(evt);
      },
    });
    try {
      const ts = String(Date.now());
      const body = JSON.stringify({ event_type: "session_live", session_id: "s1" });
      const res = await post(r.port, body, {
        "X-Para-Raid-Timestamp": ts,
        "X-Para-Raid-Signature": sign(ts, body),
        "X-Para-Raid-Event-Id": "evt-2",
      });
      expect(res.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]?.eventType).toBe("session_live");
      expect(received[0]?.sessionId).toBe("s1");
    } finally {
      r.stop();
    }
  });
});

// A5, CRITICAL: the event id is recorded as seen ONLY after the handler resolves successfully.
// Marking it before a failed post would falsely dedupe the daemon's redelivery and lose the
// message for good — this is the one behavior that must NOT match the reference receiver.
describe("startReceiver — dedup ordering (A5)", () => {
  test("a redelivery of a failed event id is reprocessed, not deduped", async () => {
    let calls = 0;
    let shouldFail = true;
    const r = startReceiver({
      port: 0,
      secret: SECRET,
      handler: async () => {
        calls++;
        if (shouldFail) throw new Error("boom");
      },
    });
    try {
      const ts = String(Date.now());
      const body = JSON.stringify({ event_type: "turn_replied", session_id: "s1" });
      const headers = {
        "X-Para-Raid-Timestamp": ts,
        "X-Para-Raid-Signature": sign(ts, body),
        "X-Para-Raid-Event-Id": "evt-dedup",
      };

      const first = await post(r.port, body, headers);
      expect(first.status).toBe(500);
      expect(calls).toBe(1);

      // Same event id, redelivered after the failure — must be reprocessed, not deduped.
      shouldFail = false;
      const second = await post(r.port, body, headers);
      expect(second.status).toBe(200);
      expect(calls).toBe(2);

      // NOW that the handler has succeeded once, a true duplicate delivery is deduped.
      const third = await post(r.port, body, headers);
      expect(third.status).toBe(200);
      expect(calls).toBe(2); // not reprocessed
    } finally {
      r.stop();
    }
  });
});

// A1: send-turn.ts's reply is `reply ?? ""` — Discord 400s on empty message content.
describe("formatReply (A1 — empty reply guard)", () => {
  test("empty string becomes the placeholder", () => {
    expect(formatReply("")).toBe("(no textual output)");
  });
  test("absent/undefined becomes the placeholder", () => {
    expect(formatReply(undefined)).toBe("(no textual output)");
  });
  test("a real reply passes through unchanged", () => {
    expect(formatReply("hello")).toBe("hello");
  });
});

test("concurrent duplicate delivery coalesces onto one handler run", async () => {
  let calls = 0;
  let release: (v?: unknown) => void = () => {};
  const gate = new Promise((r) => { release = r; });
  const receiver = startReceiver({
    port: 0,
    secret: SECRET,
    handler: async () => { calls++; await gate; },
  });
  try {
    const ts = "1700000000";
    const body = JSON.stringify({ event_type: "session_live", session_id: "s1" });
    const headers = {
      "X-Para-Raid-Timestamp": ts,
      "X-Para-Raid-Signature": sign(ts, body),
      "X-Para-Raid-Event-Id": "evt-concurrent-1",
    };
    const [r1, r2] = [post(receiver.port, body, headers), post(receiver.port, body, headers)];
    await new Promise((r) => setTimeout(r, 100));
    release();
    const [a, b] = await Promise.all([r1, r2]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(calls).toBe(1);
  } finally {
    receiver.stop();
  }
});
