import { serverTimestamp } from 'firebase/firestore';
import { getUtcDayKey } from '../../utils/team/utc';
import { dedupeHistoryByUtcDay, hasUtcDayCompletion, trimMissionHistory } from './streakHistory';
import type { MissionCompletionRecord } from './streakTypes';

export interface RecordMissionCompletionInput {
  history: MissionCompletionRecord[];
  missionIndex?: number;
  completedAtMs?: number;
  dayKeyUTC?: string;
}

export interface RecordMissionCompletionResult {
  history: MissionCompletionRecord[];
  record: MissionCompletionRecord | null;
  isNewUtcDay: boolean;
  firestoreEntry: MissionCompletionRecord;
}

/**
 * Append a mission completion without mutating streak counters.
 * Skips when the UTC day already has a completion.
 */
export function recordMissionCompletion(
  input: RecordMissionCompletionInput,
): RecordMissionCompletionResult {
  const dayKeyUTC = input.dayKeyUTC ?? getUtcDayKey();
  const deduped = dedupeHistoryByUtcDay(input.history);

  const firestoreEntry: MissionCompletionRecord = {
    completedAt: serverTimestamp(),
    dayKeyUTC,
    ...(input.missionIndex != null ? { missionIndex: input.missionIndex } : {}),
  };

  if (hasUtcDayCompletion(deduped, dayKeyUTC)) {
    return {
      history: deduped,
      record: null,
      isNewUtcDay: false,
      firestoreEntry,
    };
  }

  const completedAtMs = input.completedAtMs ?? Date.now();
  const localRecord: MissionCompletionRecord = {
    completedAt: completedAtMs,
    dayKeyUTC,
    ...(input.missionIndex != null ? { missionIndex: input.missionIndex } : {}),
  };

  const history = trimMissionHistory(dedupeHistoryByUtcDay([...deduped, localRecord]));

  return {
    history,
    record: localRecord,
    isNewUtcDay: true,
    firestoreEntry,
  };
}
