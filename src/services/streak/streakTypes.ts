import type { FieldValue, Timestamp } from 'firebase/firestore';

export type CompletionTimestamp =
  | Timestamp
  | FieldValue
  | number
  | string
  | { seconds: number; nanoseconds?: number }
  | Date
  | null
  | undefined;

export interface MissionCompletionRecord {
  completedAt: CompletionTimestamp;
  dayKeyUTC: string;
  missionIndex?: number;
}

export interface StreakState {
  streak: number;
  longestStreak: number;
  hasCompletedToday: boolean;
  lastCompletedDate: string;
  lastStreakUpdateDayKeyUTC?: string;
  weeklyStreak?: number;
  shouldCelebratePerfectWeek?: boolean;
}

export interface StreakPersistedSlice {
  streak?: number;
  longestStreak?: number;
  hasCompletedToday?: boolean;
  lastCompletedDate?: string;
  lastStreakUpdateDayKeyUTC?: string;
  missionCompletionHistory?: MissionCompletionRecord[];
}

export interface StreakComputed {
  currentStreak: number;
  weeklyStreak: number;
  personalRecord: number;
  hasCompletedToday: boolean;
  lastStreakUpdateDayKeyUTC: string;
  shouldCelebratePerfectWeek: boolean;
}

export interface StreakReconcileResult extends StreakState {
  wasReset: boolean;
  clearedTodayFlag: boolean;
}

export interface StreakMissionCompleteResult extends StreakState {
  streakIncreased: boolean;
  isNewCompletionDay: boolean;
}

export interface StreakCelebrationContext {
  streak: number;
  hasCompletedToday: boolean;
  shouldCelebratePerfectWeek?: boolean;
}

export interface StreakBundle {
  state: StreakState;
  history: MissionCompletionRecord[];
  computed: StreakComputed;
}
