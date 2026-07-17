// Structured JSON logger (UXIE-DISCORD-GUIDELINES §17 / ratified decision 4).
// One single-line JSON object per call to stdout. Reserved keys: t, level, msg.
// Per-interaction children carry interactionId (camelCase).
//
// Redaction + serialization is a single recursive, cycle-safe, truncating pass
// (NOT ad-hoc per-field): any KEY whose uppercased name contains BOT_TOKEN, AUTH,
// SECRET, or KEY is replaced with "[REDACTED]" at any depth; Errors become a
// name+message+stack string; cycles become "[Circular]"; long strings/arrays are
// truncated so a stray large payload can never flood the log line.

// "notice" is info-priority but marked notable: the Discord log sink mirrors it (info stays
// stdout-only), so operator-visible events (command ok, session lifecycle) reach the logs
// channel without promoting them to warn.
type Level = "info" | "notice" | "warn" | "error";
type Fields = Record<string, unknown>;

export interface Logger {
  info(msg: string, fields?: Fields): void;
  notice(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(scope: Fields): Logger;
}

// A registered sink receives every emitted entry AFTER it is written to stdout, with `fields`
// already redacted (reserved keys t/level/msg are surfaced on the entry, not in fields). Used to
// mirror logs elsewhere (e.g. a Discord channel) — see lib/discord-log-sink.ts.
export interface LogEntry {
  level: Level;
  msg: string;
  t: string;
  fields: Fields;
}

let sink: ((entry: LogEntry) => void) | null = null;
let inSink = false; // re-entrancy guard: a sink that itself logs must not recurse.

export function setLogSink(fn: ((entry: LogEntry) => void) | null): void {
  sink = fn;
}

// UXIE-DISCORD-GUIDELINES §17.2 — never let secrets reach stdout.
const REDACT_SUBSTRINGS = ["BOT_TOKEN", "AUTH", "SECRET", "KEY"] as const;
const MAX_STRING = 2000;
const MAX_ARRAY = 100;

function shouldRedact(key: string): boolean {
  const upper = key.toUpperCase();
  return REDACT_SUBSTRINGS.some((s) => upper.includes(s));
}

// Recursive, cycle-safe, truncating sanitizer. `seen` tracks ancestors so a
// reference back to an in-progress container becomes "[Circular]" rather than
// throwing on JSON.stringify.
function sanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  }
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = value.slice(0, MAX_ARRAY).map((v) => sanitize(v, seen));
      if (value.length > MAX_ARRAY) out.push(`…[+${value.length - MAX_ARRAY} more]`);
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = shouldRedact(k) ? "[REDACTED]" : sanitize(v, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function emit(level: Level, scope: Fields, msg: string, fields: Fields = {}) {
  const seen = new WeakSet<object>();
  const redacted: Fields = {};
  for (const [k, v] of Object.entries(scope)) {
    redacted[k] = shouldRedact(k) ? "[REDACTED]" : sanitize(v, seen);
  }
  for (const [k, v] of Object.entries(fields)) {
    redacted[k] = shouldRedact(k) ? "[REDACTED]" : sanitize(v, seen);
  }
  const t = new Date().toISOString();
  const merged: Fields = { t, level, msg, ...redacted };
  console.log(JSON.stringify(merged));

  // Hand the entry to a registered sink, guarded so a faulty or self-logging sink can never throw
  // out of emit or recurse into logging. The sink sees the same redacted fields as stdout.
  if (sink && !inSink) {
    inSink = true;
    try {
      sink({ level, msg, t, fields: redacted });
    } catch {
      // A sink fault must never break logging — swallow.
    } finally {
      inSink = false;
    }
  }
}

function make(scope: Fields): Logger {
  return {
    info: (msg, f) => emit("info", scope, msg, f),
    notice: (msg, f) => emit("notice", scope, msg, f),
    warn: (msg, f) => emit("warn", scope, msg, f),
    error: (msg, f) => emit("error", scope, msg, f),
    child: (extra) => make({ ...scope, ...extra }),
  };
}

export function createLogger(): Logger {
  return make({});
}

export const log = createLogger();
