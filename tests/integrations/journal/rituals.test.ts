import { describe, expect, mock, test } from "bun:test";
import {
  msUntilNextUtc,
  streakEndingYesterday,
  startJournalRituals,
  type RitualChannel,
  type RitualDeps,
} from "../../../src/integrations/journal/rituals.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

// Fake timer that captures the single pending callback; fire() runs it manually. schedule()
// re-arms a new pending timer after every fire, exactly like the real chain.
function fakeTimers() {
  let pending: (() => void) | null = null;
  const deps: RitualDeps = {
    setTimer: (fn) => {
      pending = fn;
      return 1;
    },
    clearTimer: () => {
      pending = null;
    },
  };
  return { deps, fire: () => pending?.() };
}

// Channel stub recording sends + threads.
function chan() {
  const sends: string[] = [];
  const threads: { name: string }[] = [];
  const ch: RitualChannel = {
    send: mock(async (c: string) => {
      sends.push(c);
    }),
    createThread: mock(async (o: { name: string }) => {
      threads.push(o);
      return { id: "thread-1" };
    }),
  };
  return { ch, sends, threads };
}

// Let the async ritual body settle before asserting.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("msUntilNextUtc", () => {
  test("before the time same day", () => {
    expect(msUntilNextUtc("07:00", new Date("2026-07-15T06:00:00Z"))).toBe(60 * 60 * 1000);
  });
  test("after the time wraps to tomorrow", () => {
    expect(msUntilNextUtc("07:00", new Date("2026-07-15T08:00:00Z"))).toBe(23 * 60 * 60 * 1000);
  });
  test("exact hit never 0 — rolls a full day", () => {
    expect(msUntilNextUtc("07:00", new Date("2026-07-15T07:00:00Z"))).toBe(DAY_MS);
  });
});

describe("streakEndingYesterday", () => {
  const today = "2026-07-15";
  test("3-day run ending yesterday = 3", () => {
    const cal = [
      { date: "2026-07-14", count: 1 },
      { date: "2026-07-13", count: 2 },
      { date: "2026-07-12", count: 1 },
    ];
    expect(streakEndingYesterday(cal, today)).toBe(3);
  });
  test("a gap breaks it", () => {
    const cal = [
      { date: "2026-07-14", count: 1 },
      { date: "2026-07-12", count: 1 }, // -2 missing
    ];
    expect(streakEndingYesterday(cal, today)).toBe(1);
  });
  test("empty calendar = 0", () => {
    expect(streakEndingYesterday([], today)).toBe(0);
  });
  test("today's entry does not extend it", () => {
    const cal = [
      { date: "2026-07-15", count: 3 }, // today — ignored
      { date: "2026-07-14", count: 1 },
      { date: "2026-07-13", count: 1 }, // -3 missing
    ];
    expect(streakEndingYesterday(cal, today)).toBe(2);
  });
});

describe("morning ritual", () => {
  test("posts tasks + streak", async () => {
    const { ch, sends } = chan();
    const rest = {
      journalDay: mock(async () => ({
        date: "2026-07-15",
        entries: [],
        tasks_due: [
          { title: "ship rituals", status: "open" },
          { title: "read watchdog", status: "done" },
        ],
        related: [{ path: "a.md", title: "Related One", score: 1 }],
      })),
      journalCalendar: mock(async () => [
        { date: "2026-07-14", count: 1 },
        { date: "2026-07-13", count: 1 },
        { date: "2026-07-12", count: 1 },
      ]),
    } as any;
    const { deps, fire } = fakeTimers();
    // 06:00 → morning (07:00) is 1h away, evening (21:00) 15h — morning fires next.
    const r = startJournalRituals(rest, undefined, ch, {
      morningUtc: "07:00",
      eveningUtc: "21:00",
      weeklyDigestUtcDay: 0,
    }, { ...deps, now: () => new Date("2026-07-15T06:00:00Z") });
    fire();
    await flush();
    r.stop();
    expect(sends).toHaveLength(1);
    const msg = sends[0]!;
    expect(msg).toContain("- [ ] ship rituals");
    expect(msg).toContain("- [x] read watchdog");
    expect(msg).toContain("• Related One");
    expect(msg).toContain("🔥 streak: 3 days");
  });
});

describe("evening ritual", () => {
  const cfg = { morningUtc: "07:00", eveningUtc: "21:00", weeklyDigestUtcDay: 0 };
  // 20:00 → evening (21:00) is 1h away, morning (07:00) 11h — evening fires next.
  const eveningNow = { now: () => new Date("2026-07-15T20:00:00Z") };

  test("posts only on an empty day", async () => {
    const { ch, sends } = chan();
    const rest = { journalDay: mock(async () => ({ date: "x", entries: [], tasks_due: [], related: [] })) } as any;
    const { deps, fire } = fakeTimers();
    const r = startJournalRituals(rest, undefined, ch, cfg, { ...deps, ...eveningNow });
    fire();
    await flush();
    r.stop();
    expect(sends).toHaveLength(1);
    expect(sends[0]!).toContain("no journal entries today yet");
  });

  test("silent when entries exist", async () => {
    const { ch, sends } = chan();
    const rest = {
      journalDay: mock(async () => ({
        date: "x",
        entries: [{ id: "1", displayTime: "t", body: "hi" }],
        tasks_due: [],
        related: [],
      })),
    } as any;
    const { deps, fire } = fakeTimers();
    const r = startJournalRituals(rest, undefined, ch, cfg, { ...deps, ...eveningNow });
    fire();
    await flush();
    r.stop();
    expect(sends).toHaveLength(0);
  });
});

describe("weekly digest", () => {
  const restStub = () =>
    ({
      journalDay: mock(async () => ({ date: "2026-07-19", entries: [], tasks_due: [], related: [] })),
      journalCalendar: mock(async () => []),
    }) as any;
  const morningNow = { now: () => new Date("2026-07-19T06:00:00Z") }; // 2026-07-19 is a Sunday (UTC day 0)

  test("creates thread + opens session on the configured day", async () => {
    const { ch, threads } = chan();
    const openSession = mock(async (_: any) => ({ status: 200, body: { session_id: "s1", status: "launching" } }));
    const paraRaid = { openSession } as any;
    const { deps, fire } = fakeTimers();
    const r = startJournalRituals(restStub(), paraRaid, ch, {
      morningUtc: "07:00",
      eveningUtc: "21:00",
      weeklyDigestUtcDay: 0, // Sunday — matches 2026-07-19
      bundle: "journal-bundle",
    }, { ...deps, ...morningNow });
    fire();
    await flush();
    r.stop();
    expect(threads).toHaveLength(1);
    expect(threads[0]!.name).toContain("week in review");
    expect(openSession).toHaveBeenCalledTimes(1);
    expect((openSession.mock.calls[0]![0] as any).adapter_ref).toBe("thread-1");
    expect((openSession.mock.calls[0]![0] as any).bundle_name).toBe("journal-bundle");
  });

  test("skips on a non-matching day", async () => {
    const { ch, threads } = chan();
    const openSession = mock(async (_: any) => ({ status: 200, body: { session_id: "s1", status: "launching" } }));
    const paraRaid = { openSession } as any;
    const { deps, fire } = fakeTimers();
    const r = startJournalRituals(restStub(), paraRaid, ch, {
      morningUtc: "07:00",
      eveningUtc: "21:00",
      weeklyDigestUtcDay: 3, // Wednesday — 2026-07-19 is Sunday
    }, { ...deps, ...morningNow });
    fire();
    await flush();
    r.stop();
    expect(threads).toHaveLength(0);
    expect(openSession).not.toHaveBeenCalled();
  });
});
