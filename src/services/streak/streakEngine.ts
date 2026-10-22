import { getLocalCalendarDayKey, getUtcDayKey, addUtcDays } from '../../utils/team/utc';
import { STREAK_MILESTONE_WEEK } from './streakConstants';
import {
  dedupeHistoryByUtcDay,
  legacyLastCompletedDate,
  longestConsecutiveUtcDays,
  resolveMissionHistory,
  uniqueUtcDayKeys,
} from './streakHistory';
import type {
  MissionCompletionRecord,
  StreakComputed,
  StreakMissionCompleteResult,
  StreakPersistedSlice,
  StreakState,
} from './streakTypes';

export const DEFAULT_STREAK_STATE: StreakState = {
  streak: 0,
  longestStreak: 0,
  hasCompletedToday: false,
  lastCompletedDate: '',
  lastStreakUpdateDayKeyUTC: '',
  weeklyStreak: 0,
  shouldCelebratePerfectWeek: false,
};

export function createStreakState(partial?: Partial<StreakState>): StreakState {
  return { ...DEFAULT_STREAK_STATE, ...partial };
}

function weeklyStreakFromCurrent(currentStreak: number): number {
  if (currentStreak <= 0) return 0;
  const mod = currentStreak % STREAK_MILESTONE_WEEK;
  return mod === 0 ? STREAK_MILESTONE_WEEK : mod;
}

function shouldCelebratePerfectWeek(
  currentStreak: number,
  hasCompletedToday: boolean,
  streakIncreased: boolean,
): boolean {
  return (
    streakIncreased &&
    hasCompletedToday &&
    currentStreak > 0 &&
    currentStreak % STREAK_MILESTONE_WEEK === 0
  );
}

export function computeStreakFromHistory(
  history: MissionCompletionRecord[],
  todayUtc: string = getUtcDayKey(),
): StreakComputed {
  const dayKeys = uniqueUtcDayKeys(history);
  const daySet = new Set(dayKeys);
  const hasCompletedToday = daySet.has(todayUtc);
  let currentStreak = 0;
  let anchor = todayUtc;

  if (!daySet.has(todayUtc)) {
    const yesterday = addUtcDays(todayUtc, -1);
    if (daySet.has(yesterday)) {
      anchor = yesterday;
    } else {
      return {
        currentStreak: 0,
        weeklyStreak: 0,
        personalRecord: longestConsecutiveUtcDays(dayKeys),
        hasCompletedToday: false,
        lastStreakUpdateDayKeyUTC: dayKeys[dayKeys.length - 1] ?? '',
        shouldCelebratePerfectWeek: false,
      };
    }
  }

  let cursor = anchor;
  while (daySet.has(cursor)) {
    currentStreak += 1;
    cursor = addUtcDays(cursor, -1);
  }

  const personalRecord = Math.max(longestConsecutiveUtcDays(dayKeys), currentStreak);

  return {
    currentStreak,
    weeklyStreak: weeklyStreakFromCurrent(currentStreak),
    personalRecord,
    hasCompletedToday,
    lastStreakUpdateDayKeyUTC: dayKeys[dayKeys.length - 1] ?? '',
    shouldCelebratePerfectWeek: false,
  };
}

export function computedToStreakState(
  computed: StreakComputed,
  history: MissionCompletionRecord[],
  extras?: Partial<StreakState>,
): StreakState {
  return createStreakState({
    streak: computed.currentStreak,
    longestStreak: computed.personalRecord,
    hasCompletedToday: computed.hasCompletedToday,
    lastCompletedDate: legacyLastCompletedDate(history),
    lastStreakUpdateDayKeyUTC: computed.lastStreakUpdateDayKeyUTC,
    weeklyStreak: computed.weeklyStreak,
    shouldCelebratePerfectWeek: computed.shouldCelebratePerfectWeek,
    ...extras,
  });
}

export function buildStreakStateFromHistory(
  history: MissionCompletionRecord[],
  todayUtc: string = getUtcDayKey(),
): StreakState {
  return computedToStreakState(computeStreakFromHistory(history, todayUtc), history);
}

