import { describe, expect, test } from "bun:test";
import { ScryptRestClient } from "../../../src/integrations/scrypt/rest-client.ts";
import { setLogSink, type LogEntry } from "../../../src/lib/log.ts";

type FetchImpl = (input: any, init?: any) => Promise<Response>;

function withFetch(impl: FetchImpl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function client() {
  return new ScryptRestClient("http://scrypt:3000", "bearer");
}

// Capture warn/error entries emitted during fn() via the log sink hook.
async function captureLogs(fn: () => Promise<void>): Promise<LogEntry[]> {
  const entries: LogEntry[] = [];
  setLogSink((e) => entries.push(e));
  try {
    await fn();
  } finally {
    setLogSink(null);
  }
  return entries;
}

describe("ScryptRestClient.health", () => {
  test("returns {ok:true} when daily_context 200", async () => {
    const restore = withFetch(async () => new Response(JSON.stringify({}), { status: 200 }));
    try {
      expect(await client().health()).toEqual({ ok: true });
    } finally {
      restore();
    }
  });

  test("probes GET /api/daily_context with bearer auth and 500ms timeout", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const restore = withFetch(async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response("{}", { status: 200 });
    });
    try {
      await client().health();
      expect(capturedUrl).toBe("http://scrypt:3000/api/daily_context");
      expect(capturedInit?.method).toBe("GET");
      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer bearer");
      expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      restore();
    }
  });

  test("returns {ok:false,reason:'unreachable'} on fetch reject", async () => {
    const restore = withFetch(async () => {
      throw new TypeError("fetch failed");
    });
    try {
      const h = await client().health();
      expect(h.ok).toBe(false);
      expect(h.reason).toBe("unreachable");
    } finally {
      restore();
    }
  });

  test("returns {ok:false,reason:'auth'} on 401", async () => {
    const restore = withFetch(async () => new Response("", { status: 401 }));
    try {
      expect((await client().health()).reason).toBe("auth");
    } finally {
      restore();
    }
  });

  test("returns {ok:false,reason:'auth'} on 403", async () => {
    const restore = withFetch(async () => new Response("", { status: 403 }));
    try {
      expect((await client().health()).reason).toBe("auth");
    } finally {
      restore();
    }
  });

  test("returns {ok:false,reason:'server'} on 500", async () => {
    const restore = withFetch(async () => new Response("", { status: 500 }));
    try {
      expect((await client().health()).reason).toBe("server");
    } finally {
      restore();
    }
  });

  test("returns {ok:false,reason:'timeout'} when AbortSignal.timeout fires", async () => {
    const restore = withFetch(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    try {
      const h = await client().health();
      expect(h.reason).toBe("timeout");
    } finally {
      restore();
    }
  });
});

describe("ScryptRestClient.health connectivity transitions", () => {
  test("logs a single warn on the down transition, silent on repeat-down probes", async () => {
    const c = client();
    const restore = withFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    try {
      const logs = await captureLogs(async () => {
        await c.health(); // null -> down : logs once
        await c.health(); // down -> down : silent
        await c.health(); // down -> down : silent
      });
      const lost = logs.filter((l) => l.msg === "scrypt connectivity lost");
      expect(lost.length).toBe(1);
      expect(lost[0]!.level).toBe("warn");
      expect(lost[0]!.fields.reason).toBe("unreachable");
    } finally {
      restore();
    }
  });

  test("logs 'restored' once when it comes back up after being down", async () => {
    const c = client();
    let up = false;
    const restore = withFetch(async () =>
      up ? new Response("{}", { status: 200 }) : Promise.reject(new Error("down")),
    );
    try {
      const logs = await captureLogs(async () => {
        await c.health(); // null -> down : "lost"
        up = true;
        await c.health(); // down -> up : "restored"
        await c.health(); // up -> up : silent
      });
      expect(logs.map((l) => l.msg)).toEqual([
        "scrypt connectivity lost",
        "scrypt connectivity restored",
      ]);
    } finally {
      restore();
    }
  });

  test("does NOT log when the first-ever probe is healthy (no news)", async () => {
    const c = client();
    const restore = withFetch(async () => new Response("{}", { status: 200 }));
    try {
      const logs = await captureLogs(async () => {
        await c.health(); // null -> up : silent
        await c.health(); // up -> up : silent
      });
      expect(logs.length).toBe(0);
    } finally {
      restore();
    }
  });
});
