// Read-only MCP client for the scrypt vault (Wave 3 / Task 19). HAND-ROLLED per-call
// JSON-RPC 2.0 over Bun fetch (ratified decision 2) — NO @modelcontextprotocol/sdk. The
// scrypt MCP endpoint is request-scoped and stateless: a bare `tools/call` works with no
// `initialize` handshake and no session header (scrypt-contract §2 — "COLD tools/call
// VERDICT: WORKS"). So each read is exactly one POST.
//
// Wire recipe (scrypt-contract §2):
//   1. POST ${SCRYPT_MCP_URL} with exactly two headers (Authorization + Content-Type) +
//      AbortSignal.timeout(10_000) (decision 5).
//   2. Body { jsonrpc, id, method: "tools/call", params: { name, arguments } }.
//   3. Envelope { jsonrpc, id, result?, error? }. On `error` -> throw a ScryptError.
//   4. DOUBLE-PARSE: the tool payload sits at result.content[0].text as STRINGIFIED JSON.
//      JSON.parse it, THEN zod-parse the object — never cast (decision 2).
//
// Tolerance: the authoritative contract wraps the payload in result.content (§2.1) and the
// payload itself is { results: [...] } (§2.3). We also accept a bare top-level `content`
// array and a bare results array — the same per-tool zod union — so the client is robust to
// the stateless server returning either streamable-http shape. The simplified uxie-facing
// hit interfaces (note_path / match_preview / chunk_text) are what lib/embed.ts and the
// /search + /ask command bodies consume; mapping from the rich contract rows happens here.
import { z } from "zod";
import { ScryptError } from "../../lib/errors.ts";

// uxie-facing read shapes (consumed by lib/embed.ts + commands). Kept deliberately small:
// the embeds only render a path + a preview/score, so we project the contract rows down.
export interface SearchHit {
  note_path: string;
  match_preview: string;
}
export interface SemanticHit {
  note_path: string;
  chunk_text: string;
  score: number;
}
export interface Note {
  path: string;
  title: string;
  body: string;
}

// JSON-RPC envelope (scrypt-contract §2.1). Parsed first; never cast. `result.content` is
// the tool payload carrier; `error` is the JSON-RPC fault object.
const McpEnvelope = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  result: z
    .object({
      content: z.array(z.object({ type: z.string(), text: z.string() })).min(1),
      isError: z.boolean().optional(),
    })
    .optional(),
  // The PLAN/stateless server may also return the content array at the top level.
  content: z.array(z.object({ type: z.string(), text: z.string() })).min(1).optional(),
  isError: z.boolean().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

// search_notes payload (scrypt-contract §2.3) OR the PLAN's simplified array. Either way we
// project to SearchHit { note_path, match_preview }.
const SearchRow = z.object({
  path: z.string(),
  title: z.string().optional(),
  snippet: z.string(),
  score: z.number().optional(),
  project: z.string().nullable().optional(),
  doc_type: z.string().nullable().optional(),
  thread: z.string().nullable().optional(),
});
const SimpleSearchHit = z.object({ note_path: z.string(), match_preview: z.string() });
const SearchPayload = z.union([
  z.object({ results: z.array(SearchRow) }),
  z.array(SimpleSearchHit),
]);

// semantic_search payload (scrypt-contract §2.3) OR the PLAN's simplified array. Projects to
// SemanticHit { note_path, chunk_text, score }.
const SemanticRow = z.object({
  path: z.string(),
  title: z.string().optional(),
  score: z.number(),
  snippet: z.string(),
  chunk_id: z.string().optional(),
  chunk_range: z.tuple([z.number(), z.number()]).optional(),
  project: z.string().nullable().optional(),
  doc_type: z.string().nullable().optional(),
  thread: z.string().nullable().optional(),
});
const SimpleSemanticHit = z.object({
  note_path: z.string(),
  chunk_text: z.string(),
  score: z.number(),
});
const SemanticPayload = z.union([
  z.object({ results: z.array(SemanticRow), model: z.string().optional() }),
  z.array(SimpleSemanticHit),
]);

