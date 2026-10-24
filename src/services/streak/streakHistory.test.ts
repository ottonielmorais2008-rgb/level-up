import { describe, expect, it } from 'vitest';
import { addUtcDays } from '../../utils/team/utc';
import {
  dedupeHistoryByUtcDay,
  hasUtcDayCompletion,
  longestConsecutiveUtcDays,
  normalizeCompletionRecord,
  resolveMissionHistory,
  trimMissionHistory,
  uniqueUtcDayKeys,
} from './streakHistory';
import type { MissionCompletionRecord } from './streakTypes';

const record = (
  dayKeyUTC: string,
  completedAt: MissionCompletionRecord['completedAt'] = `${dayKeyUTC}T10:00:00.000Z`,
  missionIndex?: number,
): MissionCompletionRecord => ({
  completedAt,
  dayKeyUTC,
  ...(missionIndex != null ? { missionIndex } : {}),
});

describe('normalizeCompletionRecord', () => {
  it('keeps a UTC day key and a zero mission index', () => {
    expect(normalizeCompletionRecord(record('2026-04-02', '2026-04-02T08:00:00.000Z', 0))).toEqual({
      completedAt: '2026-04-02T08:00:00.000Z',
      dayKeyUTC: '2026-04-02',
      missionIndex: 0,
    });
  });

  it('derives the day from a Firestore timestamp and cuts a long day key', () => {
    const seconds = Date.UTC(2024, 0, 1) / 1000;
    expect(normalizeCompletionRecord({ completedAt: { seconds } })).toMatchObject({
      dayKeyUTC: '2024-01-01',
    });
    expect(
      normalizeCompletionRecord({
        completedAt: 'not-a-timestamp',
        dayKeyUTC: '2026-08-01T23:59:00.000Z',
      })?.dayKeyUTC,
    ).toBe('2026-08-01');
  });

  it('drops a record with no timestamp and throws when the timestamp cannot be read', () => {
    expect(normalizeCompletionRecord({ dayKeyUTC: '2026-01-01' })).toBeNull();
    expect(normalizeCompletionRecord({})).toBeNull();
    expect(() => normalizeCompletionRecord({ completedAt: 'not-a-date' })).toThrow(RangeError);
  });
});

describe('dedupeHistoryByUtcDay', () => {
  it('keeps the latest completion for a day and sorts the result', () => {
    const history = dedupeHistoryByUtcDay([
      record('2026-04-03', '2026-04-03T09:00:00.000Z', 2),
      record('2026-04-01', '2026-04-01T09:00:00.000Z', 0),
      record('2026-04-01', '2026-04-01T21:00:00.000Z', 7),
      record('2026-04-01', '2026-04-01T12:00:00.000Z', 3),
    ]);

    expect(history.map((entry) => entry.dayKeyUTC)).toEqual(['2026-04-01', '2026-04-03']);
    expect(history[0]).toMatchObject({ missionIndex: 7, completedAt: '2026-04-01T21:00:00.000Z' });
  });

  it('keeps the later entry when two completions share a timestamp', () => {
    const history = dedupeHistoryByUtcDay([
      record('2026-04-01', '2026-04-01T10:00:00.000Z', 1),
      record('2026-04-01', '2026-04-01T10:00:00.000Z', 4),
    ]);
    expect(history).toHaveLength(1);
    expect(history[0].missionIndex).toBe(4);
  });

  it('skips entries without a timestamp and accepts an empty list', () => {
    expect(dedupeHistoryByUtcDay([])).toEqual([]);
    const history = dedupeHistoryByUtcDay([
      { completedAt: null, dayKeyUTC: '2026-04-01' },
      record('2026-04-02'),
    ]);
    expect(uniqueUtcDayKeys(history)).toEqual(['2026-04-02']);
  });
});

