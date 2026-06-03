// USER_TZ helpers used by /journal reply text and /brief title
// (UXIE-DISCORD-GUIDELINES §11 / ratified decision 13).
// Render-only: scrypt owns storage-side TZ math; these helpers never decide file paths.

export function journalDateKey(tz: string, date: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA gives YYYY-MM-DD natively.
  return fmt.format(date);
}

export function nowInZone(tz: string, date: Date = new Date()): { date: string; time: string } {
  const dateStr = journalDateKey(tz, date);
  const timeFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return { date: dateStr, time: timeFmt.format(date) };
}

// Decision 13 names. `today` is the YYYY-MM-DD key in the zone; `formatLocal`
// renders "YYYY-MM-DD HH:MM" for human-facing reply text and the /brief title.
export function today(tz: string, date: Date = new Date()): string {
  return journalDateKey(tz, date);
}

export function formatLocal(date: Date, tz: string): string {
  const { date: d, time } = nowInZone(tz, date);
  return `${d} ${time}`;
}
