import { describe, expect, test } from "bun:test";
import { captureEmbed, truncate, ACCENT, DESC_CAP } from "../../src/lib/embed.ts";

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
