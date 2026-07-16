import { describe, expect, test } from "bun:test";
import { ScryptRestClient, captureSlug } from "../../../src/integrations/scrypt/rest-client.ts";
import {
  ScryptError,
  ScryptAuthError,
  ScryptBadRequestError,
  ScryptTimeoutError,
} from "../../../src/lib/errors.ts";
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
  test("returns {ok:true} when daily-context 200", async () => {
    const restore = withFetch(async () => new Response(JSON.stringify({}), { status: 200 }));
    try {
      expect(await client().health()).toEqual({ ok: true });
    } finally {
      restore();
    }
  });

  test("probes GET /api/daily-context (canonical) with bearer auth and 500ms timeout", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const restore = withFetch(async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response("{}", { status: 200 });
    });
    try {
      await client().health();
      expect(capturedUrl).toBe("http://scrypt:3000/api/daily-context");
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

// === v2 capture/query surface ===

function mcpEnvelope(payload: unknown, isError = false) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "uxie-1",
      result: {
        ...(isError ? { isError: true } : {}),
        content: [{ type: "text", text: JSON.stringify(payload) }],
      },
    }),
    { status: 200 },
  );
}

const BUNDLE = {
  date: "2026-07-16",
  entries: [{ id: "2026-07-16T09:30:00.000Z", displayTime: "9:30 AM", body: "hello" }],
  tasks_due: [],
  related: [],
};

describe("ScryptRestClient.createNote (MCP create_note)", () => {
  test("posts a cold tools/call to /mcp with bearer auth, correlation header, and a projects/_inbox path", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const restore = withFetch(async (u, i) => {
      url = String(u);
      init = i;
      const args = JSON.parse(String(i?.body)).params.arguments;
      return mcpEnvelope({ note_path: args.path });
    });
    try {
      const res = await client().createNote({
        title: "Hello World!",
        content: "Hello World!\nbody",
        clientTag: "uxie-42",
      });
      expect(url).toBe("http://scrypt:3000/mcp");
      const headers = init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer bearer");
      expect(headers["X-Correlation-Id"]).toBe("uxie-42");
      const body = JSON.parse(String(init?.body));
      expect(body.jsonrpc).toBe("2.0");
      expect(body.method).toBe("tools/call");
      expect(body.params.name).toBe("create_note");
      expect(body.params.arguments.client_tag).toBe("uxie-42");
      // path: projects/_inbox/other/<utc stamp>-<slug>.md — the unintegrated-inbox convention
      expect(body.params.arguments.path).toMatch(
        /^projects\/_inbox\/other\/\d{4}-\d{2}-\d{2}-\d{4}-hello-world\.md$/,
      );
      // frontmatter must mirror the path segments (create_note validates project/doc_type/slug)
      expect(body.params.arguments.content).toContain("project: _inbox");
      expect(body.params.arguments.content).toContain("doc_type: other");
      expect(body.params.arguments.content).toContain("Hello World!\nbody");
      expect(res.path).toMatch(/^projects\/_inbox\/other\//);
    } finally {
      restore();
    }
  });

  test("sends the same client_tag on a retry (idempotency key stability)", async () => {
    const tags: string[] = [];
    const restore = withFetch(async (_u, i) => {
      tags.push(JSON.parse(String(i?.body)).params.arguments.client_tag);
      return mcpEnvelope({ note_path: "projects/_inbox/other/x.md" });
    });
    try {
      const c = client();
      await c.createNote({ title: "t", content: "c", clientTag: "uxie-same" });
      await c.createNote({ title: "t", content: "c", clientTag: "uxie-same" });
      expect(tags).toEqual(["uxie-same", "uxie-same"]);
    } finally {
      restore();
    }
  });

  test("maps a tool-execution error (result.isError) to ScryptError with the server message", async () => {
    const restore = withFetch(async () =>
      mcpEnvelope(
        { code: -32602, message: "path must match projects/<project>/<doc_type>/<slug>.md" },
        true,
      ),
    );
    try {
      const c = client();
      const p = c.createNote({ title: "t", content: "c", clientTag: "uxie-1" });
      await expect(p).rejects.toBeInstanceOf(ScryptError);
      await expect(
        c.createNote({ title: "t", content: "c", clientTag: "uxie-1" }),
      ).rejects.toThrow("path must match");
    } finally {
      restore();
    }
  });

  test("maps a JSON-RPC protocol error to ScryptError", async () => {
    const restore = withFetch(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32601, message: "unknown method" },
          }),
          { status: 200 },
        ),
    );
    try {
      await expect(
        client().createNote({ title: "t", content: "c", clientTag: "uxie-1" }),
      ).rejects.toThrow("unknown method");
    } finally {
      restore();
    }
  });

  test("401 maps to ScryptAuthError", async () => {
    const restore = withFetch(async () => new Response("", { status: 401 }));
    try {
      await expect(
        client().createNote({ title: "t", content: "c", clientTag: "uxie-1" }),
      ).rejects.toBeInstanceOf(ScryptAuthError);
    } finally {
      restore();
    }
  });
});

