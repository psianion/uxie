// Journal rituals: a background scheduler that posts three time-of-day nudges to the operator's
// #journal channel — a morning briefing (streak + tasks + related notes), an evening nudge (only
// when the day is still empty), and a weekly para-raid week-in-review digest. Injectable timer
// (deps.setTimer/clearTimer), copied from sup/watchdog.ts, so this is unit-testable without real
// timers — but the timers here are CLOCK-ALIGNED (fire at HH:MM UTC), not fixed-interval, so the
// setTimeout-chain recomputes ms-until-next after every fire. Every ritual body is wrapped so a
// fetch/send fault logs a warn and never escapes the timer or stops the chain.
import { log } from "../../lib/log.ts";
import { utcToday } from "../scrypt/rest-client.ts";
import type { ScryptRestClient } from "../scrypt/rest-client.ts";
import type { ParaRaidClient } from "../para-raid/client.ts";

export interface RitualChannel {
  send(content: string): Promise<unknown>;
  createThread(opts: { name: string }): Promise<{ id: string }>;
}
export interface RitualDeps {
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => Date; // injectable clock for tests
}
export interface RitualConfig {
  morningUtc: string; // "HH:MM"
  eveningUtc: string; // "HH:MM"
  weeklyDigestUtcDay: number; // 0=Sunday; digest fires at morningUtc on this day
  bundle?: string; // MCP bundle name for the digest session
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ms from `now` until the next HH:MM UTC instant, always strictly in the future (0 < r <= 24h):
// an exact hit rolls to tomorrow rather than firing a zero-delay timer.
export function msUntilNextUtc(hhmm: string, now: Date): number {
  const [h, m] = hhmm.split(":").map(Number);
  const target = new Date(now);
  target.setUTCHours(h!, m!, 0, 0);
  let ms = target.getTime() - now.getTime();
  if (ms <= 0) ms += DAY_MS;
  return ms;
}

// YYYY-MM-DD (UTC) shifted by `delta` days — pure date math on the day key.
function addDaysUtc(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// Consecutive calendar days (count>0) ending at YESTERDAY. today's own entry neither breaks nor
// extends the streak (the day isn't over), so we walk backward from yesterday only.
export function streakEndingYesterday(cal: Array<{ date: string; count: number }>, today: string): number {
  const have = new Set(cal.filter((c) => c.count > 0).map((c) => c.date));
  let n = 0;
  let d = addDaysUtc(today, -1);
  while (have.has(d)) {
    n++;
    d = addDaysUtc(d, -1);
  }
  return n;
}

export function startJournalRituals(
  rest: ScryptRestClient,
  paraRaid: ParaRaidClient | undefined,
  channel: RitualChannel,
  cfg: RitualConfig,
  deps: RitualDeps = {},
): { stop(): void } {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = deps.now ?? (() => new Date());

  let timer: unknown = null;
  let stopped = false;

  // Wrap a ritual so a fetch/send fault warns and dies here — never escapes the timer, never
  // stops the chain.
  async function safe(ritual: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      log.warn("journal ritual failed", { ritual, err });
    }
  }

  async function runMorning(): Promise<void> {
    const today = utcToday(now());
    const [bundle, cal] = await Promise.all([
      rest.journalDay(today),
      rest.journalCalendar({ from: addDaysUtc(today, -30) }),
    ]);
    const lines = [`☀️ **Journal — ${today}**`, `📝 ${bundle.entries.length} entries so far`];
    for (const t of bundle.tasks_due) lines.push(`- [${t.status === "done" ? "x" : " "}] ${t.title}`);
    for (const r of bundle.related.slice(0, 3)) lines.push(`• ${r.title}`);
    lines.push(`🔥 streak: ${streakEndingYesterday(cal, today)} days`);
    await channel.send(lines.join("\n"));

    // Weekly digest rides the morning ritual, but in its own wrapper so a para-raid fault can't
    // take down the briefing that already posted.
    if (paraRaid && new Date(`${today}T00:00:00Z`).getUTCDay() === cfg.weeklyDigestUtcDay) {
      await safe("weekly", () => runWeeklyDigest(today));
    }
  }

  async function runEvening(): Promise<void> {
    const bundle = await rest.journalDay(utcToday(now()));
    // Silence is the feature: only nudge when the day is still empty.
    if (bundle.entries.length === 0) {
      await channel.send("🌙 no journal entries today yet — how was it? (just type here)");
    }
  }

  async function runWeeklyDigest(today: string): Promise<void> {
    const thread = await channel.createThread({ name: `week in review — ${today}` });
    const dates: string[] = [];
    for (let i = 1; i <= 7; i++) dates.push(addDaysUtc(today, -i));
    const prompt = [
      "Weekly journal review. Read the last 7 days of journal files via your scrypt MCP tools:",
      ...dates.map((d) => `journal/${d}.md`),
      'Write a compact week-in-review vault note (create_note, doc_type "research" — or the journal',
      "itself is fine; the operator can redirect).",
      "Then reply in ≤15 lines: highlights, recurring themes, loose threads.",
    ].join("\n");
    await paraRaid!.openSession({ adapter_ref: thread.id, bundle_name: cfg.bundle, prompt });
  }

  // Next ritual = whichever of morning/evening is sooner (ties → morning). Both are strictly in
  // the future, so the chain always advances.
  function nextRitual(): { kind: "morning" | "evening"; ms: number } {
    const m = msUntilNextUtc(cfg.morningUtc, now());
    const e = msUntilNextUtc(cfg.eveningUtc, now());
    return e < m ? { kind: "evening", ms: e } : { kind: "morning", ms: m };
  }

  function schedule(): void {
    if (stopped) return;
    const { kind, ms } = nextRitual();
    timer = setTimer(() => {
      timer = null;
      const run = kind === "morning" ? runMorning : runEvening;
      // setTimeout-chain: recompute ms-until-next and reschedule after each ritual completes.
      void safe(kind, run).finally(schedule);
    }, ms);
  }

  schedule();

  return {
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
}
