import { describe, expect, test, mock } from "bun:test";
import { buildBriefCommand, renderBrief } from "../../../../src/integrations/scrypt/commands/brief.ts";
import { ScryptError } from "../../../../src/lib/errors.ts";
import { fakeInteraction } from "../../../helpers.ts";

const ctx = { clientTag: "uxie-iid-1", log: { info() {}, warn() {}, error() {} } as any };

const DC = {
  generated_at: "2026-07-16T09:30:00.000Z",
  today: {
    date: "2026-07-16",
    journal: { path: "journal/2026-07-16.md", content: "# hi", exists: true },
  },
  recent_notes: [
    {
      path: "projects/scrypt/plan/x.md",
      title: "Plan X",
      modified: "2026-07-16T08:00:00.000Z",
      tags: [],
      snippet: "s",
    },
  ],
  open_threads: [
    {
      slug: "vault-sync",
      title: "Vault sync",
      status: "open" as const,
      priority: 2,
      path: "notes/threads/vault-sync.md",
    },
  ],
  active_memories: [],
  tag_cloud: [],
};

describe("/brief", () => {
  test("command data name is 'brief' with default builder shape (decision 7)", () => {
    const cmd = buildBriefCommand({} as any);
    expect(cmd.data.name).toBe("brief");
    expect((cmd.data as any).toJSON().default_member_permissions).toBe("0");
    expect(cmd.defer).toBeUndefined(); // router auto-defers
  });

  test("renders journal presence, recent notes, and open threads", async () => {
    const dailyContext = mock(async () => DC);
    const cmd = buildBriefCommand({ dailyContext } as any);
    const i = fakeInteraction({ deferred: true });
    await cmd.execute(i, ctx);
    expect(dailyContext).toHaveBeenCalledWith("uxie-iid-1");
    const msg = i.editReply.mock.calls[0][0] as string;
    expect(msg).toContain("Daily brief — 2026-07-16");
    expect(msg).toContain("journal started today");
    expect(msg).toContain("Plan X — `projects/scrypt/plan/x.md`");
    expect(msg).toContain("Vault sync — open");
  });

  test("empty day renders gracefully (no journal, no notes, no threads)", () => {
    const msg = renderBrief({
      ...DC,
      today: { date: "2026-07-16", journal: { path: "journal/2026-07-16.md", content: "", exists: false } },
      recent_notes: [],
      open_threads: [],
    });
    expect(msg).toContain("no journal entry yet today");
    expect(msg).toContain("nothing modified in the last 24h");
    expect(msg).toContain("**Open threads** (0)");
  });

  test("stays under Discord's 2000-char reply cap", () => {
    const many = Array.from({ length: 40 }, (_, k) => ({
      path: `projects/p/other/${"n".repeat(80)}-${k}.md`,
      title: "t".repeat(100),
      modified: "2026-07-16T08:00:00.000Z",
      tags: [],
      snippet: "s",
    }));
    const msg = renderBrief({ ...DC, recent_notes: many });
    expect(msg.length).toBeLessThanOrEqual(2000);
  });

  test("a ScryptError bubbles to the router (scrypt down)", async () => {
    const dailyContext = mock(async () => {
      throw new ScryptError("scrypt_unreachable", "scrypt unreachable");
    });
    const cmd = buildBriefCommand({ dailyContext } as any);
    await expect(cmd.execute(fakeInteraction({ deferred: true }), ctx)).rejects.toBeInstanceOf(
      ScryptError,
    );
  });
});
