import {
  STREAK_INTENSITY_TIER_100,
  STREAK_INTENSITY_TIER_30,
  STREAK_MILESTONE_WEEK,
} from './streakConstants';

export function getWeeklyProgressPercent(streak: number): number {
  const dayInWeek = streak % STREAK_MILESTONE_WEEK || (streak > 0 ? STREAK_MILESTONE_WEEK : 0);
  return Math.min((dayInWeek / STREAK_MILESTONE_WEEK) * 100, 100);
}

export function getStreakLevel(streak: number): number {
  return Math.floor(streak / STREAK_MILESTONE_WEEK) + 1;
}

export function getIntensityMultiplier(streak: number): number {
  if (streak >= STREAK_INTENSITY_TIER_100) return 1.5;
  if (streak >= STREAK_INTENSITY_TIER_30) return 1.2;
  return 1;
}

export function pickRandomExcluding<T>(pool: readonly T[], current?: T): T {
  const filtered = current != null ? pool.filter((p) => p !== current) : [...pool];
  const source = filtered.length > 0 ? filtered : pool;
  return source[Math.floor(Math.random() * source.length)];
}

export function isPerfectWeekCelebration(
  streak: number,
  hasCompletedToday: boolean,
  streakIncreased = true,
): boolean {
  return (
    streakIncreased &&
    streak > 0 &&
    streak % STREAK_MILESTONE_WEEK === 0 &&
    hasCompletedToday
  );
}
