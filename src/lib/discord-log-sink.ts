// Live Discord mirror for warn+error logs. Pure + injectable (channel/timer passed in) so it is
// unit-testable with no live client. NEVER calls log.* — every channel.send failure is swallowed,
// which is the whole point: a sink that re-logged its own send errors would feedback-loop.
import type { LogEntry } from "./log.ts";

// Minimal shape of a sendable Discord channel (a real TextChannel satisfies this structurally).
export interface LogSinkChannel {
  send(content: string): Promise<unknown>;
}

export interface DiscordLogSinkDeps {
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  fastMs?: number; // error flush delay
  slowMs?: number; // warn flush delay
  maxLines?: number; // buffer cap; oldest dropped past this
  maxChars?: number; // per-message cap (incl. code fence)
}

const ICON = { warn: "⚠️", error: "🔴" } as const;
const FIELD_MAX = 300; // per-field-value truncation
const RESERVED = new Set(["t", "level", "msg"]);

export function createDiscordLogSink(channel: LogSinkChannel, deps: DiscordLogSinkDeps = {}) {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const fastMs = deps.fastMs ?? 250;
  const slowMs = deps.slowMs ?? 1500;
  const maxLines = deps.maxLines ?? 50;
  const maxChars = deps.maxChars ?? 1990;
  const lineMax = Math.max(40, maxChars - 90); // room for fences + dropped note

  const buf: string[] = [];
  let dropped = 0;
  let timer: unknown = null;
  let timerFast = false;
  let sending = false;
  let waiters: Array<() => void> = [];

  function fieldVal(key: string, v: unknown): string {
    let s =
      key === "err" && typeof v === "string"
        ? (v.split("\n", 1)[0] ?? v) // collapse Error to "Name: message"
        : typeof v === "string"
          ? v
          : (() => {
              try {
                return JSON.stringify(v) ?? String(v);
              } catch {
                return String(v);
              }
            })();
    s = s.replace(/\s+/g, " ").trim(); // single-line
    return s.length > FIELD_MAX ? s.slice(0, FIELD_MAX) + "…" : s;
  }

  function formatLine(e: LogEntry): string {
    const time = e.t.length >= 19 ? e.t.slice(11, 19) : e.t; // HH:MM:SS from ISO
    const icon = e.level === "error" ? ICON.error : ICON.warn;
    const parts: string[] = [];
    for (const [k, v] of Object.entries(e.fields)) {
      if (RESERVED.has(k)) continue;
      parts.push(`${k}=${fieldVal(k, v)}`);
    }
    let line = `${time} ${icon} ${e.msg}`;
    if (parts.length) line += ` · ${parts.join(" ")}`;
    return line.length > lineMax ? line.slice(0, lineMax) + "…" : line;
  }

  function schedule(level: LogEntry["level"]): void {
    const wantFast = level === "error";
    if (timer === null) {
      timerFast = wantFast;
      timer = setTimer(fire, wantFast ? fastMs : slowMs);
      return;
    }
    // An error promotes a pending slow (warn) timer to fast; otherwise leave the timer be.
    if (wantFast && !timerFast) {
      clearTimer(timer);
      timerFast = true;
      timer = setTimer(fire, fastMs);
    }
  }

  function fire(): void {
    timer = null;
    void drain();
  }

  // Pull lines for one message: a [+N dropped] note first, then as many lines as fit under maxChars.
  function takeChunk(): string {
    const lines: string[] = [];
    let size = 0;
    if (dropped > 0) {
      const note = `[+${dropped} dropped]`;
      lines.push(note);
      size += note.length;
      dropped = 0;
    }
    const FENCE = 8; // ```\n + \n```
    while (buf.length > 0) {
      const line = buf[0]!;
      const add = (lines.length ? 1 : 0) + line.length;
      if (lines.length > 0 && size + add + FENCE > maxChars) break;
      lines.push(line);
      buf.shift();
      size += add;
    }
    return lines.join("\n");
  }

  async function drain(): Promise<void> {
    if (sending) return; // a cycle is already running; it drains everything in buf
    sending = true;
    try {
      while (buf.length > 0 || dropped > 0) {
        const chunk = takeChunk();
        try {
          await channel.send("```\n" + chunk + "\n```");
        } catch {
          // Loop-safe: a failed send is dropped, never re-logged.
        }
      }
    } finally {
      sending = false;
      const settled = waiters;
      waiters = [];
      for (const w of settled) w();
    }
  }

  function onEntry(e: LogEntry): void {
    if (e.level !== "warn" && e.level !== "error") return;
    buf.push(formatLine(e));
    while (buf.length > maxLines) {
      buf.shift();
      dropped++;
    }
    schedule(e.level);
  }

  // Resolves once everything currently buffered has been sent (or its send settled). Crash path.
  function flush(): Promise<void> {
    if (!sending && buf.length === 0 && dropped === 0) return Promise.resolve();
    const p = new Promise<void>((res) => waiters.push(res));
    void drain();
    return p;
  }

  return { onEntry, flush };
}
