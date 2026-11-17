import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const RESPONSE_TIMEOUT_MS = 18_000;
const SEQUENCE_TIMEOUT_MS = 60_000;
const MAX_SEQUENCE_WALL_MS = 15 * 60_000;
const MAX_OUTCOMES = 256;

export class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function gameState(engine, gameId) {
  const state = engine.snapshot();
  if (gameId && state.gameId !== gameId) throw new ToolError('forbidden_game', 'Your seat does not control that game.');
  return state;
}

export function waitFor(engine, condition, timeoutMs, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const done = (error, value) => {
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve(value);
    };
    const cancel = () => done(signal.reason ?? new ToolError('cancelled', 'The wait was cancelled.'));
    const check = () => {
      const matched = condition(engine.snapshot());
      if (matched) done(null, matched);
    };
    const unsubscribe = engine.subscribe(check);
    const timer = setTimeout(() => done(null, null), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    check();
  });
}

export function reaches(state, target) {
  return (target.phase === undefined || state.phase === target.phase)
    && (target.step === undefined || state.step === target.step)
    && (target.priority === undefined || state.priority === target.priority)
    && (target.stackEmpty !== true || state.stack.length === 0);
}

function visibleDecision(state) {
  return state.decision?.kind === 'waiting' ? null : state.decision;
}

function stackIdentity(stack) {
  return JSON.stringify(stack.map(({ id, cardId, name, controllerId }) => [id, cardId, name, controllerId]));
}

function plannedChoice(state, decision, step) {
  if (step.choiceId) return decision.choices.find((choice) => choice.id === step.choiceId);
  const { cardName, cardId, label, zone } = step.select;
  // Battlefield is a public zone, not a controller filter. The current
  // engine choices still decide which objects may actually be selected.
  const cards = zone === 'hand' ? state.ownHand
    : state.players?.flatMap((player) => player.battlefield ?? []);
  const matches = decision.choices.filter((choice) => {
    if (zone && !cards?.some((card) => card.id === choice.card?.id)) return false;
    if (cardName !== undefined && choice.card?.name !== cardName) return false;
    if (cardId !== undefined && choice.card?.id !== cardId && choice.card?.cardId !== cardId) return false;
    return label === undefined || choice.label === label;
  });
  if (matches.length > 1) throw new ToolError('ambiguous_choice', 'Use the exact card ID when more than one choice matches.');
  return matches[0];
}

export class GameSeat {
  #outcomes = new Map();
  #sequences = new Map();
  #current = null;
  #inFlight = false;
  #uncertain = null;

  constructor(engine, { sequenceTimeoutMs = SEQUENCE_TIMEOUT_MS, maxSequenceWallMs = MAX_SEQUENCE_WALL_MS } = {}) {
    this.engine = engine;
    this.sequenceTimeoutMs = sequenceTimeoutMs;
    this.maxSequenceWallMs = maxSequenceWallMs;
  }

  snapshot(gameId) { return gameState(this.engine, gameId); }

  async wait(args, signal, predicate) {
    const initial = this.snapshot(args.gameId);
    const gameId = args.gameId ?? initial.gameId;
    const epoch = initial.epoch;
    const result = await waitFor(this.engine, (state) => {
      if (state.status === 'disconnected') return { event: 'disconnected' };
      if (gameId && state.gameId !== gameId) return { event: 'invalidated', state };
      if (['game_over', 'sideboarding', 'match_over'].includes(state.status)) return { event: state.status, state };
      if (state.epoch !== epoch) return { event: 'invalidated', state };
      if (args.afterCursor !== undefined && state.cursor <= args.afterCursor) return null;
      const decision = visibleDecision(state);
      if (predicate ? reaches(state, predicate) : decision && decision.id !== args.afterDecisionId) {
        return { event: predicate ? 'reached' : 'decision', state };
      }
      return null;
    }, args.timeoutMs ?? RESPONSE_TIMEOUT_MS, signal);
    return result ?? { event: 'timeout', cursor: this.snapshot().cursor };
  }

