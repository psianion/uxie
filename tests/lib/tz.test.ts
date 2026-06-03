import { describe, expect, test } from "bun:test";
import { nowInZone, journalDateKey, today, formatLocal } from "../../src/lib/tz.ts";

describe("tz helpers", () => {
  test("journalDateKey returns YYYY-MM-DD in the given zone", () => {
    // 2026-04-27T01:00:00Z is 2026-04-27 06:30 in Asia/Kolkata.
    const d = new Date(Date.UTC(2026, 3, 27, 1, 0, 0));
    expect(journalDateKey("Asia/Kolkata", d)).toBe("2026-04-27");
  });

  test("journalDateKey crosses days correctly across zones", () => {
    // 2026-04-27T20:00:00Z is 2026-04-28 01:30 in Asia/Kolkata.
    const d = new Date(Date.UTC(2026, 3, 27, 20, 0, 0));
    expect(journalDateKey("Asia/Kolkata", d)).toBe("2026-04-28");
    // Same instant in UTC is still the 27th.
    expect(journalDateKey("UTC", d)).toBe("2026-04-27");
  });

  test("nowInZone returns date + time strings", () => {
    const out = nowInZone("Asia/Kolkata");
    expect(out.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(out.time).toMatch(/^\d{2}:\d{2}$/);
  });

  test("today is an alias for journalDateKey (decision 13)", () => {
    const d = new Date(Date.UTC(2026, 3, 27, 20, 0, 0));
    expect(today("Asia/Kolkata", d)).toBe("2026-04-28");
    expect(today("UTC", d)).toBe("2026-04-27");
  });

  test("formatLocal renders date + time in the given zone (decision 13)", () => {
    const d = new Date(Date.UTC(2026, 3, 27, 1, 0, 0));
    expect(formatLocal(d, "Asia/Kolkata")).toBe("2026-04-27 06:30");
  });
});
