// Zod schemas for the Scrypt v2 contract (docs/research/scrypt-contract.md, verified against
// scrypt main). Every response is zod-parsed, never cast. Fields uxie actually renders are
// strict; arrays we never look inside (tasks_due, related, active_memories, tag_cloud) stay
// z.unknown() so a server-side field addition there can't break a command that ignores them.
import { z } from "zod";

// === HYBRID SEARCH (GET /api/search/hybrid) ===

export const HybridHit = z.object({
  path: z.string(),
  title: z.string(),
  project: z.string().nullable(),
  doc_type: z.string().nullable(),
  description: z.string().nullable(),
  excerpt: z.string(),
  // RRF sum: each ranker contributes 1/(60+rank). > 1/61 ⇒ both rankers agree.
  score: z.number(),
  fts_rank: z.number().nullable(),
  sem_rank: z.number().nullable(),
});
export type HybridHit = z.infer<typeof HybridHit>;

export const HybridSearchResponse = z.object({
  query: z.string(),
  hits: z.array(HybridHit),
});
export type HybridSearchResponse = z.infer<typeof HybridSearchResponse>;

// === JOURNAL (GET/POST/PATCH/DELETE /api/journal/... → day bundle) ===

export const JournalEntryItem = z.object({
  id: z.string(), // exact UTC ISO timestamp, stamped server-side
  displayTime: z.string(),
  body: z.string(),
});
export type JournalEntryItem = z.infer<typeof JournalEntryItem>;

// Loose parses of the bundle's side-lists (server shapes: tasks-repo Task / related RelatedNote).
// Only the fields uxie renders; .catch keeps a malformed row from failing the whole bundle.
export const JournalTask = z.object({
  title: z.string().catch("(untitled task)"),
  status: z.string().catch("open"),
});
export type JournalTask = z.infer<typeof JournalTask>;

export const JournalRelatedNote = z.object({
  path: z.string(),
  title: z.string().catch("(untitled)"),
  score: z.number().catch(0),
});
export type JournalRelatedNote = z.infer<typeof JournalRelatedNote>;

export const JournalDayBundle = z.object({
  date: z.string(), // YYYY-MM-DD
  entries: z.array(JournalEntryItem),
  tasks_due: z.array(JournalTask).catch([]),
  related: z.array(JournalRelatedNote).catch([]),
});
export type JournalDayBundle = z.infer<typeof JournalDayBundle>;

// GET /api/journal/calendar → [{date, count}] (entry count per existing day file).
export const JournalCalendar = z.array(z.object({ date: z.string(), count: z.number() }));
export type JournalCalendar = z.infer<typeof JournalCalendar>;

// === DAILY CONTEXT (GET /api/daily-context) ===

export const DailyNote = z.object({
  path: z.string(),
  // Server passes frontmatter.title through unchecked (daily-context.ts) — a note with a
  // non-string YAML title (e.g. `title: 2026`) must degrade, not fail the whole /brief parse.
  // Mirrors OpenThread.title below.
  title: z.string().catch("(untitled)"),
  modified: z.string(),
  // tags are an unchecked frontmatter passthrough and /brief never renders them: a malformed
  // element must never crash the command. Degrade to [] rather than fail the parse.
  tags: z.array(z.string()).catch([]),
  snippet: z.string(),
});

export const OpenThread = z.object({
  slug: z.string(),
  // Server passes frontmatter.title through unchecked — a title-less thread note must
  // degrade to a placeholder, not fail the whole /brief parse.
  title: z.string().catch("(untitled)"),
  status: z.enum(["open", "in-progress", "blocked"]),
  priority: z.number(),
  path: z.string(),
});

export const DailyContextResponse = z.object({
  generated_at: z.string(),
  today: z.object({
    date: z.string(), // YYYY-MM-DD (UTC)
    journal: z.object({ path: z.string(), content: z.string(), exists: z.boolean() }),
  }),
  recent_notes: z.array(DailyNote),
  open_threads: z.array(OpenThread),
  active_memories: z.array(z.unknown()),
  tag_cloud: z.array(z.unknown()),
});
export type DailyContextResponse = z.infer<typeof DailyContextResponse>;

// === MCP (POST /mcp, JSON-RPC 2.0, stateless — cold tools/call works) ===
// Tool payloads are DOUBLE-PARSED: result.content[0].text is stringified JSON.
// Tool-execution errors arrive as result.isError=true (content[0].text = JSON of
// { code, message, ... }); the JSON-RPC `error` member is protocol-level only.

export const McpEnvelope = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string(), z.null()]),
  result: z
    .object({
      isError: z.boolean().optional(),
      content: z.array(z.object({ type: z.string(), text: z.string() })).min(1),
    })
    .optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

// create_note result — only the field uxie renders; the rest (sections, embed
// stats) is ignored.
export const CreateNoteResult = z.object({ note_path: z.string() });
