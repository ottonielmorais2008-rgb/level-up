import { describe, expect, it } from 'vitest';
import { getMissionData, missionDuration, missionXp } from '../missions/missionData';
import {
  XP_PER_LEVEL,
  didLevelUp,
  levelAfterEarning,
  levelFromTotalXp,
  levelProgressPercent,
  persistedLevelFromTotalXp,
  xpIntoCurrentLevel,
} from './xp';

describe('levelFromTotalXp', () => {
  it('stays on the same level until the next hundred XP', () => {
    expect(levelFromTotalXp(0)).toBe(0);
    expect(levelFromTotalXp(50)).toBe(0);
    expect(levelFromTotalXp(99)).toBe(0);
    expect(levelFromTotalXp(100)).toBe(1);
    expect(levelFromTotalXp(199)).toBe(1);
    expect(levelFromTotalXp(250)).toBe(2);
  });

  it('floors fractional XP and does not invent a level for invalid totals', () => {
    expect(levelFromTotalXp(99.9)).toBe(0);
    expect(levelFromTotalXp(100.1)).toBe(1);
    expect(levelFromTotalXp(-1)).toBe(-1);
    expect(levelFromTotalXp(Number.NaN)).toBeNaN();
    expect(levelFromTotalXp(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('persistedLevelFromTotalXp', () => {
  it('writes a new profile as level 1 and keeps later thresholds', () => {
    expect(persistedLevelFromTotalXp(0)).toBe(1);
    expect(persistedLevelFromTotalXp(99)).toBe(1);
    expect(persistedLevelFromTotalXp(100)).toBe(1);
    expect(persistedLevelFromTotalXp(200)).toBe(2);
  });

  it('turns a non-numeric total into level 1 and keeps a negative floor', () => {
    expect(persistedLevelFromTotalXp(Number.NaN)).toBe(1);
    expect(persistedLevelFromTotalXp(-50)).toBe(-1);
  });
});

describe('profile progress', () => {
  it('fills the bar inside the current level and resets it on the boundary', () => {
    expect(XP_PER_LEVEL).toBe(100);
    expect(xpIntoCurrentLevel(0)).toBe(0);
    expect(xpIntoCurrentLevel(40)).toBe(40);
    expect(xpIntoCurrentLevel(100)).toBe(0);
    expect(xpIntoCurrentLevel(250)).toBe(50);
    expect(levelProgressPercent(0)).toBe(0);
    expect(levelProgressPercent(40)).toBe(40);
    expect(levelProgressPercent(100)).toBe(0);
    expect(levelProgressPercent(250)).toBe(50);
  });

  it('reports the level reached after a reward is added', () => {
    expect(levelAfterEarning(90, 9)).toBe(0);
    expect(levelAfterEarning(90, 10)).toBe(1);
    expect(levelAfterEarning(90, 20)).toBe(1);
    expect(levelAfterEarning(0, 0)).toBe(0);
  });
});

describe('didLevelUp', () => {
  it('is true only when the reward crosses a hundred-XP boundary', () => {
    expect(didLevelUp(100, 1)).toBe(true);
    expect(didLevelUp(100, 100)).toBe(true);
    expect(didLevelUp(199, 99)).toBe(false);
    expect(didLevelUp(200, 1)).toBe(true);
    expect(didLevelUp(250, 50)).toBe(false);
    expect(didLevelUp(250, 51)).toBe(true);
  });

  it('stays false when nothing was earned, including on a boundary', () => {
    expect(didLevelUp(0, 0)).toBe(false);
    expect(didLevelUp(100, 0)).toBe(false);
    expect(didLevelUp(240, 0)).toBe(false);
  });

  it('compares the totals even when the reward is larger than the previous total', () => {
    expect(didLevelUp(50, 60)).toBe(true);
    expect(didLevelUp(50, 40)).toBe(false);
  });
});

describe('mission rewards', () => {
  it('gives the opening missions a fixed reward and then scales with the cycle', () => {
    expect(missionXp(0, 10, 4)).toBe(100);
    expect(missionXp(1, 10, 4)).toBe(80);
    expect(missionXp(2, 10, 4)).toBe(60);
    expect(missionXp(3, 15, 0)).toBe(15);
    expect(missionXp(3, 15, 2)).toBe(25);
  });

  it('ignores the opening bonus for indexes that are not 0, 1 or 2', () => {
    expect(missionXp(-1, 10, 2)).toBe(20);
    expect(missionXp(Number.NaN, 10, 2)).toBe(20);
    expect(missionXp(Number.POSITIVE_INFINITY, 10, 1)).toBe(15);
  });

  it('caps the timer at 45 seconds and keeps the first mission at 5', () => {
    expect(missionDuration(0, 10, 9)).toBe(5);
    expect(missionDuration(3, 10, 0)).toBe(10);
    expect(missionDuration(3, 10, 6)).toBe(40);
    expect(missionDuration(3, 15, 6)).toBe(45);
    expect(missionDuration(3, 10, 100)).toBe(45);
  });

  it('does not apply the opening duration to a non-zero index', () => {
    expect(missionDuration(Number.NaN, 10, 2)).toBe(20);
  });
});

describe('getMissionData', () => {
  it('builds the first cycle with fixed XP and the base copy', () => {
    expect(getMissionData(0)).toEqual({
      title: 'Interrupt',
      instruction: 'Put your phone face down for 5 seconds.',
      duration: 5,
      xp: 100,
    });
    expect(getMissionData(1)).toMatchObject({
      title: 'Snap Out',
      instruction: 'Clap your hands once and sit up straight.',
      duration: 5,
      xp: 80,
    });
    expect(getMissionData(2)).toMatchObject({ title: 'Eye Reset', duration: 15, xp: 60 });
    expect(getMissionData(4)).toMatchObject({
      title: 'Micro Move',
      instruction: 'Stand up and take 3 steps.',
      xp: 15,
    });
    expect(getMissionData(11)).toMatchObject({ title: 'Focus Lock', duration: 15, xp: 25 });
  });

  it('reshuffles the next cycle and raises counts, duration and XP', () => {
    expect(getMissionData(12)).toEqual({
      title: 'Snap Out',
      instruction: 'Clap your hands 2 times and sit up straight.',
      duration: 10,
      xp: 15,
    });
    expect(getMissionData(15)).toMatchObject({
      title: 'Micro Move',
      instruction: 'Stand up and take 5 steps.',
      duration: 15,
      xp: 20,
    });
  });

  it('visits each mission once per cycle', () => {
    const titles = [
      'Interrupt',
      'Snap Out',
      'Eye Reset',
      'Still Mode',
      'Micro Move',
      'Shoulder Reset',
      'Breath Lock',
      'Hand Control',
      'One Thought',
      'Name It',
      'Decision Snap',
      'Focus Lock',
    ];

    for (let cycle = 0; cycle < 4; cycle++) {
      const seen = Array.from({ length: 12 }, (_, position) => getMissionData(cycle * 12 + position).title);
      expect(seen.slice().sort()).toEqual(titles.slice().sort());
    }
  });

  it('caps duration at 45 seconds once the cycle bonus reaches the limit', () => {
    expect(getMissionData(77)).toMatchObject({
      title: 'Shoulder Reset',
      instruction: 'Roll your shoulders slowly 17 times.',
      duration: 45,
      xp: 45,
    });
    expect(getMissionData(84).duration).toBe(45);
    expect(getMissionData(84).xp).toBe(55);
  });

  it('rejects indexes that do not land on a mission', () => {
    expect(() => getMissionData(-1)).toThrow(TypeError);
    expect(() => getMissionData(1.5)).toThrow(TypeError);
    expect(() => getMissionData(Number.NaN)).toThrow(TypeError);
  });
});
