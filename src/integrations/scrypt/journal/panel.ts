// Pure mapping from a Scrypt journal day bundle to a StatusModel + the day-key math the
// prev/next buttons need. No discord.js side effects, no I/O — unit-testable in isolation.
// A day always renders "ok" (an empty day is a fine day); the accent never signals health here.
import { ButtonStyle } from "discord.js";
import type { StatusButton, StatusModel, StatusRow } from "../../../lib/ui/status-container.ts";
import { utcToday } from "../rest-client.ts";
import type { JournalDayBundle } from "../schemas.ts";

const MAX_ENTRIES = 10;
const CLIP = 160;

function clip(s: string, n = CLIP): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// UTC date math with no dependency: parse the key, shift the day, re-serialise. Date.UTC
// normalises overflow/underflow (day 0 → prev month, day 32 → next month).
export function addDays(dayKey: string, delta: number): string {
  const [y = 0, m = 1, d = 1] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

export function journalDayModel(bundle: JournalDayBundle): StatusModel {
  const rows: StatusRow[] = [];

  const shown = bundle.entries.slice(0, MAX_ENTRIES);
  for (const e of shown) {
    rows.push({ icon: "📝", label: e.displayTime, value: clip(e.body) });
  }
  if (shown.length === 0) {
    rows.push({ icon: "📭", label: "empty", value: "no entries yet" });
  }

  if (bundle.tasks_due.length > 0) {
    const titles = bundle.tasks_due
      .map((t) => (t.status === "done" ? `~~${t.title}~~` : t.title))
      .join(", ");
    rows.push({ icon: "☑️", label: "tasks due", value: clip(titles) });
  }

  if (bundle.related.length > 0) {
    const titles = bundle.related.slice(0, 3).map((r) => r.title).join(", ");
    rows.push({ icon: "🔗", label: "related", value: clip(titles) });
  }

  const overflow = bundle.entries.length - MAX_ENTRIES;
  const footer =
    overflow > 0 ? `+${overflow} more · journal/${bundle.date}.md` : `journal/${bundle.date}.md`;

  const prev = addDays(bundle.date, -1);
  const next = addDays(bundle.date, 1);
  const buttons: StatusButton[] = [
    { id: `journal:day:${prev}`, label: `◀ ${prev}`, style: ButtonStyle.Secondary },
    {
      id: `journal:day:${next}`,
      label: `${next} ▶`,
      style: ButtonStyle.Secondary,
      disabled: bundle.date >= utcToday(),
    },
  ];

  return {
    title: `Journal · ${bundle.date}`,
    health: "ok",
    badge: `${bundle.entries.length} entries`,
    rows,
    footer,
    buttons,
  };
}
