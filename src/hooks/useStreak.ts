import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getIntensityMultiplier,
  getStreakLevel,
  getWeeklyProgressPercent,
} from '../services/streak/streakHelpers';
import type { StreakMissionCompleteResult, StreakState } from '../services/streak/streakTypes';
import {
  handleMissionStreakUpdate,
  initStreakSession,
  persistStreakSession,
  reconcileStreakSession,
  syncStreakFromRemote,
  type StreakSession,
} from '../features/streak/streakController';
import { shouldTriggerCelebration } from '../features/streak/streakCelebration';
import { getTodayUtcKey } from '../services/streak/streakEngine';

export interface UseStreakOptions {
  initial?: Partial<StreakState>;
  hydrateFromStorage?: boolean;
}

export interface UseStreakReturn {
  streak: number;
  longestStreak: number;
  hasCompletedToday: boolean;
  lastCompletedDate: string;
  justIncreasedStreak: boolean;
  weeklyProgressPercent: number;
  streakLevel: number;
  intensityMultiplier: number;
  isCelebrationActive: boolean;
  shouldCelebratePerfectWeek: boolean;
  setFromRemote: (remote: Parameters<typeof syncStreakFromRemote>[0]) => void;
  completeMission: (missionIndex?: number) => StreakMissionCompleteResult;
  resetJustIncreased: () => void;
}

export function useStreak(options: UseStreakOptions = {}): UseStreakReturn {
  const { hydrateFromStorage = false, initial } = options;
  const [session, setSession] = useState<StreakSession>(() =>
    hydrateFromStorage ? initStreakSession() : syncStreakFromRemote(initial ?? {}),
  );
  const [justIncreasedStreak, setJustIncreasedStreak] = useState(false);
  const todayUtcRef = useRef(getTodayUtcKey());
  const state = session.state;

  useEffect(() => {
    const tick = () => {
      const todayUtc = getTodayUtcKey();
      if (todayUtc === todayUtcRef.current) return;
      todayUtcRef.current = todayUtc;
      setSession((prev) => reconcileStreakSession(prev, todayUtc));
    };
    const interval = window.setInterval(tick, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const weeklyProgressPercent = useMemo(
    () => getWeeklyProgressPercent(state.streak),
    [state.streak],
  );
  const streakLevel = useMemo(() => getStreakLevel(state.streak), [state.streak]);
  const intensityMultiplier = useMemo(
    () => getIntensityMultiplier(state.streak),
    [state.streak],
  );
  const isCelebrationActive = useMemo(
    () =>
      shouldTriggerCelebration({
        streak: state.streak,
        hasCompletedToday: state.hasCompletedToday,
        shouldCelebratePerfectWeek: state.shouldCelebratePerfectWeek,
      }),
    [state.streak, state.hasCompletedToday, state.shouldCelebratePerfectWeek],
  );

  const setFromRemote = useCallback((remote: Parameters<typeof syncStreakFromRemote>[0]) => {
    setSession(syncStreakFromRemote(remote));
    setJustIncreasedStreak(false);
  }, []);

  const completeMission = useCallback((missionIndex?: number): StreakMissionCompleteResult => {
    let result: StreakMissionCompleteResult = {
      streak: 0,
      longestStreak: 0,
      hasCompletedToday: false,
      lastCompletedDate: '',
      streakIncreased: false,
      isNewCompletionDay: false,
    };
    setSession((prev) => {
      const next = handleMissionStreakUpdate(prev, missionIndex);
      result = next.result;
      return next.session;
    });
    setJustIncreasedStreak(result.streakIncreased);
    return result;
  }, []);

  const resetJustIncreased = useCallback(() => setJustIncreasedStreak(false), []);

  return {
    streak: state.streak,
    longestStreak: state.longestStreak,
    hasCompletedToday: state.hasCompletedToday,
    lastCompletedDate: state.lastCompletedDate,
    justIncreasedStreak,
    weeklyProgressPercent,
    streakLevel,
    intensityMultiplier,
    isCelebrationActive,
    shouldCelebratePerfectWeek: state.shouldCelebratePerfectWeek ?? false,
    setFromRemote,
    completeMission,
    resetJustIncreased,
  };
}

export { persistStreakSession as persistStreakState };
