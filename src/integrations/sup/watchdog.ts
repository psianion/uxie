// SUP-stack watchdog: a background probe that checks scrypt + para-raid on an interval and logs
// only STATE TRANSITIONS (down / recovered), so the operator's Discord logs channel (which mirrors
// notice/warn/error via lib/discord-log-sink.ts) surfaces outages without anyone running /sup
// status. Same probe semantics as /sup status (commands/sup.ts). Injectable timer (deps.setTimer/
// clearTimer), copied from lib/discord-log-sink.ts, so this is unit-testable without real timers.
import { log } from "../../lib/log.ts";
import type { ScryptRestClient } from "../scrypt/rest-client.ts";
import type { ParaRaidClient } from "../para-raid/client.ts";

export interface WatchdogDeps {
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  intervalMs?: number; // default 5 * 60_000
}

type State = "up" | "down" | "unknown";
interface ProbeResult {
  up: boolean;
  reason?: string;
}

export function startWatchdog(
  rest: ScryptRestClient,
  paraRaid: ParaRaidClient | undefined,
  deps: WatchdogDeps = {},
): { stop(): void; probe(): Promise<void> } {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const intervalMs = deps.intervalMs ?? 5 * 60_000;

  let timer: unknown = null;
  let running = false;
  let stopped = false;

  // Previous reachability per target; "unknown" until the first probe. A first probe that's up is
  // silent (unknown→up); a first probe that's down IS a transition worth warning (unknown→down).
  const state: Record<string, State> = { scrypt: "unknown", "para-raid": "unknown" };

  function transition(target: string, r: ProbeResult): void {
    const prev = state[target]!;
    const next: State = r.up ? "up" : "down";
    if (prev === next) return; // steady state: no news.
    state[target] = next;
    if (next === "down") log.warn(`${target} down`, { reason: r.reason ?? "no reason" });
    else if (prev === "down") log.notice(`${target} recovered`); // unknown→up stays silent.
  }

  async function checkScrypt(): Promise<ProbeResult> {
    // health() degrades-don't-crashes (returns {ok,reason}); guard a reject anyway so a probe fault
    // becomes the down state, never an exception.
    try {
      const h = await rest.health();
      return h.ok ? { up: true } : { up: false, reason: h.reason ?? "not ok" };
    } catch (e) {
      return { up: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  async function checkParaRaid(): Promise<ProbeResult> {
    // Same as sup.ts: 200 = up; a reject or non-200 = down.
    const res = await paraRaid!.listSessions().catch(() => null);
    if (res && res.status === 200) return { up: true };
    return { up: false, reason: res ? `HTTP ${res.status}` : "unreachable" };
  }

  async function probe(): Promise<void> {
    transition("scrypt", await checkScrypt());
    if (paraRaid) transition("para-raid", await checkParaRaid()); // undefined = module off, not an outage.
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimer(tick, intervalMs);
  }

  function tick(): void {
    timer = null;
    // Overlap guard: a probe still running when the timer fires skips this tick.
    if (running) {
      schedule();
      return;
    }
    running = true;
    // A probe never throws, but .catch keeps a stray reject from escaping the timer callback.
    void probe()
      .catch(() => {})
      .finally(() => {
        running = false;
        schedule(); // setTimeout-chain: reschedule after each probe completes, like the log sink.
      });
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
    probe,
  };
}
