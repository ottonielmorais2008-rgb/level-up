/** XP required to advance one level. The profile bar is always this wide. */
export const XP_PER_LEVEL = 100;

/**
 * Level shown on the home screen and the profile.
 * 0 XP is level 0; the bar fills until the next multiple of {@link XP_PER_LEVEL}.
 */
export function levelFromTotalXp(totalXp: number): number {
  return Math.floor(totalXp / XP_PER_LEVEL);
}

/**
 * Level stored on the user document.
 * A brand-new profile has 0 XP and is written as level 1.
 */
export function persistedLevelFromTotalXp(totalXp: number): number {
  return Math.floor(totalXp / XP_PER_LEVEL) || 1;
}

/** XP already earned inside the current level, in the range used by the profile bar. */
export function xpIntoCurrentLevel(totalXp: number): number {
  return totalXp % XP_PER_LEVEL;
}

/** Fill of the profile bar, from 0 to 100, for the XP inside the current level. */
export function levelProgressPercent(totalXp: number): number {
  return (xpIntoCurrentLevel(totalXp) / XP_PER_LEVEL) * 100;
}

/** Level index after `earnedXp` is added to `totalXp`, before the total is stored. */
export function levelAfterEarning(totalXp: number, earnedXp: number): number {
  return Math.floor((totalXp + earnedXp) / XP_PER_LEVEL);
}

/**
 * True when the reward screen should play the level-up state.
 * Compares the level of the new total with the level of the total before this reward.
 */
export function didLevelUp(totalXp: number, earnedXp: number): boolean {
  return levelFromTotalXp(totalXp) > levelFromTotalXp(totalXp - earnedXp);
}