export function buildStreakStateFromPersisted(
  slice: StreakPersistedSlice | null | undefined,
  todayUtc: string = getUtcDayKey(),
): { state: StreakState; history: MissionCompletionRecord[] } {
  const history = resolveMissionHistory(slice ?? undefined);
  return { state: buildStreakStateFromHistory(history, todayUtc), history };
}

export function reconcileStreakFromHistory(
  history: MissionCompletionRecord[],
  todayUtc: string = getUtcDayKey(),
): StreakState {
  const after = computeStreakFromHistory(history, todayUtc);
  return computedToStreakState(after, history, { shouldCelebratePerfectWeek: false });
}

/**
 * @param history       history that already includes today's completion
 * @param historyBefore history as it was before this completion was recorded.
 *                      Needed to detect a new completion day; when omitted the
 *                      function falls back to `history` (old behaviour).
 */
export function completeMissionFromHistory(
  history: MissionCompletionRecord[],
  todayUtc: string = getUtcDayKey(),
  historyBefore?: MissionCompletionRecord[],
): StreakMissionCompleteResult {
  const deduped = dedupeHistoryByUtcDay(history);
  const before = computeStreakFromHistory(
    historyBefore ? dedupeHistoryByUtcDay(historyBefore) : deduped,
    todayUtc,
  );
  const isNewCompletionDay = !before.hasCompletedToday;
  const after = computeStreakFromHistory(deduped, todayUtc);
  const streakIncreased = isNewCompletionDay && after.currentStreak > before.currentStreak;

  const computed: StreakComputed = {
    ...after,
    shouldCelebratePerfectWeek: shouldCelebratePerfectWeek(
      after.currentStreak,
      after.hasCompletedToday,
      streakIncreased,
    ),
  };

  return {
    ...computedToStreakState(computed, deduped),
    streakIncreased,
    isNewCompletionDay,
  };
}

export function reconcileStreak(
  input: Partial<StreakState>,
  todayKey: string,
) {
  const history = resolveMissionHistory({
    streak: input.streak,
    longestStreak: input.longestStreak,
    hasCompletedToday: input.hasCompletedToday,
    lastCompletedDate: input.lastCompletedDate,
    lastStreakUpdateDayKeyUTC: input.lastStreakUpdateDayKeyUTC,
  });
  const todayUtc = getUtcDayKey(new Date(`${todayKey}T12:00:00`));
  const state = reconcileStreakFromHistory(history, todayUtc);
  const beforeStreak = input.streak ?? 0;
  return {
    ...state,
    wasReset: state.streak === 0 && beforeStreak > 0 && !state.hasCompletedToday,
    clearedTodayFlag: (input.hasCompletedToday ?? false) && !state.hasCompletedToday,
  };
}

export function completeMissionToday(
  state: StreakState,
  todayKey: string,
): StreakMissionCompleteResult {
  const history = resolveMissionHistory({
    streak: state.streak,
    longestStreak: state.longestStreak,
    hasCompletedToday: state.hasCompletedToday,
    lastCompletedDate: state.lastCompletedDate,
    lastStreakUpdateDayKeyUTC: state.lastStreakUpdateDayKeyUTC,
  });
  const todayUtc = getUtcDayKey(new Date(`${todayKey}T12:00:00`));
  const historyBefore = [...history];
  if (!state.hasCompletedToday) {
    history.push({ completedAt: new Date().toISOString(), dayKeyUTC: todayUtc });
  }
  return completeMissionFromHistory(history, todayUtc, historyBefore);
}

export function isUtcDayRollover(
  previousDayKeyUTC: string,
  todayUtc: string = getUtcDayKey(),
): boolean {
  if (!previousDayKeyUTC) return false;
  return previousDayKeyUTC !== todayUtc;
}

export function getTodayUtcKey(): string {
  return getUtcDayKey();
}

export function getTodayLocalKey(): string {
  return getLocalCalendarDayKey();
}
