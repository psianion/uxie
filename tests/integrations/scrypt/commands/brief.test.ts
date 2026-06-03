// Wave 4 / Task 26. /brief is a strict adapter: call rest.getDailyContext(), compute the
// USER_TZ-local "today" date for the title, render briefEmbed, editReply ephemerally with
// mentions suppressed (decision 8). Manual-only — NO scheduler (decision 16). No try/catch
// in the body — interaction-router is the only catch site (decision 10).
import { describe, expect, test, mock } from "bun:test";
import { buildBriefCommand } from "../../../../src/integrations/scrypt/commands/brief.ts";
import { fakeInteraction } from "../../../helpers.ts";

const ctx = { clientTag: "uxie-x", log: { info: () => {}, warn: () => {}, error: () => {} } as any };

const emptyDaily = {
  today_journal: "j",
  recent_notes: [],
  open_threads: [],
  active_memories: [],
  tag_cloud: [],
};

describe("/brief", () => {
  test("calls getDailyContext and replies with embed", async () => {
    const getDailyContext = mock(async () => emptyDaily);
    const cmd = buildBriefCommand({ getDailyContext } as any, "UTC");
    const i = fakeInteraction({ deferred: true });
    await cmd.execute(i, ctx);
    expect(getDailyContext).toHaveBeenCalled();
    const arg = (i.editReply as any).mock.calls[0][0];
    expect(arg.embeds).toBeTruthy();
    expect(arg.embeds.length).toBe(1);
  });

  test("title carries the USER_TZ-local date and reply suppresses mentions", async () => {
    const getDailyContext = mock(async () => emptyDaily);
    const cmd = buildBriefCommand({ getDailyContext } as any, "Asia/Kolkata");
    const i = fakeInteraction({ deferred: true });
    await cmd.execute(i, ctx);
    const arg = (i.editReply as any).mock.calls[0][0];
    const json: any = arg.embeds[0].toJSON();
    // YYYY-MM-DD pattern from journalDateKey(tz)
    expect(json.title).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(arg.allowedMentions).toEqual({ parse: [] });
  });

  test("the builder name is 'brief'", () => {
    const cmd = buildBriefCommand({ getDailyContext: mock(async () => emptyDaily) } as any, "UTC");
    expect((cmd.data as any).name).toBe("brief");
  });
});
