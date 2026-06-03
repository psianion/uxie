// Wave 3 / Task 22. /ask is a strict adapter: read the query option, call
// mcp.semanticSearch(query, 5), render the semantic embed (note paths are the citations).
// No try/catch in the body — interaction-router is the only catch site (decision 10).
// On empty results it replies a plain "no matches" string and logs outcome:"empty".
import { describe, expect, test, mock } from "bun:test";
import { buildAskCommand } from "../../../../src/integrations/scrypt/commands/ask.ts";
import { fakeInteraction } from "../../../helpers.ts";

const ctx = {
  clientTag: "uxie-x",
  log: { info: () => {}, warn: () => {}, error: () => {} } as any,
};

describe("/ask", () => {
  test("calls semanticSearch with limit=5, replies with embed", async () => {
    const semanticSearch = mock(async () => [
      { note_path: "a.md", chunk_text: "snippet", score: 0.9 },
    ]);
    const cmd = buildAskCommand({ semanticSearch } as any);
    const i = fakeInteraction({
      deferred: true,
      options: { getString: mock((n: string) => (n === "query" ? "what" : null)) },
    });
    await cmd.execute(i, ctx);
    expect(semanticSearch).toHaveBeenCalledWith("what", 5);
    const arg = (i.editReply as any).mock.calls[0][0];
    expect(arg.embeds).toBeTruthy();
    expect(arg.allowedMentions).toEqual({ parse: [] });
  });

  test("no results -> plain 'no matches' and logs outcome:empty", async () => {
    const info = mock((_m: string, _f?: Record<string, unknown>) => {});
    const cmd = buildAskCommand({ semanticSearch: mock(async () => []) } as any);
    const i = fakeInteraction({
      deferred: true,
      options: { getString: mock(() => "x") },
    });
    await cmd.execute(i, { clientTag: "uxie-x", log: { info, warn: () => {}, error: () => {} } as any });
    const arg = (i.editReply as any).mock.calls[0][0];
    const content = typeof arg === "string" ? arg : arg.content;
    expect(content).toContain("no matches");
    const emptyCall = info.mock.calls.find((cl) => cl[1] && (cl[1] as any).outcome === "empty");
    expect(emptyCall).toBeTruthy();
  });

  test("the builder name is 'ask'", () => {
    const cmd = buildAskCommand({ semanticSearch: mock(async () => []) } as any);
    expect((cmd.data as any).name).toBe("ask");
  });
});
