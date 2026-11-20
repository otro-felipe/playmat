import { APP_NAME } from '../brand';
import { commandForAgentChoice, describeAgentDecision, projectedChoices, visibleAgentGame } from '../../core/game/agentChoices';
import type { GameSession, GameSessionState } from '../../core/game/gameSession';
import { NO_INPUT, useSiteTool } from '../webmcp';

const GET_MATCH_STATE = {
  name: 'get_match_state',
  description: `Read the board, your own hand and available engine choices from your seat in this ${APP_NAME} tab.`,
  inputSchema: NO_INPUT,
  annotations: { readOnlyHint: true, untrustedContentHint: true },
};

const DEFAULT_WAIT_MS = 15_000;
const MIN_WAIT_MS = 100;
const MAX_WAIT_MS = 20_000;

const WAIT_FOR_DECISION = {
  name: 'wait_for_decision',
  description: 'Wait for a decision at this seat or for the game to end. Pass the last decision ID to wait for a different decision.',
  inputSchema: {
    type: 'object',
    properties: {
      afterDecisionId: { type: 'string', description: 'A previously observed decision ID.' },
      timeoutMs: {
        type: 'integer', description: 'Maximum wait in milliseconds. Defaults to 15000.',
        minimum: MIN_WAIT_MS, maximum: MAX_WAIT_MS,
      },
    },
    additionalProperties: false,
  } as const,
  annotations: { readOnlyHint: true, untrustedContentHint: true },
};

const SUBMIT_CHOICE = {
  name: 'submit_choice',
  description: 'Submit one current engine choice for your seat, using its decision and choice IDs.',
  inputSchema: {
    type: 'object',
    properties: {
      decisionId: { type: 'string', description: 'The current decision ID.' },
      choiceId: { type: 'string', description: 'An offered choice ID.' },
      value: {
        description: 'Only for a numeric choice. Respect the bounds shown with the decision.',
        anyOf: [
          { type: 'integer', description: 'An integer for a single amount.' },
          { type: 'array', description: 'One integer per amount in the given order.', items: { type: 'integer' } },
        ],
      },
    },
    required: ['decisionId', 'choiceId'],
    additionalProperties: false,
  } as const,
};

const promptIds = new WeakMap<NonNullable<GameSessionState['prompt']>, { id: string; signature: string }>();
const unavailable = { error: 'This browser seat is no longer available.' };

function isPlayingSeat(state: GameSessionState): boolean {
  return state.mode === 'play' && !!state.playerId && (!state.view?.myPlayerId || state.view.myPlayerId === state.playerId);
}

function currentDecision(state: GameSessionState) {
  if (!state.prompt || state.gameOver || state.conceding) return null;
  const decision = projectedChoices(state, '');
  if (!decision?.choices.length) return null;

  // A board update can replace the choices before the next prompt object arrives.
  const signature = JSON.stringify(decision.choices.map(({ id, label, command }) => [id, label, command]));
  let stamp = promptIds.get(state.prompt);
  if (!stamp || stamp.signature !== signature) {
    stamp = { id: crypto.randomUUID(), signature };
    promptIds.set(state.prompt, stamp);
  }
  return { ...decision, id: stamp.id };
}

function matchState(state: GameSessionState, decision: ReturnType<typeof currentDecision>) {
  return {
    gameId: state.gameId,
    gameOver: !!state.gameOver,
    resyncing: state.resyncing,
    ...visibleAgentGame(state),
    decision: describeAgentDecision(decision),
  };
}

type DecisionEvent =
  | { event: 'decision'; state: ReturnType<typeof matchState> }
  | { event: 'game_over' | 'timeout' | 'unavailable' };

function waitForDecision(
  session: GameSession,
  canAccess: () => boolean,
  afterDecisionId: string | undefined,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<DecisionEvent> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let finished = false;
    let scheduled = false;

    function cleanup() {
      finished = true;
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener('abort', cancel);
    }

    function complete(event: DecisionEvent) {
      cleanup();
      resolve(event);
    }

    function cancel() {
      cleanup();
      reject(signal.reason);
    }

    function check() {
      scheduled = false;
      if (finished) return;
      if (!canAccess()) {
        complete({ event: 'unavailable' });
        return;
      }
      const state = session.getState();
      if (state.gameOver) {
        complete({ event: 'game_over' });
        return;
      }
      const decision = currentDecision(state);
      if (decision && decision.id !== afterDecisionId) {
        complete({ event: 'decision', state: matchState(state, decision) });
      }
    }

    // The engine may publish the view, prompt and derived interaction in successive writes.
    const unsubscribe = session.store.subscribe(() => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(check);
    });
    const timer = setTimeout(() => complete({ event: 'timeout' }), timeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    check();
  });
}

export function useMatchSiteTools(
  session: GameSession,
  enabled: boolean,
  scope?: { key: string; isCurrent(): boolean },
) {
  const registered = enabled && isPlayingSeat(session.getState());
  const canAccess = () => enabled && (scope?.isCurrent() ?? true) && isPlayingSeat(session.getState());

  useSiteTool(registered, GET_MATCH_STATE, () => {
    if (!canAccess()) return unavailable;
    const state = session.getState();
    return matchState(state, currentDecision(state));
  }, scope?.key);

  useSiteTool(registered, WAIT_FOR_DECISION, ({ afterDecisionId, timeoutMs = DEFAULT_WAIT_MS }, signal) => {
    if (!canAccess()) return unavailable;
    if (afterDecisionId !== undefined && typeof afterDecisionId !== 'string') {
      return { error: 'afterDecisionId must be a decision ID string.' };
    }
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < MIN_WAIT_MS || timeoutMs > MAX_WAIT_MS) {
      return { error: `timeoutMs must be an integer between ${MIN_WAIT_MS} and ${MAX_WAIT_MS}.` };
    }
    return waitForDecision(session, canAccess, afterDecisionId, timeoutMs, signal);
  }, scope?.key);

  useSiteTool(registered, SUBMIT_CHOICE, async ({ decisionId, choiceId, value }, signal) => {
    if (!canAccess()) return unavailable;
    const decision = currentDecision(session.getState());
    if (!decision || decision.id !== decisionId) return { error: 'The decision changed. Read the match state again.' };
    const choice = decision.choices.find(({ id }) => id === choiceId);
    if (!choice) return { error: 'That choice is not available in this decision.' };
    const command = commandForAgentChoice(choice, decision, value);
    if (!command) return { error: 'Supply an amount within the given bounds.' };
    signal.throwIfAborted();
    try {
      await session.respond(command);
      return { submitted: true };
    } catch {
      return { error: 'The server did not accept the choice. Read the match state again.' };
    }
  }, scope?.key);
}
