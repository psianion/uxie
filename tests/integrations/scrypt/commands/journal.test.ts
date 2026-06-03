// Wave 4 / Task 24. /journal is a strict adapter: read the text option, call
// rest.ingest({ kind: "journal", ... }) with the deterministic clientTag + USER_TZ, then
// editReply a confirmation line stamped with the USER_TZ-local date/time (the SERVER stamps
// the stored entry in UTC — contract BLOCKER 1 — so tz only shapes the reply text).
// No try/catch in the body — interaction-router is the only catch site (decision 10).
import { describe, expect, test, mock } from "bun:test";
import { buildJournalCommand } from "../../../../src/integrations/scrypt/commands/journal.ts";
import { fakeInteraction } from "../../../helpers.ts";

const ctx = { clientTag: "uxie-x", log: { info: () => {}, warn: () => {}, error: () => {} } as any };

describe("/journal", () => {
  test("ingests with kind=journal and tz from env", async () => {
    const ingest = mock(async () => ({ path: "journal/2026-04-14.md", permalink: "/j/today" }));
    const cmd = buildJournalCommand({ ingest } as any, "Asia/Kolkata");
    const i = fakeInteraction({
      deferred: true,
      options: { getString: mock((n: string) => (n === "text" ? "today I learned X" : null)) },
    });
    await cmd.execute(i, ctx);
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "journal",
        content: "today I learned X",
        clientTag: "uxie-x",
        tz: "Asia/Kolkata",
      }),
    );
    const arg = (i.editReply as any).mock.calls[0][0];
    const content = typeof arg === "string" ? arg : arg.content;
    expect(content).toContain("journal/2026-04-14.md");
  });

  test("reply suppresses mentions (decision 8)", async () => {
    const ingest = mock(async () => ({ path: "journal/2026-04-14.md", permalink: "/j/today" }));
    const cmd = buildJournalCommand({ ingest } as any, "UTC");
    const i = fakeInteraction({
      deferred: true,
      options: { getString: mock(() => "entry") },
    });
    await cmd.execute(i, ctx);
    const arg = (i.editReply as any).mock.calls[0][0];
    expect(arg.allowedMentions).toEqual({ parse: [] });
  });

  test("the builder name is 'journal'", () => {
    const cmd = buildJournalCommand({ ingest: mock(async () => ({ path: "p", permalink: "l" })) } as any, "UTC");
    expect((cmd.data as any).name).toBe("journal");
  });
});
