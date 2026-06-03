// Wave 3 / Task 19. ScryptMcpClient is the HAND-ROLLED per-call JSON-RPC reader
// (ratified decision 2) over Bun fetch. One POST per read, no initialize handshake,
// no session header (scrypt-contract §2 COLD tools/call VERDICT: WORKS). Every tool
// payload is double-parsed (result.content[0].text is stringified JSON) then zod-parsed
// (scrypt-contract §2.1/§2.3) — never cast.
//
// These tests stub globalThis.fetch. They assert both the PLAN's simplified array shape
// (note_path / match_preview / chunk_text) AND the authoritative contract envelope
// ({ result: { content: [...] } } wrapping { results: [...] }) so the implementation is
// proven against the real scrypt wire protocol, not only the sketch.
import { describe, expect, test } from "bun:test";
import { ScryptMcpClient } from "../../../src/integrations/scrypt/mcp-client.ts";

type FetchImpl = (input: any, init?: any) => Promise<Response>;

function withFetch(impl: FetchImpl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
const c = () => new ScryptMcpClient("http://scrypt:3000/mcp", "bearer");

// PLAN-shape tool result: a bare { content: [{ type, text }] } (no JSON-RPC result wrapper).
function toolResult(data: unknown) {
  return new Response(
    JSON.stringify({ content: [{ type: "text", text: JSON.stringify(data) }] }),
    { status: 200 },
  );
}

// Contract-shape envelope: { jsonrpc, id, result: { content: [...] } }.
function envelope(data: unknown) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify(data) }] },
    }),
    { status: 200 },
  );
}

describe("ScryptMcpClient.searchNotes", () => {
  test("posts tool call and returns hits", async () => {
    let captured: any = null;
    const restore = withFetch(async (url, init) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)), init };
      return toolResult([{ note_path: "a.md", match_preview: "hit" }]);
    });
    try {
      const hits = await c().searchNotes("hello", 10);
      expect(captured.url).toBe("http://scrypt:3000/mcp");
      expect(captured.body.jsonrpc).toBe("2.0");
      expect(captured.body.method).toBe("tools/call");
      expect(captured.body.params.name).toBe("search_notes");
      expect(captured.body.params.arguments).toEqual({ query: "hello", limit: 10 });
      // Two required headers (scrypt-contract §2): Authorization + Content-Type.
      expect(captured.init.headers.Authorization).toBe("Bearer bearer");
      expect(captured.init.headers["Content-Type"]).toBe("application/json");
      expect(hits).toEqual([{ note_path: "a.md", match_preview: "hit" }]);
    } finally {
      restore();
    }
  });

  test("parses the contract { result: { content } } envelope wrapping { results }", async () => {
    const restore = withFetch(async () =>
      envelope({
        results: [
          {
            path: "notes/inbox/a.md",
            title: "A",
            snippet: "preview",
            score: 1.2,
            project: null,
            doc_type: null,
            thread: null,
          },
        ],
      }),
    );
    try {
      const hits = await c().searchNotes("hello", 10);
      expect(hits).toEqual([{ note_path: "notes/inbox/a.md", match_preview: "preview" }]);
    } finally {
      restore();
    }
  });

  test("maps 401 to scrypt_auth", async () => {
    const restore = withFetch(async () => new Response("", { status: 401 }));
    try {
      await expect(c().searchNotes("x", 5)).rejects.toMatchObject({ code: "scrypt_auth" });
    } finally {
      restore();
    }
  });

  test("maps 5xx to scrypt_server", async () => {
    const restore = withFetch(async () => new Response("", { status: 503 }));
    try {
      await expect(c().searchNotes("x", 5)).rejects.toMatchObject({ code: "scrypt_server" });
    } finally {
      restore();
    }
  });

  test("maps network fail to scrypt_unreachable", async () => {
    const restore = withFetch(async () => {
      throw new TypeError("x");
    });
    try {
      await expect(c().searchNotes("x", 5)).rejects.toMatchObject({ code: "scrypt_unreachable" });
    } finally {
      restore();
    }
  });

  test("maps a JSON-RPC error envelope to scrypt_tool_error", async () => {
    const restore = withFetch(
      async () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } }),
          { status: 200 },
        ),
    );
    try {
      await expect(c().searchNotes("x", 5)).rejects.toMatchObject({ code: "scrypt_tool_error" });
    } finally {
      restore();
    }
  });

  test("rejects a non-conforming tool payload (zod fail closed)", async () => {
    const restore = withFetch(async () => toolResult({ totally: "wrong" }));
    try {
      await expect(c().searchNotes("x", 5)).rejects.toMatchObject({ code: "scrypt_bad_response" });
    } finally {
      restore();
    }
  });
});

describe("ScryptMcpClient.semanticSearch", () => {
  test("calls semantic_search tool", async () => {
    let captured: any = null;
    const restore = withFetch(async (_u, init) => {
      captured = JSON.parse(String(init?.body));
      return toolResult([{ note_path: "a.md", chunk_text: "snippet", score: 0.9 }]);
    });
    try {
      const hits = await c().semanticSearch("q", 5);
      expect(captured.params.name).toBe("semantic_search");
      expect(captured.params.arguments).toEqual({ query: "q", limit: 5 });
      expect(hits[0]?.score).toBe(0.9);
    } finally {
      restore();
    }
  });

  test("parses the contract { results, model } envelope", async () => {
    const restore = withFetch(async () =>
      envelope({
        model: "text-embedding-3-small",
        results: [
          {
            path: "notes/a.md",
            title: "A",
            score: 0.87,
            snippet: "chunky",
            chunk_id: "c1",
            chunk_range: [0, 10],
            project: null,
            doc_type: null,
            thread: null,
          },
        ],
      }),
    );
    try {
      const hits = await c().semanticSearch("q", 5);
      expect(hits).toEqual([{ note_path: "notes/a.md", chunk_text: "chunky", score: 0.87 }]);
    } finally {
      restore();
    }
  });
});

describe("ScryptMcpClient.getNote", () => {
  test("calls get_note tool with path", async () => {
    let captured: any = null;
    const restore = withFetch(async (_u, init) => {
      captured = JSON.parse(String(init?.body));
      return toolResult({ path: "a.md", title: "A", body: "hi" });
    });
    try {
      const note = await c().getNote("a.md");
      expect(captured.params.name).toBe("get_note");
      expect(captured.params.arguments).toEqual({ path: "a.md" });
      expect(note.title).toBe("A");
      expect(note.body).toBe("hi");
    } finally {
      restore();
    }
  });

  test("parses the contract get_note envelope (frontmatter title fallback)", async () => {
    const restore = withFetch(async () =>
      envelope({
        path: "notes/a.md",
        frontmatter: { title: "Front A" },
        body: "the body",
        sections: [],
        metadata: {},
        outgoing_edges: [],
        incoming_edges: [],
      }),
    );
    try {
      const note = await c().getNote("notes/a.md");
      expect(note.path).toBe("notes/a.md");
      expect(note.title).toBe("Front A");
      expect(note.body).toBe("the body");
    } finally {
      restore();
    }
  });
});
