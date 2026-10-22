import {
  STREAK_CELEBRATION_DURATION_MS,
  STREAK_CELEBRATION_PHRASES,
  STREAK_STRONG_PHRASES,
  STREAK_TENSE_PHRASES,
} from '../../services/streak/streakConstants';
import { isPerfectWeekCelebration, pickRandomExcluding } from '../../services/streak/streakHelpers';
import type { StreakCelebrationContext } from '../../services/streak/streakTypes';

export { STREAK_CELEBRATION_DURATION_MS };

export function shouldTriggerCelebration(ctx: StreakCelebrationContext): boolean {
  if (ctx.shouldCelebratePerfectWeek != null) {
    return ctx.shouldCelebratePerfectWeek;
  }
  return isPerfectWeekCelebration(ctx.streak, ctx.hasCompletedToday);
}

export function getCelebrationPhrase(current?: string): string {
  return pickRandomExcluding(STREAK_CELEBRATION_PHRASES, current);
}

export function getMomentumPhrase(streak: number, current?: string): string {
  const pool = streak > 7 ? STREAK_STRONG_PHRASES : STREAK_TENSE_PHRASES;
  return pickRandomExcluding(pool, current);
}
