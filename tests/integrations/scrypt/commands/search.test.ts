// Wave 3 / Task 21. /search is a strict adapter: read the query option, call
// mcp.searchNotes(query, 10), render an embed (decision 14 top-N caps live in lib/embed).
// No try/catch in the body — interaction-router is the only catch site (decision 10).
// On empty results it replies a plain "no matches" string and the command logs
// outcome:"empty" via the scoped logger.
import { describe, expect, test, mock } from "bun:test";
import { buildSearchCommand } from "../../../../src/integrations/scrypt/commands/search.ts";
import { fakeInteraction } from "../../../helpers.ts";

const ctx = {
  clientTag: "uxie-x",
  log: { info: () => {}, warn: () => {}, error: () => {} } as any,
};

describe("/search", () => {
  test("calls searchNotes with query and limit=10, replies with embed", async () => {
    const searchNotes = mock(async () => [{ note_path: "a.md", match_preview: "hit" }]);
    const cmd = buildSearchCommand({ searchNotes } as any);
    const i = fakeInteraction({
      deferred: true,
      options: { getString: mock((n: string) => (n === "query" ? "hello" : null)) },
    });
    await cmd.execute(i, ctx);
    expect(searchNotes).toHaveBeenCalledWith("hello", 10);
    const arg = (i.editReply as any).mock.calls[0][0];
    expect(arg.embeds).toBeTruthy();
    // Decision 8: replies suppress mentions.
    expect(arg.allowedMentions).toEqual({ parse: [] });
  });

  test("no results -> plain 'no matches' and logs outcome:empty", async () => {
    const info = mock((_m: string, _f?: Record<string, unknown>) => {});
    const cmd = buildSearchCommand({ searchNotes: mock(async () => []) } as any);
    const i = fakeInteraction({
      deferred: true,
      options: { getString: mock(() => "x") },
    });
    await cmd.execute(i, { clientTag: "uxie-x", log: { info, warn: () => {}, error: () => {} } as any });
    const arg = (i.editReply as any).mock.calls[0][0];
    const content = typeof arg === "string" ? arg : arg.content;
    expect(content).toContain("no matches");
    // outcome:"empty" event (decision 4).
    const emptyCall = info.mock.calls.find((cl) => cl[1] && (cl[1] as any).outcome === "empty");
    expect(emptyCall).toBeTruthy();
  });

  test("the builder name is 'search'", () => {
    const cmd = buildSearchCommand({ searchNotes: mock(async () => []) } as any);
    expect((cmd.data as any).name).toBe("search");
  });
});
