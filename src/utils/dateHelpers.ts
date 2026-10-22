import { getLocalCalendarDayKey, parseCalendarDayKey } from './team/utc';

export { getLocalCalendarDayKey };

export function getTodayKey(): string {
  return getLocalCalendarDayKey();
}

/**
 * Whole calendar days between two YYYY-MM-DD keys (inclusive of direction: later - earlier).
 */
export function calendarDaysBetween(earlierKey: string, laterKey: string): number {
  const earlier = parseCalendarDayKey(earlierKey);
  const later = parseCalendarDayKey(laterKey);
  const diffMs = later.getTime() - earlier.getTime();
  return Math.round(diffMs / (1000 * 3600 * 24));
}

export function isSameCalendarDay(a: string, b: string): boolean {
  return a === b;
}

/** Monday-based index 0–6 (Mon = 0). */
export function getMondayBasedWeekIndex(date: Date = new Date()): number {
  return (date.getDay() + 6) % 7;
}
