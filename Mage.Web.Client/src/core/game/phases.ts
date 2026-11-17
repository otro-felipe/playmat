import type { PhaseStep, SkipPrioritySteps } from '../../protocol/generated/views';

export type PhaseName = 'beginning' | 'main1' | 'combat' | 'main2' | 'ending';
export type CombatStepName = 'attackers' | 'blockers' | 'damage';
export type PhaseStop = keyof SkipPrioritySteps | 'attackers' | 'blockers';

export const PHASES: { name: PhaseName; stops: readonly PhaseStop[] }[] = [
  { name: 'beginning', stops: ['upkeep', 'draw'] },
  { name: 'main1', stops: ['main1'] },
  { name: 'combat', stops: ['beforeCombat'] },
  { name: 'main2', stops: ['main2'] },
  { name: 'ending', stops: ['endOfTurn'] },
];

export const COMBAT_STEPS: { name: CombatStepName; stop: PhaseStop }[] = [
  { name: 'attackers', stop: 'attackers' },
  { name: 'blockers', stop: 'blockers' },
  { name: 'damage', stop: 'endOfCombat' },
];

const STEPS: Record<PhaseStep, {
  phase: PhaseName;
  stop?: PhaseStop;
  combat?: CombatStepName;
  next: PhaseName | CombatStepName | 'draw' | 'turn';
}> = {
  UNTAP: { phase: 'beginning', next: 'draw' },
  UPKEEP: { phase: 'beginning', stop: 'upkeep', next: 'draw' },
  DRAW: { phase: 'beginning', stop: 'draw', next: 'main1' },
  PRECOMBAT_MAIN: { phase: 'main1', stop: 'main1', next: 'combat' },
  BEGIN_COMBAT: { phase: 'combat', stop: 'beforeCombat', next: 'attackers' },
  DECLARE_ATTACKERS: { phase: 'combat', stop: 'attackers', combat: 'attackers', next: 'blockers' },
  DECLARE_BLOCKERS: { phase: 'combat', stop: 'blockers', combat: 'blockers', next: 'damage' },
  FIRST_COMBAT_DAMAGE: { phase: 'combat', combat: 'damage', next: 'damage' },
  COMBAT_DAMAGE: { phase: 'combat', combat: 'damage', next: 'main2' },
  END_COMBAT: { phase: 'combat', stop: 'endOfCombat', combat: 'damage', next: 'main2' },
  POSTCOMBAT_MAIN: { phase: 'main2', stop: 'main2', next: 'ending' },
  END_TURN: { phase: 'ending', stop: 'endOfTurn', next: 'turn' },
  CLEANUP: { phase: 'ending', next: 'turn' },
};

export function phaseAt(step: PhaseStep | undefined) {
  return step ? STEPS[step] : undefined;
}
