import { recordMissionCompletion } from '../../services/streak/missionCompletionService';
import {
  buildStreakStateFromPersisted,
  completeMissionFromHistory,
  createStreakState,
  getTodayUtcKey,
  isUtcDayRollover,
  reconcileStreakFromHistory,
} from '../../services/streak/streakEngine';
import {
  loadStreakFromStorage,
  mergeStreakIntoStorage,
  readMissionHistoryFromStorage,
} from '../../services/streak/streakStorage';
import { dedupeHistoryByUtcDay, resolveMissionHistory } from '../../services/streak/streakHistory';
import type {
  MissionCompletionRecord,
  StreakMissionCompleteResult,
  StreakPersistedSlice,
  StreakState,
} from '../../services/streak/streakTypes';

export type { StreakState, StreakMissionCompleteResult, MissionCompletionRecord };

export interface StreakSession {
  state: StreakState;
  history: MissionCompletionRecord[];
  todayUtc: string;
}

function toSession(
  state: StreakState,
  history: MissionCompletionRecord[],
  todayUtc: string = getTodayUtcKey(),
): StreakSession {
  return {
    state: reconcileStreakFromHistory(history, todayUtc),
    history: dedupeHistoryByUtcDay(history),
    todayUtc,
  };
}

export function initStreakSession(todayUtc: string = getTodayUtcKey()): StreakSession {
  const loaded = loadStreakFromStorage(todayUtc);
  if (loaded) return toSession(loaded.state, loaded.history, todayUtc);
  return toSession(createStreakState(), readMissionHistoryFromStorage(), todayUtc);
}

export function syncStreakFromRemote(
  remote: StreakPersistedSlice | null | undefined,
  todayUtc: string = getTodayUtcKey(),
): StreakSession {
  const history = resolveMissionHistory(remote ?? undefined);
  const { state } = buildStreakStateFromPersisted(remote ?? undefined, todayUtc);
  return toSession(state, history, todayUtc);
}

export function reconcileStreakSession(
  session: StreakSession,
  todayUtc: string = getTodayUtcKey(),
): StreakSession {
  if (!isUtcDayRollover(session.todayUtc, todayUtc)) {
    return { ...session, todayUtc };
  }
  return toSession(session.state, session.history, todayUtc);
}

export function handleMissionStreakUpdate(
  session: StreakSession,
  missionIndex?: number,
  todayUtc: string = getTodayUtcKey(),
): {
  session: StreakSession;
  result: StreakMissionCompleteResult;
  firestoreEntry: ReturnType<typeof recordMissionCompletion>['firestoreEntry'];
} {
  const completion = recordMissionCompletion({ history: session.history, missionIndex });
  const result = completeMissionFromHistory(completion.history, todayUtc, session.history);
  const nextSession = toSession(result, completion.history, todayUtc);
  mergeStreakIntoStorage(nextSession.state, nextSession.history);
  return { session: nextSession, result, firestoreEntry: completion.firestoreEntry };
}

export function persistStreakSession(session: StreakSession): void {
  mergeStreakIntoStorage(session.state, session.history);
}

export function initStreakFromStorage(todayUtc: string = getTodayUtcKey()): StreakState {
  return initStreakSession(todayUtc).state;
}

export function persistStreakState(state: StreakState): void {
  mergeStreakIntoStorage(state);
}
