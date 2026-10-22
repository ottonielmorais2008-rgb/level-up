/**
 * Calendar-day key in local timezone (YYYY-MM-DD), matching legacy en-CA locale format.
 */
export function getLocalCalendarDayKey(date: Date = new Date()): string {
  return date.toLocaleDateString('en-CA');
}

export function parseCalendarDayKey(key: string): Date {
  return new Date(key);
}

/** Normalized UTC calendar day (YYYY-MM-DD). */
export function getUtcDayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function parseUtcDayKey(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

export function addUtcDays(dayKey: string, delta: number): string {
  const d = parseUtcDayKey(dayKey);
  d.setUTCDate(d.getUTCDate() + delta);
  return getUtcDayKey(d);
}

/** Whole UTC calendar days between two YYYY-MM-DD keys (later − earlier). */
export function utcCalendarDaysBetween(earlierKey: string, laterKey: string): number {
  const diffMs = parseUtcDayKey(laterKey).getTime() - parseUtcDayKey(earlierKey).getTime();
  return Math.round(diffMs / (1000 * 3600 * 24));
}
