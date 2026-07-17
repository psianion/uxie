import { describe, expect, test } from "bun:test";
import { createDiscordLogSink, type LogSinkChannel } from "../../src/lib/discord-log-sink.ts";
import type { LogEntry } from "../../src/lib/log.ts";

// A fake channel recording sent payloads, with an optional failing mode (loop-safety test).
function fakeChannel(opts: { fail?: boolean } = {}) {
  const sent: string[] = [];
  const channel: LogSinkChannel = {
    send: async (content: string) => {
      if (opts.fail) throw new Error("discord down");
      sent.push(content);
      return {};
    },
  };
  return { channel, sent };
}

// A controllable timer: createDiscordLogSink schedules through it; tests fire it manually.
function fakeTimer() {
  let pending: { fn: () => void; ms: number } | null = null;
  return {
    setTimer: (fn: () => void, ms: number) => {
      pending = { fn, ms };
      return pending;
    },
    clearTimer: () => {
      pending = null;
    },
    pendingMs: () => pending?.ms ?? null,
    fire: () => {
      const p = pending;
      pending = null;
      p?.fn();
    },
  };
}

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  level: "error",
  msg: "something broke",
  t: "2026-06-25T15:06:49.740Z",
  fields: {},
  ...over,
});

function mk(channel: LogSinkChannel, timer: ReturnType<typeof fakeTimer>, over = {}) {
  return createDiscordLogSink(channel, {
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    ...over,
  });
}

describe("createDiscordLogSink", () => {
  test("ignores info entries (notice+warn+error only)", async () => {
    const { channel, sent } = fakeChannel();
    const t = fakeTimer();
    const sink = mk(channel, t);
    sink.onEntry(entry({ level: "info" as LogEntry["level"] }));
    expect(t.pendingMs()).toBe(null); // nothing scheduled
    await sink.flush();
    expect(sent.length).toBe(0);
  });

  test("mirrors notice entries with the 📣 icon on the slow timer", async () => {
    const { channel, sent } = fakeChannel();
    const t = fakeTimer();
    const sink = mk(channel, t);
    sink.onEntry(entry({ level: "notice" as LogEntry["level"], msg: "command ok" }));
    expect(t.pendingMs()).toBe(1500); // slowMs, same batching as warn
    t.fire();
    await sink.flush();
    expect(sent.length).toBe(1);
    expect(sent[0]!).toContain("📣");
    expect(sent[0]!).toContain("command ok");
  });

  test("formats one line: time, icon, msg, fields; err collapsed to first line", async () => {
    const { channel, sent } = fakeChannel();
    const t = fakeTimer();
    const sink = mk(channel, t);
    sink.onEntry(
      entry({
        level: "error",
        msg: "grant failed",
        fields: { roleId: "42", err: "DiscordAPIError: Missing Permissions\n    at x\n    at y" },
      }),
    );
    t.fire();
    await sink.flush();
    expect(sent.length).toBe(1);
    const body = sent[0]!;
    expect(body.startsWith("```")).toBe(true);
    expect(body).toContain("15:06:49");
    expect(body).toContain("🔴");
    expect(body).toContain("grant failed");
    expect(body).toContain("roleId=42");
    expect(body).toContain("err=DiscordAPIError: Missing Permissions");
    expect(body).not.toContain("at x"); // stack stripped
  });

  test("warn renders the warn icon", async () => {
    const { channel, sent } = fakeChannel();
    const t = fakeTimer();
    const sink = mk(channel, t);
    sink.onEntry(entry({ level: "warn", msg: "heads up" }));
    await sink.flush();
    expect(sent[0]!).toContain("⚠️");
    expect(sent[0]!).toContain("heads up");
  });

  test("error schedules fast, warn schedules slow; error reschedules a pending warn to fast", () => {
    const { channel } = fakeChannel();
    const t = fakeTimer();
    const sink = mk(channel, t, { fastMs: 250, slowMs: 1500 });
    sink.onEntry(entry({ level: "warn" }));
    expect(t.pendingMs()).toBe(1500);
    sink.onEntry(entry({ level: "error" }));
    expect(t.pendingMs()).toBe(250); // rescheduled to fast
  });

  test("flush() sends buffered lines and resolves", async () => {
    const { channel, sent } = fakeChannel();
    const t = fakeTimer();
    const sink = mk(channel, t);
    sink.onEntry(entry({ msg: "a" }));
    sink.onEntry(entry({ msg: "b" }));
    await sink.flush(); // crash-path: flush without waiting for the timer
    expect(sent.length).toBe(1);
    expect(sent[0]!).toContain("a");
    expect(sent[0]!).toContain("b");
  });

  test("splits into multiple messages past maxChars", async () => {
    const { channel, sent } = fakeChannel();
    const t = fakeTimer();
    const sink = mk(channel, t, { maxChars: 200, maxLines: 100 });
    for (let i = 0; i < 20; i++) sink.onEntry(entry({ msg: `line-${i}-` + "x".repeat(40) }));
    await sink.flush();
    expect(sent.length).toBeGreaterThan(1);
    for (const m of sent) expect(m.length).toBeLessThanOrEqual(200);
  });

  test("loop-safe: a throwing channel.send does not throw or recurse", async () => {
    const { channel } = fakeChannel({ fail: true });
    const t = fakeTimer();
    const sink = mk(channel, t);
    sink.onEntry(entry());
    await expect(sink.flush()).resolves.toBeUndefined(); // swallowed
  });

  test("overflow: caps buffer, drops oldest, prepends [+N dropped]", async () => {
    const { channel, sent } = fakeChannel();
    const t = fakeTimer();
    const sink = mk(channel, t, { maxLines: 3, maxChars: 4000 });
    for (let i = 0; i < 10; i++) sink.onEntry(entry({ msg: `m${i}` }));
    await sink.flush();
    const all = sent.join("\n");
    expect(all).toContain("[+7 dropped]");
    expect(all).toContain("m9"); // newest kept
    expect(all).not.toContain("m0 "); // oldest dropped
  });
});
