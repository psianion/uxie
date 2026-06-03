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

// scrypt-contract §1.2: GET /api/daily_context drives /brief. The body is zod-parsed and
// projected to the uxie-facing simplified DailyContext (decision 2: parse, never cast).
// The tolerant parser accepts BOTH the simplified flat shape (used here / by /brief tests)
// AND the authoritative nested contract shape (today.journal.content, rich rows).
describe("ScryptRestClient.getDailyContext", () => {
  test("GETs /api/daily_context and returns parsed body (flat shape)", async () => {
    const payload = {
      today_journal: "morning",
      recent_notes: [{ path: "a.md", title: "A" }],
      open_threads: [{ path: "t.md", title: "T", priority: "high" }],
      active_memories: [{ name: "m" }],
      tag_cloud: [{ tag: "x", count: 3 }],
    };
    const restore = withFetch(async () => new Response(JSON.stringify(payload), { status: 200 }));
    try {
      const out = await client().getDailyContext();
      expect(out.today_journal).toBe("morning");
      expect(out.recent_notes[0]?.path).toBe("a.md");
      expect(out.open_threads[0]?.priority).toBe("high");
      expect(out.active_memories[0]?.name).toBe("m");
      expect(out.tag_cloud[0]).toEqual({ tag: "x", count: 3 });
    } finally {
      restore();
    }
  });

  test("maps the authoritative nested contract shape to the simplified DailyContext", async () => {
    // scrypt-contract §1.6 DailyContextResponse: nested today.journal + rich rows.
    const payload = {
      generated_at: "2026-06-03T00:00:00.000Z",
      today: { date: "2026-06-03", journal: { path: "journal/2026-06-03.md", content: "09:00 hi", exists: true } },
      recent_notes: [
        { path: "n.md", title: "N", modified: "2026-06-03T00:00:00.000Z", tags: ["x"], snippet: "s" },
      ],
      open_threads: [
        { slug: "t", title: "T", status: "open", priority: 5, last_run: null, prompt: null, path: "notes/threads/t.md" },
      ],
      active_memories: [
        { slug: "m", title: "Mem", category: "c", priority: 9, content: "body" },
      ],
      tag_cloud: [{ tag: "x", count: 3 }],
      related: { notes: [], memories: [], draft_prompts: [] },
    };
    const restore = withFetch(async () => new Response(JSON.stringify(payload), { status: 200 }));
    try {
      const out = await client().getDailyContext();
      expect(out.today_journal).toBe("09:00 hi");
      expect(out.recent_notes[0]?.path).toBe("n.md");
      // numeric contract priority is stringified for the simplified shape
      expect(out.open_threads[0]?.priority).toBe("5");
      expect(out.open_threads[0]?.path).toBe("notes/threads/t.md");
      // active memory `title` projects into the simplified `name`
      expect(out.active_memories[0]?.name).toBe("Mem");
      expect(out.tag_cloud[0]).toEqual({ tag: "x", count: 3 });
    } finally {
      restore();
    }
  });

  test("issues a GET with bearer auth and a 10s AbortSignal", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const restore = withFetch(async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ today_journal: "", recent_notes: [], open_threads: [], active_memories: [], tag_cloud: [] }), { status: 200 });
    });
    try {
      await client().getDailyContext();
      expect(capturedUrl).toBe("http://scrypt:3000/api/daily_context");
      expect(capturedInit?.method).toBe("GET");
      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer bearer");
      expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      restore();
    }
  });

  test("maps 401 to ScryptError(scrypt_auth)", async () => {
    const restore = withFetch(async () => new Response("", { status: 401 }));
    try {
      await expect(client().getDailyContext()).rejects.toMatchObject({ code: "scrypt_auth" });
    } finally {
      restore();
    }
  });

  test("maps 500 to ScryptError(scrypt_server)", async () => {
    const restore = withFetch(async () => new Response("", { status: 500 }));
    try {
      await expect(client().getDailyContext()).rejects.toMatchObject({ code: "scrypt_server" });
    } finally {
      restore();
    }
  });

  test("maps network refusal to ScryptError(scrypt_unreachable)", async () => {
    const restore = withFetch(async () => {
      throw new TypeError("fetch failed");
    });
    try {
      await expect(client().getDailyContext()).rejects.toMatchObject({ code: "scrypt_unreachable" });
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
      await expect(client().getDailyContext()).rejects.toMatchObject({ code: "scrypt_timeout" });
    } finally {
      restore();
    }
  });

  test("rejects an unparseable success body with ScryptError(scrypt_bad_response)", async () => {
    const restore = withFetch(async () => new Response(JSON.stringify({ recent_notes: "not-an-array" }), { status: 200 }));
    try {
      await expect(client().getDailyContext()).rejects.toMatchObject({ code: "scrypt_bad_response" });
    } finally {
      restore();
    }
  });
});
