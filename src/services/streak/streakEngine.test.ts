import { describe, expect, it } from 'vitest';
import { completeMissionFromHistory, computeStreakFromHistory } from './streakEngine';
import type { MissionCompletionRecord } from './streakTypes';

const day = (dayKeyUTC: string): MissionCompletionRecord => ({
  completedAt: `${dayKeyUTC}T10:00:00.000Z`,
  dayKeyUTC,
});

describe('computeStreakFromHistory', () => {
  it('counts consecutive UTC days ending today', () => {
    const history = ['2026-01-01', '2026-01-02', '2026-01-03'].map(day);
    const result = computeStreakFromHistory(history, '2026-01-03');
    expect(result.currentStreak).toBe(3);
    expect(result.hasCompletedToday).toBe(true);
  });

  it('keeps the streak alive until the end of the next day', () => {
    const history = ['2026-01-01', '2026-01-02'].map(day);
    expect(computeStreakFromHistory(history, '2026-01-03').currentStreak).toBe(2);
  });

  it('resets after a missed day', () => {
    const history = ['2026-01-01', '2026-01-02'].map(day);
    expect(computeStreakFromHistory(history, '2026-01-04').currentStreak).toBe(0);
  });
});

describe('completeMissionFromHistory', () => {
  const sixDays = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06'].map(day);

  it('detects a new completion day and celebrates a perfect week', () => {
    const after = [...sixDays, day('2026-01-07')];
    const result = completeMissionFromHistory(after, '2026-01-07', sixDays);
    expect(result.isNewCompletionDay).toBe(true);
    expect(result.streakIncreased).toBe(true);
    expect(result.streak).toBe(7);
    expect(result.shouldCelebratePerfectWeek).toBe(true);
  });

  it('does not celebrate twice on the same day', () => {
    const after = [...sixDays, day('2026-01-07')];
    const result = completeMissionFromHistory(after, '2026-01-07', after);
    expect(result.isNewCompletionDay).toBe(false);
    expect(result.shouldCelebratePerfectWeek).toBe(false);
  });
});
