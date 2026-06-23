import { describe, expect, test } from "bun:test";
import { humanizeDuration } from "../../../src/lib/format/duration.ts";

describe("humanizeDuration", () => {
  test("sub-minute shows seconds only", () => {
    expect(humanizeDuration(0)).toBe("0s");
    expect(humanizeDuration(7)).toBe("7s");
  });
  test("minutes and seconds", () => {
    expect(humanizeDuration(111)).toBe("1m 51s");
  });
  test("hours and minutes (drops seconds)", () => {
    expect(humanizeDuration(7385)).toBe("2h 3m");
  });
  test("days and hours (drops minutes)", () => {
    expect(humanizeDuration(273_600)).toBe("3d 4h");
  });
  test("floors fractional seconds and clamps negatives to 0s", () => {
    expect(humanizeDuration(5.9)).toBe("5s");
    expect(humanizeDuration(-10)).toBe("0s");
  });
});
