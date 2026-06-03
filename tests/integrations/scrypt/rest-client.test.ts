import { describe, expect, test } from "bun:test";
import { ScryptRestClient } from "../../../src/integrations/scrypt/rest-client.ts";
import { ScryptError } from "../../../src/lib/errors.ts";

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

// scrypt-contract §1.1: POST /api/ingest. The deterministic client_tag is the
// X-Correlation-Id HEADER (decision 3), NOT a body field. Wire body is contract-shaped
// { kind, title, content, frontmatter? }; success is 201 returning { path, kind, created }.
// ingest() adapts that to the uxie-facing { path, permalink } (Design §5/§6.1).
function ingestOk(path = "notes/inbox/hello.md") {
  return new Response(JSON.stringify({ path, kind: "note", created: true }), { status: 201 });
}

describe("ScryptRestClient.ingest", () => {
  test("POSTs contract-shaped body to /api/ingest and returns {path, permalink}", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;
    let capturedInit: RequestInit | undefined;
    const restore = withFetch(async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      capturedBody = JSON.parse(String(init?.body));
      return ingestOk();
    });
    try {
      const out = await client().ingest({ kind: "note", content: "hello", clientTag: "uxie-1" });
      expect(capturedUrl).toBe("http://scrypt:3000/api/ingest");
      expect(capturedInit?.method).toBe("POST");
      // Correlation rides the header (decision 3 / contract §1.1), never the body.
      expect(capturedBody.client_tag).toBeUndefined();
      expect(capturedBody.kind).toBe("note");
      expect(capturedBody.content).toBe("hello");
      expect(typeof capturedBody.title).toBe("string");
      expect(out).toEqual({ path: "notes/inbox/hello.md", permalink: "http://scrypt:3000/notes/inbox/hello" });
    } finally {
      restore();
    }
  });

  test("sends X-Correlation-Id header equal to clientTag with bearer + 10s timeout", async () => {
    let headers: Record<string, string> = {};
    let signal: AbortSignal | undefined;
    const restore = withFetch(async (_u, init) => {
      headers = init?.headers as Record<string, string>;
      signal = init?.signal as AbortSignal;
      return ingestOk();
    });
    try {
      await client().ingest({ kind: "note", content: "x", clientTag: "uxie-iid-9" });
      expect(headers["X-Correlation-Id"]).toBe("uxie-iid-9");
      expect(headers["Authorization"]).toBe("Bearer bearer");
      expect(headers["Content-Type"]).toBe("application/json");
      expect(signal).toBeInstanceOf(AbortSignal);
    } finally {
      restore();
    }
  });

  test("accepts a 200 success body as well as 201", async () => {
    const restore = withFetch(
      async () => new Response(JSON.stringify({ path: "notes/inbox/a.md", kind: "note", created: true }), { status: 200 }),
    );
    try {
      const out = await client().ingest({ kind: "note", content: "x", clientTag: "t" });
      expect(out.path).toBe("notes/inbox/a.md");
    } finally {
      restore();
    }
  });

  test("forwards tz into frontmatter for non-journal kinds", async () => {
    let body: any = null;
    const restore = withFetch(async (_u, init) => {
      body = JSON.parse(String(init?.body));
      return ingestOk("notes/thought/t.md");
    });
    try {
      await client().ingest({ kind: "thought", content: "line", clientTag: "uxie-2", tz: "Asia/Kolkata" });
      expect(body.frontmatter.tz).toBe("Asia/Kolkata");
    } finally {
      restore();
    }
  });

  test("does NOT forward tz for journal kind (server ignores it; contract BLOCKER 1)", async () => {
    let body: any = null;
    const restore = withFetch(async (_u, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ path: "journal/2026-06-03.md", kind: "journal", created: false }), { status: 201 });
    });
    try {
      await client().ingest({ kind: "journal", content: "line", clientTag: "uxie-3", tz: "Asia/Kolkata" });
      expect(body.frontmatter).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("maps 401 to ScryptError(scrypt_auth)", async () => {
    const restore = withFetch(async () => new Response("", { status: 401 }));
    try {
      await expect(client().ingest({ kind: "note", content: "x", clientTag: "t" })).rejects.toMatchObject({
        code: "scrypt_auth",
      });
      await expect(client().ingest({ kind: "note", content: "x", clientTag: "t" })).rejects.toBeInstanceOf(ScryptError);
    } finally {
      restore();
    }
  });

  test("maps 500 to ScryptError(scrypt_server)", async () => {
    const restore = withFetch(async () => new Response("boom", { status: 500 }));
    try {
      await expect(client().ingest({ kind: "note", content: "x", clientTag: "t" })).rejects.toMatchObject({
        code: "scrypt_server",
      });
    } finally {
      restore();
    }
  });

  test("maps 400 to ScryptError(scrypt_bad_request)", async () => {
    const restore = withFetch(async () => new Response(JSON.stringify({ error: "bad" }), { status: 400 }));
    try {
      await expect(client().ingest({ kind: "note", content: "x", clientTag: "t" })).rejects.toMatchObject({
        code: "scrypt_bad_request",
      });
    } finally {
      restore();
    }
  });

  test("maps network refusal to ScryptError(scrypt_unreachable)", async () => {
    const restore = withFetch(async () => {
      throw new TypeError("fetch failed");
    });
    try {
      await expect(client().ingest({ kind: "note", content: "x", clientTag: "t" })).rejects.toMatchObject({
        code: "scrypt_unreachable",
      });
    } finally {
      restore();
    }
  });

  test("maps AbortSignal timeout to ScryptError(scrypt_timeout)", async () => {
    const restore = withFetch(async () => {
      const e: any = new Error("t");
      e.name = "TimeoutError";
      throw e;
    });
    try {
      await expect(client().ingest({ kind: "note", content: "x", clientTag: "t" })).rejects.toMatchObject({
        code: "scrypt_timeout",
      });
    } finally {
      restore();
    }
  });

  test("rejects an unparseable success body with ScryptError(scrypt_bad_response)", async () => {
    const restore = withFetch(async () => new Response(JSON.stringify({ nope: true }), { status: 201 }));
    try {
      await expect(client().ingest({ kind: "note", content: "x", clientTag: "t" })).rejects.toMatchObject({
        code: "scrypt_bad_response",
      });
    } finally {
      restore();
    }
  });
});
