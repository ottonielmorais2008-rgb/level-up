import {
  addUtcDays,
  getLocalCalendarDayKey,
  getUtcDayKey,
  parseUtcDayKey,
  utcCalendarDaysBetween,
} from '../../utils/team/utc';
import type { CompletionTimestamp, MissionCompletionRecord, StreakPersistedSlice } from './streakTypes';

const MAX_STORED_COMPLETION_DAYS = 120;

function toDate(value: CompletionTimestamp): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? parseUtcDayKey(value) : parsed;
  }
  if (typeof value === 'object' && 'seconds' in value) {
    return new Date(value.seconds * 1000);
  }
  if (typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    return value.toDate();
  }
  return null;
}

export function dayKeyUtcFromCompletedAt(completedAt: CompletionTimestamp): string {
  const date = toDate(completedAt);
  return date ? getUtcDayKey(date) : getUtcDayKey();
}

export function normalizeCompletionRecord(
  raw: Partial<MissionCompletionRecord>,
): MissionCompletionRecord | null {
  const completedAt = raw.completedAt;
  if (completedAt == null) return null;

  const dayKeyUTC =
    typeof raw.dayKeyUTC === 'string' && raw.dayKeyUTC.length >= 10
      ? raw.dayKeyUTC.slice(0, 10)
      : dayKeyUtcFromCompletedAt(completedAt);

  return {
    completedAt,
    dayKeyUTC,
    ...(raw.missionIndex != null ? { missionIndex: raw.missionIndex } : {}),
  };
}

export function dedupeHistoryByUtcDay(
  history: MissionCompletionRecord[],
): MissionCompletionRecord[] {
  const byDay = new Map<string, MissionCompletionRecord>();

  for (const raw of history) {
    const record = normalizeCompletionRecord(raw);
    if (!record) continue;

    const existing = byDay.get(record.dayKeyUTC);
    if (!existing) {
      byDay.set(record.dayKeyUTC, record);
      continue;
    }

    const existingMs = toDate(existing.completedAt)?.getTime() ?? 0;
    const nextMs = toDate(record.completedAt)?.getTime() ?? 0;
    if (nextMs >= existingMs) {
      byDay.set(record.dayKeyUTC, record);
    }
  }

  return [...byDay.values()].sort((a, b) => a.dayKeyUTC.localeCompare(b.dayKeyUTC));
}

export function trimMissionHistory(
  history: MissionCompletionRecord[],
  maxDays: number = MAX_STORED_COMPLETION_DAYS,
): MissionCompletionRecord[] {
  const deduped = dedupeHistoryByUtcDay(history);
  if (deduped.length <= maxDays) return deduped;
  return deduped.slice(deduped.length - maxDays);
}

export function uniqueUtcDayKeys(history: MissionCompletionRecord[]): string[] {
  return dedupeHistoryByUtcDay(history).map((r) => r.dayKeyUTC);
}

function synthesizeLegacyHistory(slice: StreakPersistedSlice): MissionCompletionRecord[] {
  const streak = slice.streak ?? 0;
  const anchor =
    slice.lastStreakUpdateDayKeyUTC?.slice(0, 10) ||
    (slice.lastCompletedDate
      ? getUtcDayKey(new Date(`${slice.lastCompletedDate}T12:00:00`))
      : '');

  if (!anchor || streak <= 0) return [];

  const records: MissionCompletionRecord[] = [];
  for (let i = 0; i < streak; i++) {
    const dayKeyUTC = addUtcDays(anchor, -i);
    records.push({
      completedAt: `${dayKeyUTC}T12:00:00.000Z`,
      dayKeyUTC,
    });
  }

  if (slice.hasCompletedToday === false && records.length > 0) {
    records.shift();
  }

  return dedupeHistoryByUtcDay(records);
}

export function resolveMissionHistory(
  slice: StreakPersistedSlice | null | undefined,
): MissionCompletionRecord[] {
  if (!slice) return [];

  const raw = slice.missionCompletionHistory;
  if (Array.isArray(raw) && raw.length > 0) {
    const normalized = raw
      .map((entry) => normalizeCompletionRecord(entry))
      .filter((entry): entry is MissionCompletionRecord => entry != null);
    return dedupeHistoryByUtcDay(normalized);
  }

  return synthesizeLegacyHistory(slice);
}

export function hasUtcDayCompletion(
  history: MissionCompletionRecord[],
  dayKeyUTC: string,
): boolean {
  return uniqueUtcDayKeys(history).includes(dayKeyUTC);
}

export function legacyLastCompletedDate(history: MissionCompletionRecord[]): string {
  const keys = uniqueUtcDayKeys(history);
  if (keys.length === 0) return '';
  const latestUtc = keys[keys.length - 1];
  return getLocalCalendarDayKey(parseUtcDayKey(latestUtc));
}

export function longestConsecutiveUtcDays(dayKeysAsc: string[]): number {
  if (dayKeysAsc.length === 0) return 0;

  let longest = 1;
  let run = 1;

  for (let i = 1; i < dayKeysAsc.length; i++) {
    if (utcCalendarDaysBetween(dayKeysAsc[i - 1], dayKeysAsc[i]) === 1) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 1;
    }
  }

  return longest;
}
