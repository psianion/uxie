import { afterEach, describe, expect, mock, test } from "bun:test";
import { setLogSink } from "../../../src/lib/log.ts";
import type { LogEntry } from "../../../src/lib/log.ts";
import { startWatchdog } from "../../../src/integrations/sup/watchdog.ts";

// Capture every emitted log entry via the sink (delivers all levels). Reset after each test.
let entries: LogEntry[] = [];
afterEach(() => {
  setLogSink(null);
  entries = [];
});
function capture(): void {
  entries = [];
  setLogSink((e) => entries.push(e));
}

// scrypt stub whose next health() result is mutable between probes.
function scryptStub(ok: boolean) {
  const s = { ok, reason: undefined as string | undefined };
  return { s, stub: { health: mock(async () => ({ ok: s.ok, reason: s.reason })) } as any };
}

// Timer deps that never auto-fire — tests drive probe() directly, so real timers stay out.
const noTimers = { setTimer: () => 1, clearTimer: () => {}, intervalMs: 1000 };

describe("SUP watchdog", () => {
  test("steady up → no log", async () => {
    capture();
    const { stub } = scryptStub(true);
    const wd = startWatchdog(stub, undefined, noTimers);
    await wd.probe();
    await wd.probe();
    wd.stop();
    expect(entries).toHaveLength(0);
  });

  test("up→down warns once, not repeated while still down", async () => {
    capture();
    const { s, stub } = scryptStub(true);
    const wd = startWatchdog(stub, undefined, noTimers);
    await wd.probe(); // unknown→up: silent
    s.ok = false;
    s.reason = "refused";
    await wd.probe(); // up→down: warn
    await wd.probe(); // down→down: silent
    wd.stop();
    const warns = entries.filter((e) => e.level === "warn" && e.msg === "scrypt down");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.fields.reason).toBe("refused");
  });

  test("down→up emits a recovered notice", async () => {
    capture();
    const { s, stub } = scryptStub(false);
    const wd = startWatchdog(stub, undefined, noTimers);
    await wd.probe(); // unknown→down: warn
    s.ok = true;
    await wd.probe(); // down→up: notice
    wd.stop();
    expect(entries.filter((e) => e.msg === "scrypt down")).toHaveLength(1);
    const recovered = entries.filter((e) => e.level === "notice" && e.msg === "scrypt recovered");
    expect(recovered).toHaveLength(1);
  });

  test("para-raid undefined is never probed", async () => {
    capture();
    const { stub } = scryptStub(false); // make scrypt noisy so we know logging is live
    const wd = startWatchdog(stub, undefined, noTimers);
    await wd.probe();
    await wd.probe();
    wd.stop();
    expect(entries.some((e) => e.msg.includes("para-raid"))).toBe(false);
  });
});
