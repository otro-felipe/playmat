import { useEffect } from 'react';
import { autoAnswer, type AutoAnswer } from '../../core/game/autoPass';
import type { Command } from '../../core/game/interaction';
import type { GameSession, GameSessionState } from '../../core/game/gameSession';
import { phaseAt, type PhaseStop } from '../../core/game/phases';
import { useSettings } from '../stores/settings';
import { ACTION_BEAT_MS } from '../../core/game/actionPresentation';

/** Long enough to see what changed on the board, short enough not to feel like waiting. */
const BEAT_MS = 280;
/** Passing the turn: quick, but each step still reads on the phase ladder as it goes by. */
const PASS_TURN_BEAT_MS = 120;

function stackIdentity(state: GameSessionState): string {
  return Object.entries(state.view?.stack ?? {}).map(([id, card]) => `${id}:${(card.targets ?? []).join(',')}`).join('|');
}

const COMMANDS: Record<AutoAnswer, Command> = {
  pass: { type: 'boolean', value: false },
  // confirming the declaration with nothing chosen
  noAttacks: { type: 'boolean', value: true },
  noBlocks: { type: 'boolean', value: true },
};

/**
 * Answers for the player when they have nothing to decide (see core/game/autoPass): passing priority with nothing
 * to play, declaring no attacks or blocks when nothing can. Holding priority turns it off. Returns what it is about
 * to answer, so the decision corner can say so. passTurn (Arena's ">>") passes everything this turn, holding or not.
 */
export function useAutoPass(session: GameSession, state: GameSessionState, enabled: boolean, passTurn = false, turnStops: readonly PhaseStop[] = []): AutoAnswer | null {
  const autoPass = useSettings((store) => store.settings.autoPass);
  const autoSkipCombat = useSettings((store) => store.settings.autoSkipCombat);
  const abilitiesOnTheirTurn = useSettings((store) => store.settings.abilitiesOnTheirTurn);
  const combatStops = useSettings((store) => store.settings.combatStops);
  const stops = useSettings((store) => store.settings.stops);
  const fullControl = useSettings((store) => store.fullControl);
  const myTurn = !!state.view?.myPlayerId && state.view?.activePlayerId === state.view.myPlayerId;
  const stepStop = phaseAt(state.view?.step)?.stop;
  // Persistent phase stops are requested from XMage. Honor them here too when it sends a priority prompt.
  const stopHere = !!stepStop && (turnStops.includes(stepStop)
    || (stepStop !== 'attackers' && stepStop !== 'blockers' && !!stops[myTurn ? 'yourTurn' : 'opponentTurn']?.[stepStop]));
  const answer = (enabled || passTurn) && state.mode === 'play' && !state.awaitingServer && !state.gameOver && !state.resyncing && !state.stalled
    && (passTurn || state.prompt?.kind !== 'priority' || !stopHere)
    ? autoAnswer(state.view, state.prompt, { autoPass, autoSkipCombat, abilitiesOnTheirTurn, fullControl, passTurn, combatStops, beginCombatStop: !!stops.yourTurn?.beforeCombat })
    : null;

  const stackKey = stackIdentity(state);
  const delay = stackKey ? ACTION_BEAT_MS : passTurn ? PASS_TURN_BEAT_MS : BEAT_MS;
  useEffect(() => {
    if (!answer) return;
    const timer = setTimeout(() => {
      // A new server event can arrive before React commits the effect cleanup. Never answer that newer decision.
      const now = session.getState();
      if (now.prompt !== state.prompt || now.awaitingServer || now.resyncing || now.stalled || now.gameOver || stackIdentity(now) !== stackKey) return;
      const latest = useSettings.getState();
      if (autoAnswer(now.view, now.prompt, {
        ...latest.settings, fullControl: latest.fullControl, passTurn,
        beginCombatStop: !!latest.settings.stops.yourTurn?.beforeCombat,
      }) !== answer) return;
      void session.respond(COMMANDS[answer]).catch(() => undefined);
    }, delay);
    return () => clearTimeout(timer);
  }, [answer, delay, passTurn, session, state.prompt, stackKey]);

  return answer;
}