describe('trimMissionHistory', () => {
  it('returns every day when the history is inside the limit', () => {
    const history = [record('2026-01-01'), record('2026-01-02')];
    expect(trimMissionHistory(history, 5)).toEqual(dedupeHistoryByUtcDay(history));
    expect(trimMissionHistory([], 5)).toEqual([]);
    expect(trimMissionHistory(history, 0)).toEqual([]);
  });

  it('keeps the newest days, including the default 120-day window', () => {
    const history = Array.from({ length: 121 }, (_, index) => record(addUtcDays('2025-01-01', index)));
    const trimmed = trimMissionHistory(history, 3);
    expect(trimmed.map((entry) => entry.dayKeyUTC)).toEqual([
      addUtcDays('2025-01-01', 118),
      addUtcDays('2025-01-01', 119),
      addUtcDays('2025-01-01', 120),
    ]);

    const stored = trimMissionHistory(history);
    expect(stored).toHaveLength(120);
    expect(stored[0].dayKeyUTC).toBe(addUtcDays('2025-01-01', 1));
    expect(stored[119].dayKeyUTC).toBe(addUtcDays('2025-01-01', 120));
  });
});

describe('resolveMissionHistory', () => {
  it('returns nothing for a missing profile or a streak with no anchor day', () => {
    expect(resolveMissionHistory(null)).toEqual([]);
    expect(resolveMissionHistory(undefined)).toEqual([]);
    expect(resolveMissionHistory({ streak: 4 })).toEqual([]);
    expect(resolveMissionHistory({ streak: 0, lastStreakUpdateDayKeyUTC: '2026-03-03' })).toEqual([]);
  });

  it('rebuilds consecutive days from a legacy streak slice', () => {
    const history = resolveMissionHistory({
      streak: 3,
      lastStreakUpdateDayKeyUTC: '2026-03-03T18:00:00.000Z',
    });
    expect(history.map((entry) => entry.dayKeyUTC)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03']);
  });

  it('drops the anchor day when the legacy slice says today is not complete', () => {
    const history = resolveMissionHistory({
      streak: 3,
      lastStreakUpdateDayKeyUTC: '2026-03-03',
      hasCompletedToday: false,
    });
    expect(history.map((entry) => entry.dayKeyUTC)).toEqual(['2026-03-01', '2026-03-02']);
  });

  it('uses a stored history instead of the legacy counters', () => {
    const history = resolveMissionHistory({
      streak: 9,
      lastStreakUpdateDayKeyUTC: '2026-01-01',
      missionCompletionHistory: [record('2026-06-02'), record('2026-06-02'), record('2026-06-01')],
    });
    expect(history.map((entry) => entry.dayKeyUTC)).toEqual(['2026-06-01', '2026-06-02']);
  });

  it('falls back to the legacy slice only when the stored history is empty', () => {
    const fromEmpty = resolveMissionHistory({
      streak: 1,
      lastStreakUpdateDayKeyUTC: '2026-07-04',
      missionCompletionHistory: [],
    });
    expect(fromEmpty.map((entry) => entry.dayKeyUTC)).toEqual(['2026-07-04']);

    const fromBrokenEntries = resolveMissionHistory({
      streak: 5,
      lastStreakUpdateDayKeyUTC: '2026-07-04',
      missionCompletionHistory: [{ completedAt: null, dayKeyUTC: '2026-07-01' }],
    });
    expect(fromBrokenEntries).toEqual([]);
  });

  it('throws when a stored entry is not a record', () => {
    expect(() =>
      resolveMissionHistory({
        missionCompletionHistory: [null as unknown as MissionCompletionRecord],
      }),
    ).toThrow(TypeError);
  });
});

describe('longestConsecutiveUtcDays', () => {
  it('counts the longest run and resets after a gap', () => {
    expect(longestConsecutiveUtcDays([])).toBe(0);
    expect(longestConsecutiveUtcDays(['2026-01-01'])).toBe(1);
    expect(longestConsecutiveUtcDays(['2026-01-01', '2026-01-02', '2026-01-03'])).toBe(3);
    expect(longestConsecutiveUtcDays(['2026-01-01', '2026-01-02', '2026-01-04', '2026-01-05'])).toBe(2);
  });

  it('does not treat a reversed list as one run', () => {
    expect(longestConsecutiveUtcDays(['2026-01-03', '2026-01-02', '2026-01-01'])).toBe(1);
  });
});

describe('hasUtcDayCompletion', () => {
  it('matches a day after duplicates are removed', () => {
    const history = [record('2026-02-01'), record('2026-02-01'), record('2026-02-02')];
    expect(hasUtcDayCompletion(history, '2026-02-01')).toBe(true);
    expect(hasUtcDayCompletion(history, '2026-02-03')).toBe(false);
    expect(hasUtcDayCompletion([], '2026-02-01')).toBe(false);
  });
});
