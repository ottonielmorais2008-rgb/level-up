import {
  buildStreakStateFromPersisted,
  getTodayLocalKey,
  reconcileStreakFromHistory,
} from './streakEngine';
import { STREAK_STORAGE_KEY } from './streakConstants';
import { resolveMissionHistory } from './streakHistory';
import type { MissionCompletionRecord, StreakPersistedSlice, StreakState } from './streakTypes';
import { getUtcDayKey } from '../../utils/team/utc';

export function readStreakSlice(): StreakPersistedSlice | null {
  const raw = localStorage.getItem(STREAK_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StreakPersistedSlice;
  } catch {
    return null;
  }
}

export function loadStreakFromStorage(
  todayUtc: string = getUtcDayKey(),
): { state: StreakState; history: MissionCompletionRecord[] } | null {
  const slice = readStreakSlice();
  if (!slice) return null;
  const { state, history } = buildStreakStateFromPersisted(slice, todayUtc);
  return { state: reconcileStreakFromHistory(history, todayUtc), history };
}

export function mergeStreakIntoStorage(
  state: StreakState,
  history?: MissionCompletionRecord[],
): void {
  const raw = localStorage.getItem(STREAK_STORAGE_KEY);
  let payload: StreakPersistedSlice = {};
  if (raw) {
    try {
      payload = JSON.parse(raw) as StreakPersistedSlice;
    } catch {
      payload = {};
    }
  }
  payload.streak = state.streak;
  payload.longestStreak = state.longestStreak;
  payload.hasCompletedToday = state.hasCompletedToday;
  payload.lastCompletedDate = state.lastCompletedDate || getTodayLocalKey();
  payload.lastStreakUpdateDayKeyUTC = state.lastStreakUpdateDayKeyUTC ?? getUtcDayKey();
  if (history) payload.missionCompletionHistory = history;
  localStorage.setItem(STREAK_STORAGE_KEY, JSON.stringify(payload));
}

export function readMissionHistoryFromStorage(): MissionCompletionRecord[] {
  return resolveMissionHistory(readStreakSlice() ?? undefined);
}