// get_note payload (scrypt-contract §2.3, intentionally loose on sections/metadata) OR the
// PLAN's simplified { path, title, body }. Projects to Note.
const NotePayload = z.union([
  z.object({
    path: z.string(),
    frontmatter: z.record(z.unknown()),
    body: z.string(),
    sections: z.array(z.unknown()),
    metadata: z.record(z.unknown()),
    outgoing_edges: z.array(z.unknown()),
    incoming_edges: z.array(z.unknown()),
  }),
  z.object({ path: z.string(), title: z.string(), body: z.string() }),
]);

// zod-parse the double-parsed tool payload; map a parse failure to a typed ScryptError so
// it funnels through the router's catch site like any other scrypt fault (never a raw
// ZodError). Decision 2: zod-parse every response, never cast.
function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ScryptError("scrypt_bad_response", "scrypt returned an unexpected tool payload");
  return parsed.data;
}

export class ScryptMcpClient {
  constructor(
    private url: string,
    private bearer: string,
  ) {}

  async searchNotes(query: string, limit: number): Promise<SearchHit[]> {
    const payload = parseOrThrow(SearchPayload, await this.call("search_notes", { query, limit }));
    if (Array.isArray(payload)) return payload;
    return payload.results.map((r) => ({ note_path: r.path, match_preview: r.snippet }));
  }

  async semanticSearch(query: string, limit: number): Promise<SemanticHit[]> {
    const payload = parseOrThrow(
      SemanticPayload,
      await this.call("semantic_search", { query, limit }),
    );
    if (Array.isArray(payload)) return payload;
    return payload.results.map((r) => ({
      note_path: r.path,
      chunk_text: r.snippet,
      score: r.score,
    }));
  }

  async getNote(path: string): Promise<Note> {
    const payload = parseOrThrow(NotePayload, await this.call("get_note", { path }));
    if ("title" in payload) return payload;
    const fmTitle = payload.frontmatter.title;
    const title = typeof fmTitle === "string" && fmTitle.length > 0 ? fmTitle : payload.path;
    return { path: payload.path, title, body: payload.body };
  }

  // One POST per read. Returns the double-parsed, still-untyped tool payload; each public
  // method zod-parses it with the matching schema. Throws a typed ScryptError on transport
  // faults, HTTP error statuses, JSON-RPC errors, or a missing/garbled tool payload — there
  // is no try/catch upstream in command bodies (decision 10); the router maps it.
  private async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    };

    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      const name = (e as Error).name;
      if (name === "TimeoutError") throw new ScryptError("scrypt_timeout", "scrypt timed out", e);
      throw new ScryptError("scrypt_unreachable", "scrypt unreachable", e);
    }

    if (res.status === 401 || res.status === 403)
      throw new ScryptError("scrypt_auth", "scrypt auth rejected");
    if (res.status >= 500) throw new ScryptError("scrypt_server", "scrypt server error");
    if (res.status !== 200) {
      const txt = await res.text().catch(() => "");
      throw new ScryptError("scrypt_bad_request", `scrypt: ${txt || res.statusText}`);
    }

    const json = await res.json().catch(() => null);
    const env = McpEnvelope.safeParse(json);
    if (!env.success)
      throw new ScryptError("scrypt_bad_response", "scrypt returned an unexpected mcp envelope");
    const e = env.data;
    if (e.error) throw new ScryptError("scrypt_tool_error", `scrypt tool failed: ${e.error.message}`);

    const carrier = e.result ?? e;
    if (carrier.isError) throw new ScryptError("scrypt_tool_error", "scrypt tool failed");
    const textPart = carrier.content?.find((p) => p.type === "text")?.text;
    if (textPart === undefined)
      throw new ScryptError("scrypt_tool_error", "scrypt returned empty tool result");

    try {
      return JSON.parse(textPart);
    } catch (err) {
      throw new ScryptError("scrypt_bad_response", "scrypt tool payload was not valid json", err);
    }
  }
}

// Re-export alongside the client so read-command callers narrowing on scrypt faults import
// from one module (mirrors rest-client.ts).
export { ScryptError };
