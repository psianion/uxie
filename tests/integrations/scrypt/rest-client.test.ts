import { describe, expect, test } from "bun:test";
import { ScryptRestClient } from "../../../src/integrations/scrypt/rest-client.ts";

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
