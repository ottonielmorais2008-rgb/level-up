export interface MissionData {
  title: string;
  instruction: string;
  duration: number;
  xp: number;
}

const BASE_MISSIONS: readonly MissionData[] = [
  { title: 'Interrupt', instruction: 'Put your phone face down for {dur} seconds.', duration: 10, xp: 10 },
  { title: 'Snap Out', instruction: 'Clap your hands {count} and sit up straight.', duration: 5, xp: 10 },
  { title: 'Eye Reset', instruction: 'Look away from the screen for {dur} seconds.', duration: 15, xp: 10 },
  { title: 'Still Mode', instruction: 'Stay completely still for {dur} seconds.', duration: 10, xp: 15 },
  { title: 'Micro Move', instruction: 'Stand up and take {count} steps.', duration: 10, xp: 15 },
  { title: 'Shoulder Reset', instruction: 'Roll your shoulders slowly {count} times.', duration: 15, xp: 15 },
  { title: 'Breath Lock', instruction: 'Take one deep breath and hold for {dur} seconds.', duration: 10, xp: 20 },
  { title: 'Hand Control', instruction: 'Open and close your hands slowly {count} times.', duration: 15, xp: 20 },
  { title: 'One Thought', instruction: 'Think of one thing you need to do next.', duration: 10, xp: 20 },
  { title: 'Name It', instruction: 'Say out loud what you were just doing.', duration: 10, xp: 20 },
  { title: 'Decision Snap', instruction: 'Decide one small action and commit to it.', duration: 10, xp: 25 },
  { title: 'Focus Lock', instruction: 'Focus on one object for {dur} seconds.', duration: 15, xp: 25 },
];

const CYCLE_LENGTH = BASE_MISSIONS.length;
const CYCLE_STEPS = [1, 5, 7, 11] as const;
const MAX_DURATION_SECONDS = 45;

/** XP awarded for a mission. The first three indexes are fixed; later cycles add 5 XP per cycle. */
export function missionXp(index: number, baseXp: number, cycle: number): number {
  if (index === 0) return 100;
  if (index === 1) return 80;
  if (index === 2) return 60;
  return baseXp + cycle * 5;
}

/** Timer length in seconds. The opening mission is 5s; every later mission caps at 45s. */
export function missionDuration(index: number, baseDuration: number, cycle: number): number {
  if (index === 0) return 5;
  return Math.min(baseDuration + cycle * 5, MAX_DURATION_SECONDS);
}

export function getMissionData(index: number): MissionData {
  const cycle = Math.floor(index / CYCLE_LENGTH);
  const step = CYCLE_STEPS[cycle % CYCLE_STEPS.length];
  const offset = cycle % CYCLE_LENGTH;
  const positionInCycle = index % CYCLE_LENGTH;
  const mappedIndex = (positionInCycle * step + offset) % CYCLE_LENGTH;
  const base = BASE_MISSIONS[mappedIndex];

  const duration = missionDuration(index, base.duration, cycle);
  const countAdd = cycle;

  const instruction = base.instruction
    .replace('{dur}', duration.toString())
    .replace('{count}', () => {
      if (base.title === 'Snap Out') return (1 + countAdd) === 1 ? 'once' : (1 + countAdd) + ' times';
      if (base.title === 'Micro Move') return (3 + countAdd * 2).toString();
      if (base.title === 'Shoulder Reset') return (5 + countAdd * 2).toString();
      if (base.title === 'Hand Control') return (10 + countAdd * 5).toString();
      return '';
    });

  return {
    title: base.title,
    instruction,
    duration,
    xp: missionXp(index, base.xp, cycle),
  };
}