  async submit(args, sequenceId) {
    const { gameId, decisionId, choiceId, idempotencyKey, cursor, value } = args;
    const fingerprint = JSON.stringify([gameId, decisionId, choiceId, value]);
    const known = this.#outcomes.get(idempotencyKey);
    if (known) {
      if (known.fingerprint !== fingerprint) throw new ToolError('key_conflict', 'That idempotency key belongs to a different choice.');
      return known.outcome;
    }
    const state = this.snapshot(gameId);
    if (this.#current && this.#current.id !== sequenceId) throw new ToolError('sequence_running', 'Cancel the running sequence before making another decision.');
    if (state.status !== 'active' && state.status !== 'sideboarding') throw new ToolError('not_actionable', 'Your game is waiting for another event.');
    if (state.decision?.id !== decisionId || (cursor !== undefined && state.cursor !== cursor)) {
      throw new ToolError('stale_decision', 'Read a fresh decision before responding.');
    }
    if (!state.decision.choices.some((choice) => choice.id === choiceId)) throw new ToolError('illegal_choice', 'Choose one of the choices in the current decision.');
    if (this.#uncertain === decisionId) throw new ToolError('uncertain_ack', 'The engine acknowledgement was lost. Request a fresh state.');
    if (this.#inFlight) throw new ToolError('decision_in_flight', 'Another decision is already being applied.');
    this.#inFlight = true;
    const outcome = (async () => {
      try {
        return await this.engine.respond(decisionId, choiceId, value);
      } catch (error) {
        if (error.code !== 'illegal_choice') this.#uncertain = decisionId;
        throw error;
      } finally {
        this.#inFlight = false;
      }
    })();
    this.#outcomes.set(idempotencyKey, { fingerprint, outcome });
    if (this.#outcomes.size > MAX_OUTCOMES) this.#outcomes.delete(this.#outcomes.keys().next().value);
    return outcome;
  }

  startSequence({ gameId, cursor, steps }, authorize, responsePolicy = 'interrupt') {
    const initial = this.snapshot(gameId);
    if (initial.cursor !== cursor || initial.status !== 'active') throw new ToolError('stale_decision', 'Plan from the latest game state.');
    if (this.#current || this.#inFlight) throw new ToolError('sequence_running', 'Finish or cancel the current decision or sequence first.');
    const sequence = {
      id: randomUUID(), gameId, status: 'running', reason: null, completedSteps: 0, appliedDecisions: 0, cursor,
      controller: new AbortController(),
    };
    this.#current = sequence;
    this.#sequences.set(sequence.id, sequence);
    if (this.#sequences.size > 40) this.#sequences.delete(this.#sequences.keys().next().value);
    void this.#runSequence(sequence, initial, steps, authorize, responsePolicy);
    return this.sequenceStatus({ gameId, sequenceId: sequence.id });
  }

  sequenceStatus({ gameId, sequenceId }) {
    const sequence = this.#sequences.get(sequenceId);
    if (!sequence || sequence.gameId !== gameId) throw new ToolError('unknown_sequence', 'This seat does not have that sequence.');
    const { controller, id, ...status } = sequence;
    return { sequenceId: id, ...status };
  }

  cancelSequence(args) {
    this.sequenceStatus(args);
    const sequence = this.#sequences.get(args.sequenceId);
    if (sequence.status === 'running') sequence.controller.abort(new ToolError('cancelled', 'Cancelled by the agent.'));
    return this.sequenceStatus(args);
  }

  invalidate(reason = 'invalidated') {
    this.#current?.controller.abort(new ToolError(reason, 'The active game changed.'));
  }

  async #runSequence(sequence, initial, steps, authorize, responsePolicy) {
    const { signal } = sequence.controller;
    const wallDeadline = Date.now() + this.maxSequenceWallMs;
    let deadline = Date.now() + this.sequenceTimeoutMs;
    let suspendedAt = null;
    const opponentWaiting = (state) => state.priority === 'opponent' && !visibleDecision(state);
    const accountTime = (state) => {
      const now = Date.now();
      if (suspendedAt !== null) deadline = Math.min(wallDeadline, deadline + now - suspendedAt);
      suspendedAt = opponentWaiting(state) ? now : null;
      sequence.waitingFor = suspendedAt !== null ? 'opponent' : null;
    };
    accountTime(initial);
    const opponentState = (state) => {
      const opponents = (state.players ?? []).filter((player) => !player.yourSeat);
      const opponentIds = new Set(opponents.map((player) => player.id));
      const opponentObjects = new Set(opponents.flatMap((player) => player.battlefield ?? []).map((card) => card.id));
      const ownObjects = new Set((state.players ?? []).filter((player) => player.yourSeat)
        .flatMap((player) => player.battlefield ?? []).map((card) => card.id));
      // Face-down projections omit controllerId. Their public battlefield object
      // IDs still establish ownership; unknown combat objects stop conservatively.
      const opposingCombatCard = (card) => opponentIds.has(card.controllerId) || opponentObjects.has(card.id)
        || (!card.controllerId && !ownObjects.has(card.id));
      return JSON.stringify({
        players: opponents.map(({ id, life, handCount, libraryCount, battlefield, graveyard, exile }) =>
          ({ id, life, handCount, libraryCount, battlefield, graveyard, exile })),
        combat: (state.combat ?? []).flatMap((group, index) => {
          const attackers = (group.attackers ?? []).filter(opposingCombatCard);
          const blockers = (group.blockers ?? []).filter(opposingCombatCard);
          return attackers.length || blockers.length
            ? [{ index, attackerIds: (group.attackers ?? []).map((card) => card.id), attackers, blockers }] : [];
        }),
      });
    };
    const expectedOpponentState = opponentState(initial);
    const turn = initial.turn;
    let previousDecisionId = null;
    let passCount = 0;
    let expectedStackCards = initial.stack;
    let expectedStack = stackIdentity(initial.stack);
    const plannedStackIds = new Set();
    const initiallyKnownCards = new Set([
      ...(initial.ownHand ?? []), ...initial.stack,
      ...(initial.players ?? []).flatMap((player) => [
        ...(player.battlefield ?? []), ...(player.exile ?? []), ...(player.graveyard ?? []),
      ]),
    ].map((card) => card.cardId ?? card.id));
    let allowPlannedResolutions = false;
    let pendingCast = null;
    const checkStack = (state) => {
      if (responsePolicy === 'ignore') return;
      // Without actor-tagged engine events, conservatively hand control back for
      // any public opponent-state mutation, even one caused by our own effect.
      if (opponentState(state) !== expectedOpponentState) {
        throw new ToolError('opponent_state_changed', 'Public opponent state changed; inspect before continuing.');
      }
      if (allowPlannedResolutions) {
        const own = state.players?.find((player) => player.yourSeat);
        if ([...(state.ownHand ?? []), ...(own?.exile ?? [])].some((card) =>
          !initiallyKnownCards.has(card.cardId ?? card.id))) {
          throw new ToolError('new_information', 'A new hand or exile card needs a fresh plan.');
        }
      }
      const currentStack = stackIdentity(state.stack);
      if (currentStack === expectedStack) return;
      if (pendingCast) {
        const item = state.stack.find((card) =>
          card.cardId === pendingCast.cardId && card.controllerId === pendingCast.playerId
          && card.name === pendingCast.name && card.id !== card.cardId);
        if (item && stackIdentity(state.stack.filter((card) => card !== item)) === expectedStack) {
          expectedStack = currentStack;
          expectedStackCards = state.stack;
          plannedStackIds.add(item.id);
          pendingCast = null;
          return;
        }
      }
      if (allowPlannedResolutions) {
        const remaining = new Set(state.stack.map((card) => card.id));
        const removed = expectedStackCards.filter((card) => !remaining.has(card.id));
        // Only removal of this sequence's exact spells is expected. New spells,
        // abilities/triggers, controller changes and reordered stacks interrupt.
        if (removed.length && removed.every((card) => plannedStackIds.has(card.id))
          && stackIdentity(expectedStackCards.filter((card) => remaining.has(card.id))) === currentStack) {
          expectedStack = currentStack;
          expectedStackCards = state.stack;
          for (const card of removed) plannedStackIds.delete(card.id);
          return;
        }
      }
      throw new ToolError('state_changed', 'The stack changed outside the sequence.');
    };
    const checkGame = (state) => {
      accountTime(state);
      if (state.gameId !== sequence.gameId || state.status !== 'active' || state.epoch !== initial.epoch) {
        throw new ToolError('invalidated', 'The game state changed.');
      }
      if (state.turn !== turn || state.activePlayer !== initial.activePlayer) {
        throw new ToolError('turn_changed', 'The observed turn ended. Read the current state and plan again before passing.');
      }
    };
    const unwatch = this.engine.subscribe(() => {
      try {
        const state = this.snapshot();
        checkGame(state);
        checkStack(state);
      } catch (error) {
        sequence.controller.abort(error);
      }
    });
    const stateForStep = async () => {
      signal.throwIfAborted();
      accountTime(this.snapshot());
      if (Date.now() >= wallDeadline || (!opponentWaiting(this.snapshot()) && Date.now() >= deadline)) {
        throw new ToolError('timeout', 'The sequence ran out of active time or reached its maximum waiting lifetime.');
      }
      if (!await authorize()) throw new ToolError('authorization_expired', 'The seat authorization expired.');
      signal.throwIfAborted();
      const state = this.snapshot();
      checkGame(state);
      checkStack(state);
      return state;
    };
    const observable = (state) => {
      const decision = visibleDecision(state);
      if (decision && decision.id !== previousDecisionId) return state;
      return null;
    };
    const waitForState = async (condition) => {
      for (;;) {
        const state = await stateForStep();
        const matched = condition(state);
        if (matched) return matched;
        const waiting = opponentWaiting(state);
        const observed = await waitFor(this.engine, (updated) =>
          condition(updated) || (opponentWaiting(updated) !== waiting ? updated : null),
        Math.max(1, (waiting ? wallDeadline : Math.min(deadline, wallDeadline)) - Date.now()), signal);
        if (!observed) return null;
      }
    };
    const waitForNext = () => waitForState(observable);
    try {
      for (const step of steps) {
        allowPlannedResolutions = step.allowPlannedResolutions === true;
        let state = await stateForStep();
        if (step.kind === 'hold') {
          if (!visibleDecision(state) || state.decision.id === previousDecisionId) throw new ToolError('not_actionable', 'A hold requires a current decision.');
          const id = state.decision.id;
          const effective = Math.min(step.delayMs, maxHold(state), Math.max(0, deadline - Date.now()));
          await sleep(effective, undefined, { signal });
          state = await stateForStep();
          if (state.decision?.id !== id) throw new ToolError('state_changed', 'The current decision changed while holding.');
          sequence.effectiveDelayMs = effective;
        } else if (step.kind === 'answer') {
          while (!visibleDecision(state) || state.decision.id === previousDecisionId) {
            if (!await waitForNext()) throw new ToolError('timeout', 'The expected decision did not arrive.');
            state = await stateForStep();
          }
          const decision = state.decision;
          if (pendingCast || state.turn !== turn || (step.decisionId ? decision.id !== step.decisionId :
            !step.guard || step.guard.kind !== decision.kind || !reaches(state, step.guard))) {
            throw new ToolError('state_changed', 'The expected guarded decision changed.');
          }
          const choice = plannedChoice(state, decision, step);
          if (!choice) throw new ToolError('illegal_choice', 'The planned choice is unavailable in the current decision.');
          if (step.expectCast) {
            // The engine's visible legal choice can cast from exile/graveyard too
            // (for example Wrenn's Resolve or flashback). Never infer permission
            // from the zone alone, or treat a battlefield activation as a cast.
            const castableZones = [
              ...(state.ownHand ?? []),
              ...(state.players ?? []).flatMap((player) => [...(player.exile ?? []), ...(player.graveyard ?? [])]),
            ];
            const card = castableZones.find((entry) => entry.id === choice.card?.id);
            const playerId = state.players?.find((player) => player.yourSeat)?.id;
            if (decision.kind !== 'priority' || !card?.cardId || !playerId || card.faceDown || !Array.isArray(card.types) || card.types.includes('LAND')) {
              throw new ToolError('bad_cast_expectation', 'Expect a cast only for a visible legal spell from hand, exile or graveyard during priority; not a mode, target or activated ability.');
            }
            pendingCast = { cardId: card.cardId, name: card.name, playerId };
          }
          await this.submit({
            gameId: sequence.gameId, cursor: state.cursor, decisionId: decision.id, choiceId: choice.id,
            idempotencyKey: `${sequence.id}:${sequence.completedSteps}`, value: step.value,
          }, sequence.id);
          sequence.appliedDecisions++;
          previousDecisionId = decision.id;
        } else if (step.kind === 'yield_priority') {
          // A yield is one deliberate pass, never an unbounded auto-pass policy.
          while (!visibleDecision(state) || state.decision.id === previousDecisionId) {
            if (!await waitForNext()) throw new ToolError('timeout', 'The priority decision did not arrive.');
            state = await stateForStep();
          }
          const decision = state.decision;
          const choice = decision.choices.find((item) => item.type === 'pass');
          if (decision.kind !== 'priority' || state.priority !== 'self' || !choice || pendingCast || state.stop) {
            throw new ToolError('response_available', 'Yield requires your ordinary priority decision.');
          }
          await this.submit({ gameId: sequence.gameId, cursor: state.cursor, decisionId: decision.id,
            choiceId: choice.id, idempotencyKey: `${sequence.id}:yield:${sequence.completedSteps}` }, sequence.id);
          sequence.appliedDecisions++;
          previousDecisionId = decision.id;
          const destination = step.until ?? 'self';
          const observed = await waitForState((updated) => {
            const next = visibleDecision(updated);
            // Resolution prompts belong to this seat even when the priority
            // display still names the opponent (or nobody). Never wait them out.
            if (next && next.id !== decision.id && next.kind !== 'priority') return updated;
            if (destination === 'opponent') return updated.priority === 'opponent' ? updated : null;
            return updated.priority === 'self' && next && next.id !== decision.id ? updated : null;
          });
          if (!observed) throw new ToolError('timeout', 'Priority did not return before the sequence deadline.');
          if (visibleDecision(observed) && observed.decision.id !== decision.id && observed.decision.kind !== 'priority') {
            throw new ToolError('response_available', 'A mandatory prompt needs a fresh decision.');
          }
          await stateForStep();
        } else if (step.kind === 'pass_until') {
          for (;;) {
            state = await stateForStep();
            if (reaches(state, step)) break;
            if (!visibleDecision(state) || state.decision.id === previousDecisionId) {
              const observed = await waitForState((updated) => reaches(updated, step) ? updated : observable(updated));
              if (!observed) throw new ToolError('timeout', 'The destination did not arrive.');
              continue;
            }
            const choice = state.decision.choices.find((item) => item.type === 'pass');
            if (!choice || state.decision.kind !== 'priority' || pendingCast || state.stop
              || (!step.skipOptionalResponses && state.decision.choices.some((item) => item.type !== 'pass' && item.type !== 'manaAbility'))) {
              throw new ToolError('response_available', 'A new response or mandatory prompt needs a decision.');
            }
            if (++passCount > 30) throw new ToolError('pass_limit', 'The sequence reached its priority window limit.');
            await this.submit({
              gameId: sequence.gameId, cursor: state.cursor, decisionId: state.decision.id, choiceId: choice.id,
              idempotencyKey: `${sequence.id}:pass:${passCount}`,
            }, sequence.id);
            sequence.appliedDecisions++;
            previousDecisionId = state.decision.id;
          }
        }
        sequence.completedSteps++;
        sequence.cursor = this.snapshot().cursor;
      }
      sequence.status = 'completed';
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error;
      sequence.status = reason?.code === 'cancelled' ? 'cancelled' : 'interrupted';
      sequence.reason = reason?.code ?? 'action_failed';
      sequence.cursor = this.snapshot().cursor;
    } finally {
      unwatch();
      if (this.#current === sequence) this.#current = null;
    }
  }
}

function maxHold(state) {
  // Leave one full second for an action when the server advertises a running priority clock.
  if (state.secondsRemaining === undefined || state.secondsRemaining === null) return 10_000;
  return Math.min(10_000, Math.max(0, state.secondsRemaining * 1000 - 1000));
}
