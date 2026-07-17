import { describe, expect, test } from "bun:test";
import { extractItems } from "../../../src/integrations/triage/extract.ts";

const src = (over: Partial<Parameters<typeof extractItems>[0]> = {}) => ({
  content: "",
  attachments: [],
  embeds: [],
  ...over,
});

describe("extractItems", () => {
  test("links from content get host labels", () => {
    const items = extractItems(
      src({ content: "check https://www.reddit.com/r/foo/abc and https://x.com/user/status/1" }),
    );
    expect(items.map((i) => i.label)).toEqual(["www.reddit.com", "x.com"]);
    expect(items.every((i) => i.kind === "link")).toBe(true);
  });

  test("embed urls included, content duplicates deduped", () => {
    const items = extractItems(
      src({
        content: "https://blog.example/post",
        embeds: [{ url: "https://blog.example/post" }, { url: "https://other.example/x" }, { url: null }],
      }),
    );
    expect(items.map((i) => i.url)).toEqual(["https://blog.example/post", "https://other.example/x"]);
  });

  test("attachments carry filename + contentType", () => {
    const items = extractItems(
      src({
        attachments: [{ url: "https://cdn.discordapp.com/a/paper.pdf", name: "paper.pdf", contentType: "application/pdf" }],
      }),
    );
    expect(items).toEqual([
      { kind: "attachment", url: "https://cdn.discordapp.com/a/paper.pdf", label: "paper.pdf", contentType: "application/pdf" },
    ]);
  });

  test("plain text message yields nothing", () => {
    expect(extractItems(src({ content: "just words, no links" }))).toEqual([]);
  });
});
