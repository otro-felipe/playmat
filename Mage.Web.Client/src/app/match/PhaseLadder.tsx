import { ArrowRight, Flag, Layers, Sunrise, Swords } from 'lucide-react';
import { COMBAT_STEPS, PHASES, phaseAt, type PhaseStop } from '../../core/game/phases';
import type { PhaseStep } from '../../protocol/generated/views';
import { useT } from '../i18n';
import { useSettings } from '../stores/settings';
import styles from './PhaseLadder.module.css';

const ICONS = { beginning: Sunrise, main1: Layers, combat: Swords, main2: Layers, ending: Flag };

interface PhaseLadderProps {
  step?: PhaseStep;
  myTurn: boolean;
  turn: number;
  activeName?: string | null;
  priorityLabel?: string | null;
  stops?: readonly PhaseStop[];
  onToggleStop?(stops: readonly PhaseStop[]): void;
}

export function PhaseLadder({ step, myTurn, turn, activeName, priorityLabel, stops = [], onToggleStop }: PhaseLadderProps) {
  const t = useT();
  const settings = useSettings((state) => state.settings);
  const fullControl = useSettings((state) => state.fullControl);
  const side = myTurn ? 'yourTurn' : 'opponentTurn';
  const phase = phaseAt(step);
  const started = turn > 0 && !!phase;
  const description = !started ? t('match.turn.aria.starting') : activeName
    ? t('match.turn.aria.player', { turn, name: activeName })
    : t(myTurn ? 'match.turn.aria.yours' : 'match.turn.aria.theirs', { turn });

  function isSet(stop: PhaseStop) {
    return stop === 'attackers' || stop === 'blockers' ? settings.combatStops[side]?.[stop] : settings.stops[side]?.[stop];
  }

  function buttonState(keys: readonly PhaseStop[], current: boolean, label: string) {
    const marked = keys.some((stop) => stops.includes(stop));
    const persistent = keys.some(isSet);
    return {
      'aria-current': current ? 'step' as const : undefined,
      'aria-pressed': onToggleStop ? marked : undefined,
      'aria-label': label,
      'aria-description': persistent ? t('match.hud.persistent', { phase: label }) : undefined,
      'title': persistent ? t('match.hud.persistent', { phase: label }) : label,
      'data-stop': marked ? 'turn' : persistent || fullControl ? 'persistent' : undefined,
      'disabled': !onToggleStop || !started,
      'onClick': () => onToggleStop?.(keys),
    };
  }

  return (
    <nav className={styles.ladder} aria-label={description} aria-description={priorityLabel ?? undefined}>
      <strong className={styles.context}>{phase ? t(`match.phase.${phase.phase}`) : t('match.turn.starting')}</strong>
      <ol className={styles.rungs}>
        {PHASES.map(({ name, stops: keys }) => {
          const Icon = ICONS[name];
          const label = t(`match.phase.${name}`);
          return (
            <li key={name}>
              <button type="button" className={styles.rung} {...buttonState(keys, phase?.phase === name, label)}>
                <Icon aria-hidden="true" />
                {name === 'main1' && <small aria-hidden="true">I</small>}
                {name === 'main2' && <small aria-hidden="true">II</small>}
              </button>
            </li>
          );
        })}
      </ol>
      {phase?.phase === 'combat' && (
        <ol className={styles.substeps}>
          {COMBAT_STEPS.map(({ name, stop }, index) => {
            const label = t(`match.phase.${name}`);
            return (
              <li key={name}>
                {index > 0 && <ArrowRight aria-hidden="true" />}
                <button type="button" className={styles.substep} {...buttonState([stop], phase.combat === name, label)}>
                  {label}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </nav>
  );
}