describe("captureSlug", () => {
  const at = new Date("2026-07-16T09:30:00Z");

  test("utc stamp + slugified title, scrypt SLUG_RE-safe, <=40 chars", () => {
    const s = captureSlug("Hello, World — again!", at);
    expect(s).toBe("2026-07-16-0930-hello-world-again");
    expect(s).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(s.length).toBeLessThanOrEqual(40);
  });

  test("caps long titles at 40 chars without a trailing hyphen", () => {
    const s = captureSlug("a very long capture title that keeps going and going", at);
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  test("falls back to the stamp alone when the title has no slug characters", () => {
    expect(captureSlug("!!!", at)).toBe("2026-07-16-0930");
  });
});

describe("ScryptRestClient.journalEntry", () => {
  test("POSTs {body} to /api/journal/<utc-today>/entries and returns the day bundle", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const restore = withFetch(async (u, i) => {
      url = String(u);
      init = i;
      return new Response(JSON.stringify(BUNDLE), { status: 200 });
    });
    try {
      const bundle = await client().journalEntry("hello", "uxie-7");
      const today = new Date().toISOString().slice(0, 10);
      expect(url).toBe(`http://scrypt:3000/api/journal/${today}/entries`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ body: "hello" });
      const headers = init?.headers as Record<string, string>;
      expect(headers["X-Correlation-Id"]).toBe("uxie-7");
      expect(bundle.entries[0]!.id).toBe("2026-07-16T09:30:00.000Z");
    } finally {
      restore();
    }
  });

  test("400 maps to ScryptBadRequestError carrying the server message", async () => {
    const restore = withFetch(
      async () => new Response(JSON.stringify({ error: "body required" }), { status: 400 }),
    );
    try {
      const c = client();
      await expect(c.journalEntry("", "uxie-7")).rejects.toBeInstanceOf(ScryptBadRequestError);
      await expect(c.journalEntry("", "uxie-7")).rejects.toThrow("body required");
    } finally {
      restore();
    }
  });

  test("timeout maps to ScryptTimeoutError (retryable)", async () => {
    const restore = withFetch(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    try {
      await expect(client().journalEntry("x", "uxie-7")).rejects.toBeInstanceOf(ScryptTimeoutError);
    } finally {
      restore();
    }
  });
});

describe("ScryptRestClient.hybridSearch", () => {
  const HIT = {
    path: "projects/scrypt/spec/vault-sync.md",
    title: "Vault Sync",
    project: "scrypt",
    doc_type: "spec",
    description: null,
    excerpt: "first chars",
    score: 0.0325,
    fts_rank: 1,
    sem_rank: 2,
  };

  test("GETs /api/search/hybrid with url-encoded q and limit, parses hits", async () => {
    let url = "";
    const restore = withFetch(async (u) => {
      url = String(u);
      return new Response(JSON.stringify({ query: "vault sync", hits: [HIT] }), { status: 200 });
    });
    try {
      const res = await client().hybridSearch("vault sync", { limit: 5, clientTag: "uxie-9" });
      expect(url).toBe("http://scrypt:3000/api/search/hybrid?q=vault+sync&limit=5");
      expect(res.hits[0]!.score).toBeCloseTo(0.0325);
    } finally {
      restore();
    }
  });

  test("unexpected response shape maps to ScryptError (never cast)", async () => {
    const restore = withFetch(async () => new Response(JSON.stringify({ nope: true }), { status: 200 }));
    try {
      await expect(client().hybridSearch("q")).rejects.toThrow("unexpected response shape");
    } finally {
      restore();
    }
  });
});

describe("ScryptRestClient.dailyContext", () => {
  const DC = {
    generated_at: "2026-07-16T09:30:00.000Z",
    today: {
      date: "2026-07-16",
      journal: { path: "journal/2026-07-16.md", content: "", exists: false },
    },
    recent_notes: [],
    open_threads: [],
    active_memories: [],
    tag_cloud: [],
  };

  test("GETs the canonical /api/daily-context and parses", async () => {
    let url = "";
    const restore = withFetch(async (u) => {
      url = String(u);
      return new Response(JSON.stringify(DC), { status: 200 });
    });
    try {
      const dc = await client().dailyContext("uxie-3");
      expect(url).toBe("http://scrypt:3000/api/daily-context");
      expect(dc.today.journal.exists).toBe(false);
    } finally {
      restore();
    }
  });

  test("5xx maps to ScryptError('scrypt_server')", async () => {
    const restore = withFetch(async () => new Response("", { status: 503 }));
    try {
      const c = client();
      await expect(c.dailyContext()).rejects.toBeInstanceOf(ScryptError);
      await expect(c.dailyContext()).rejects.toThrow("server error (503)");
    } finally {
      restore();
    }
  });
});
