import { describe, expect, test } from "bun:test";
import {
  captureEmbed,
  truncate,
  ACCENT,
  DESC_CAP,
  TOP_N,
  searchResultEmbed,
  semanticResultEmbed,
  searchResultPayload,
  semanticResultPayload,
  briefEmbed,
  helpEmbed,
} from "../../src/lib/embed.ts";

describe("truncate", () => {
  test("returns the string unchanged when within the cap", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  test("truncates with an ellipsis when over the cap", () => {
    const out = truncate("abcdefghij", 5);
    expect(out.length).toBe(5);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("captureEmbed", () => {
  test("embeds path and permalink, sets the accent color", () => {
    const e = captureEmbed({ path: "notes/inbox/hello.md", permalink: "https://scrypt/notes/inbox/hello" });
    const json: any = e.toJSON();
    expect(json.title).toContain("captured");
    expect(json.description).toContain("notes/inbox/hello.md");
    expect(json.description).toContain("https://scrypt/notes/inbox/hello");
    expect(json.color).toBe(ACCENT);
  });

  test("makes the title a tappable web-UI link when permalink is an http url", () => {
    const e = captureEmbed({ path: "notes/inbox/hello.md", permalink: "https://scrypt/notes/inbox/hello" });
    const json: any = e.toJSON();
    expect(json.url).toBe("https://scrypt/notes/inbox/hello");
  });

  test("omits the title URL when permalink is not an http link (degraded path)", () => {
    const e = captureEmbed({ path: "notes/inbox/hello.md", permalink: "notes/inbox/hello.md" });
    const json: any = e.toJSON();
    expect(json.url).toBeUndefined();
    expect(json.description).toContain("notes/inbox/hello.md");
  });

  test("truncates an oversized description to the cap", () => {
    const long = "x".repeat(DESC_CAP + 500);
    const e = captureEmbed({ path: long, permalink: "https://scrypt/x" });
    const json: any = e.toJSON();
    expect(json.description.length).toBeLessThanOrEqual(DESC_CAP);
  });
});

describe("searchResultEmbed", () => {
  test("renders hit lines", () => {
    const e = searchResultEmbed("query", [
      { note_path: "a.md", match_preview: "preview a" },
      { note_path: "b.md", match_preview: "preview b" },
    ]);
    const json: any = e.toJSON();
    expect(json.description).toContain("a.md");
    expect(json.description).toContain("preview a");
    expect(json.description).toContain("b.md");
  });

  test("sets the single accent color", () => {
    const e = searchResultEmbed("q", [{ note_path: "a.md", match_preview: "p" }]);
    expect((e.toJSON() as any).color).toBe(ACCENT);
  });

  test("truncates long previews to stay under the cap", () => {
    const long = "x".repeat(500);
    const e = searchResultEmbed("q", [{ note_path: "a.md", match_preview: long }]);
    const json: any = e.toJSON();
    expect(json.description.length).toBeLessThanOrEqual(DESC_CAP);
  });

  test("caps the visible lines to TOP_N", () => {
    const hits = Array.from({ length: TOP_N + 5 }, (_, n) => ({
      note_path: `n${n}.md`,
      match_preview: "p",
    }));
    const e = searchResultEmbed("q", hits);
    const lines = (e.toJSON() as any).description.split("\n").filter((l: string) => l.startsWith("•"));
    expect(lines.length).toBe(TOP_N);
  });
});

describe("semanticResultEmbed", () => {
  test("renders score and chunk", () => {
    const e = semanticResultEmbed("q", [{ note_path: "a.md", chunk_text: "snippet", score: 0.87 }]);
    const json: any = e.toJSON();
    expect(json.description).toContain("a.md");
    expect(json.description).toContain("0.87");
    expect(json.description).toContain("snippet");
  });

  test("sets the single accent color", () => {
    const e = semanticResultEmbed("q", [{ note_path: "a.md", chunk_text: "s", score: 0.5 }]);
    expect((e.toJSON() as any).color).toBe(ACCENT);
  });
});

describe("result payloads (top-N caps + AttachmentBuilder overflow, never pagination)", () => {
  test("search: no overflow file when hits fit within TOP_N", () => {
    const p = searchResultPayload("q", [{ note_path: "a.md", match_preview: "p" }]);
    expect(p.embeds.length).toBe(1);
    expect(p.files).toBeUndefined();
  });

  test("search: attaches an overflow file when hits exceed TOP_N", () => {
    const hits = Array.from({ length: TOP_N + 3 }, (_, n) => ({
      note_path: `n${n}.md`,
      match_preview: `preview ${n}`,
    }));
    const p = searchResultPayload("q", hits);
    expect(p.files).toBeDefined();
    expect(p.files!.length).toBe(1);
    // The visible embed still shows only TOP_N lines.
    const lines = (p.embeds[0]!.toJSON() as any).description
      .split("\n")
      .filter((l: string) => l.startsWith("•"));
    expect(lines.length).toBe(TOP_N);
  });

  test("semantic: attaches an overflow file when hits exceed TOP_N", () => {
    const hits = Array.from({ length: TOP_N + 2 }, (_, n) => ({
      note_path: `n${n}.md`,
      chunk_text: `chunk ${n}`,
      score: 0.5,
    }));
    const p = semanticResultPayload("q", hits);
    expect(p.files).toBeDefined();
    expect(p.files!.length).toBe(1);
  });
});

describe("briefEmbed", () => {
  const ctx = {
    today_journal: "morning thoughts",
    recent_notes: [
      { path: "a.md", title: "A" },
      { path: "b.md", title: "B" },
    ],
    open_threads: [{ path: "t1.md", title: "T1", priority: "high" }],
    active_memories: [{ name: "research" }],
    tag_cloud: [
      { tag: "x", count: 5 },
      { tag: "y", count: 3 },
    ],
  };

  test("renders title with date and 5 fields", () => {
    const e = briefEmbed(ctx, "2026-04-14");
    const json: any = e.toJSON();
    expect(json.title).toContain("2026-04-14");
    expect(json.fields.length).toBe(5);
    const names = json.fields.map((f: any) => f.name);
    expect(names).toEqual([
      expect.stringContaining("journal"),
      expect.stringContaining("threads"),
      expect.stringContaining("captures"),
      expect.stringContaining("memories"),
      expect.stringContaining("tags"),
    ]);
  });

  test("sets the single accent color (decision 14)", () => {
    const e = briefEmbed(ctx, "2026-04-14");
    expect((e.toJSON() as any).color).toBe(ACCENT);
  });

  test("handles empty context gracefully", () => {
    const empty = { today_journal: "", recent_notes: [], open_threads: [], active_memories: [], tag_cloud: [] };
    const e = briefEmbed(empty, "2026-04-14");
    const json: any = e.toJSON();
    expect(json.fields.length).toBe(5);
    // every empty field degrades to a placeholder, never an empty string (Discord rejects "")
    for (const f of json.fields) expect(f.value.length).toBeGreaterThan(0);
  });

  test("caps an oversized journal body to stay within the field cap", () => {
    const big = { ...ctx, today_journal: "z".repeat(5000) };
    const e = briefEmbed(big, "2026-04-14");
    const json: any = e.toJSON();
    const journalField = json.fields[0];
    expect(journalField.value.length).toBeLessThanOrEqual(1024);
  });
});

describe("helpEmbed", () => {
  test("lists each command as `/name` — description with the accent color", () => {
    const e = helpEmbed([
      { name: "ping", description: "Check uxie + scrypt health" },
      { name: "capture", description: "Save a note to scrypt" },
    ]);
    expect(e.data.color).toBe(ACCENT);
    expect(e.data.title).toBe("uxie — commands");
    expect(e.data.description).toContain("`/ping` — Check uxie + scrypt health");
    expect(e.data.description).toContain("`/capture` — Save a note to scrypt");
    expect(e.data.footer?.text).toContain("route it");
  });

  test("renders without throwing when the command list is empty", () => {
    const e = helpEmbed([]);
    expect(e.data.description).toContain("no commands");
  });
});
