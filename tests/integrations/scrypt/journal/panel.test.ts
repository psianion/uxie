import { describe, expect, test } from "bun:test";
import { addDays, journalDayModel } from "../../../../src/integrations/scrypt/journal/panel.ts";
import { utcToday } from "../../../../src/integrations/scrypt/rest-client.ts";
import type { JournalDayBundle } from "../../../../src/integrations/scrypt/schemas.ts";

function bundle(over: Partial<JournalDayBundle> = {}): JournalDayBundle {
  return { date: "2026-07-15", entries: [], tasks_due: [], related: [], ...over } as JournalDayBundle;
}

describe("addDays (pure UTC date math)", () => {
  test("crosses a month boundary going back", () => {
    expect(addDays("2026-07-01", -1)).toBe("2026-06-30");
  });
  test("crosses a month boundary going forward", () => {
    expect(addDays("2026-06-30", 1)).toBe("2026-07-01");
  });
  test("crosses a year boundary", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("journalDayModel", () => {
  test("title, ok health, and '<n> entries' badge", () => {
    const m = journalDayModel(
      bundle({ entries: [{ id: "2026-07-15T10:00:00.000Z", displayTime: "10:00 AM", body: "hi" }] }),
    );
    expect(m.title).toBe("Journal · 2026-07-15");
    expect(m.health).toBe("ok");
    expect(m.badge).toBe("1 entries");
    expect(m.rows[0]).toMatchObject({ icon: "📝", label: "10:00 AM", value: "hi" });
  });

  test("empty day still renders ok with a 'no entries yet' row", () => {
    const m = journalDayModel(bundle());
    expect(m.health).toBe("ok");
    expect(m.badge).toBe("0 entries");
    expect(JSON.stringify(m.rows)).toContain("no entries yet");
  });

  test("clips entry bodies to ~160 chars", () => {
    const m = journalDayModel(
      bundle({ entries: [{ id: "x", displayTime: "t", body: "a".repeat(300) }] }),
    );
    expect(m.rows[0]!.value.length).toBeLessThanOrEqual(160);
    expect(m.rows[0]!.value.endsWith("…")).toBe(true);
  });

  test("caps at 10 entries with a '+N more' footer note", () => {
    const entries = Array.from({ length: 13 }, (_, n) => ({
      id: String(n),
      displayTime: `t${n}`,
      body: `b${n}`,
    }));
    const m = journalDayModel(bundle({ entries }));
    expect(m.rows.filter((r) => r.icon === "📝").length).toBe(10);
    expect(m.footer).toContain("+3 more");
  });

  test("done-status tasks are struck through; related shows top 3", () => {
    const m = journalDayModel(
      bundle({
        tasks_due: [
          { title: "open one", status: "open" },
          { title: "shipped", status: "done" },
        ],
        related: [
          { path: "a", title: "A", score: 3 },
          { path: "b", title: "B", score: 2 },
          { path: "c", title: "C", score: 1 },
          { path: "d", title: "D", score: 0 },
        ],
      }),
    );
    const tasks = m.rows.find((r) => r.label === "tasks due")!;
    expect(tasks.value).toContain("~~shipped~~");
    expect(tasks.value).toContain("open one");
    const related = m.rows.find((r) => r.label === "related")!;
    expect(related.value).toBe("A, B, C");
  });

  test("next button disabled on today, enabled on a past day", () => {
    const today = journalDayModel(bundle({ date: utcToday() }));
    const next = today.buttons!.find((b) => b.id.startsWith("journal:day:") && b.label.endsWith("▶"))!;
    expect(next.disabled).toBe(true);

    const past = journalDayModel(bundle({ date: "2020-01-01" }));
    const pastNext = past.buttons!.find((b) => b.label.endsWith("▶"))!;
    expect(pastNext.disabled).toBe(false);
    expect(past.buttons!.find((b) => b.label.startsWith("◀"))!.id).toBe("journal:day:2019-12-31");
  });
});
