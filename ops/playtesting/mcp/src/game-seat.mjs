import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { PlannedPermanentCombat } from './planned-combat.mjs';

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
  return JSON.stringify(stack.map(({ id, cardId, name, controllerId, abilityType, sourceId, abilityText }) =>
    [id, cardId, name, controllerId, abilityType, sourceId, abilityText]));
}

// Preflight only the selected spell's effect text. A permanent can have unrelated draw abilities.
function needsEffectReevaluation(text) {
  return /\b(?:scry|surveil|cascade|discover|mill)\b|\bdraw(?:s)?\b[^.]*\bcards?\b|\b(?:look at|reveal|reveals)\b|\bexile\b[^.]*\btop\b|\bsearch\b[^.]*\blibrar(?:y|ies)\b|\bat random\b|\bflip\b[^.]*\bcoins?\b|\broll\b[^.]*\b(?:die|dice|d\d+)\b|\b(?:opponent|target player|each player|that player)\b[^.]*\b(?:choose|chooses|sacrifice|sacrifices|discard|discards)\b/i.test(text);
}

function needsSpellReevaluation(card) {
  if (!card?.types?.some((type) => type === 'INSTANT' || type === 'SORCERY')) return false;
  return (card.rules ?? []).some(needsEffectReevaluation);
}

function triggeredEffect(text) {
  const condition = /^(?:Whenever|When|At)\b[^,.]*,\s*/i;
  return text.replace(condition, '');
}

function needsStackReevaluation(card) {
  if (!card?.abilityType) return needsSpellReevaluation(card);
  const text = card.abilityText ?? '';
  return needsEffectReevaluation(card.abilityType.startsWith('TRIGGERED') ? triggeredEffect(text) : text);
}

function declaredInformation(step, state) {
  return !!(step.reevaluateAfter || step.expectCast && needsSpellReevaluation(planCard(state, step))
    || step.expectAbility && needsEffectReevaluation(step.expectAbility.abilityText)
    || step.expectTriggers?.some((trigger) => needsEffectReevaluation(triggeredEffect(trigger.abilityText))));
}

function resumesObservedCast(state, actions, ownId, expectedStackIds) {
  const [spell] = state.stack;
  const decision = visibleDecision(state);
  const evidence = state.sequenceEvidence;
  if (!ownId || !spell || spell.controllerId !== ownId || spell.unpaid !== true || spell.abilityType || !needsSpellReevaluation(spell)
    || (expectedStackIds && !expectedStackIds.includes(spell.id)) || !evidence?.resolutions
    || !Number.isSafeInteger(evidence.resolutionRevision) || Object.hasOwn(evidence.resolutions, spell.id)
    || decision?.informationBoundary || !['target', 'payMana'].includes(decision?.kind)) return false;
  const [first] = actions;
  return actions.length > 1 && actions.every((action) => !declaredInformation(action, state)
    && action.kind === 'choose' && ['target', 'payMana'].includes(action.guard?.kind) && guardedCostChoice(action))
    && first.guard.kind === decision.kind && reaches(state, first.guard)
    && (decision.kind === 'payMana' && first.guard.instruction === undefined || first.guard.instruction === decision.instruction)
    && !!plannedChoice(state, decision, first);
}

function guardedCostChoice(step) {
  if (!['answer', 'choose'].includes(step.kind) || !step.guard) return false;
  if (step.guard.kind === 'payMana') return true;
  const typedPicker = step.guard.kind === 'panel' && (step.expectAbility || step.expectCast)
    && (step.choiceId || step.select?.label);
  return (typedPicker || ['target', 'question', 'chooseAbility', 'choice', 'chooseChoice', 'amount', 'amounts', 'multiAmount'].includes(step.guard.kind))
    && typeof step.guard.instruction === 'string'
    && !/\b(?:scry|surveil|library)\b|Choose which (?:flip|die roll)|Re-roll\b/i.test(step.guard.instruction);
}

function visibleCastSource(state, objectId) {
  const zones = [...(state.ownHand ?? []),
    ...(state.players ?? []).flatMap((player) => [...(player.exile ?? []), ...(player.graveyard ?? [])])];
  return objectId && zones.find((card) => card.id === objectId && card.cardId && !card.faceDown);
}

function planCard(state, step) {
  if (step.choiceId) return state.decision?.choices.find((choice) => choice.id === step.choiceId)?.card;
  const cards = [...(state.ownHand ?? []), ...(state.players ?? []).filter((player) => player.yourSeat).flatMap((player) => [...(player.battlefield ?? []), ...(player.graveyard ?? []), ...(player.exile ?? [])])];
  return cards.find((card) => step.select?.cardId && [card.id, card.cardId].includes(step.select.cardId)
    || step.select?.objectId && step.select.objectId === card.id || step.select?.cardName && step.select.cardName === card.name);
}

function plannedChoice(state, decision, step) {
  if (step.intent) return decision.choices.find((choice) => choice.intent === step.intent);
  if (step.choiceId) return decision.choices.find((choice) => choice.id === step.choiceId);
  const { cardName, cardId, objectId, label, zone } = step.select;
  // Battlefield is a public zone, not a controller filter. The current
  // engine choices still decide which objects may actually be selected.
  const cards = zone === 'hand' ? state.ownHand
    : state.players?.flatMap((player) => player.battlefield ?? []);
  const matches = decision.choices.filter((choice) => {
    if (step.playAs === 'land' && choice.canPlayLand !== true) return false;
    if (zone && !cards?.some((card) => card.id === choice.card?.id)) return false;
    if (cardName !== undefined && choice.card?.name !== cardName) return false;
    if (cardId !== undefined && choice.card?.id !== cardId && choice.card?.cardId !== cardId) return false;
    if (objectId !== undefined && choice.objectId !== objectId && choice.card?.id !== objectId
      && !(decision.triggerOrder && choice.triggerSourceId === objectId)) return false;
    return label === undefined || choice.label === label;
  });
  if (matches.length > 1) throw new ToolError('ambiguous_choice', 'Several legal choices match. Use the current decisionId and the matching choiceId, or narrow the selector to one visible object or exact option.');
  return matches[0];
}

// A grouped mana choice can contain useful side effects. Only demonstrably plain
// tap-for-mana text is ignorable when deciding that the seat has no useful play.
function plainManaChoice(choice) {
  const rules = choice.card?.rules;
  if (choice.type !== 'manaAbility' || choice.card?.faceDown || !Array.isArray(rules)) return false;
  const activated = rules.filter((text) => text.includes(':'));
  return activated.length > 0 && activated.every((text) => /^\{T\}: Add (?:\{[WUBRGC]\})+(?: or (?:\{[WUBRGC]\})+)*\.$/.test(text));
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
      if (!predicate && state.rollbackRequest) return { event: 'rollback', state };
      if (state.epoch !== epoch) return { event: 'invalidated', state };
      if (args.afterCursor !== undefined && state.cursor <= args.afterCursor) return null;
      const decision = visibleDecision(state);
      if (predicate ? reaches(state, predicate) : decision && decision.id !== args.afterDecisionId) {
        return { event: predicate ? 'reached' : 'decision', state };
      }
      return null;
    }, args.timeoutMs ?? RESPONSE_TIMEOUT_MS, signal);
    if (result) return result;
    // A wait can time out with the same unanswered decision still pending. Keep it visible.
    const state = this.snapshot();
    return { event: 'timeout', cursor: state.cursor, state };
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
    if (state.rollbackRequest) throw new ToolError('rollback_pending', 'Vote on the pending rollback before answering another game decision.');
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

  startSequence({ gameId, cursor, steps, expectedStackIds = [], allowPlannedCombatDamage = false, autoAdvance = false }, authorize, responsePolicy = 'interrupt') {
    const initial = this.snapshot(gameId);
    if (initial.cursor !== cursor || initial.status !== 'active') throw new ToolError('stale_decision', 'Plan from the latest game state.');
    if (initial.rollbackRequest) throw new ToolError('rollback_pending', 'Vote on the pending rollback before starting another line.');
    steps = steps.map((step) => ({ ...step }));
    if (!autoAdvance && responsePolicy !== 'ignore') for (let index = 0; index < steps.length; index++) {
      if (steps[index].kind !== 'answer' || !declaredInformation(steps[index], initial)) continue;
      let resolving = false;
      for (const next of steps.slice(index + 1)) {
        if (next.kind === 'yield_priority' || next.kind === 'pass_until' && next.allowPlannedResolutions) resolving = true;
        if (next.kind === 'advance_to_own_turn' || next.kind === 'pass_until' && (next.phase || next.step)
          || next.kind === 'answer' && (!guardedCostChoice(next) && (resolving || ['priority', 'declareAttackers'].includes(next.guard?.kind)))) throw new ToolError('reevaluation_required', 'This spell can reveal information or require an unknown decision. Queue its known casting costs/targets only; inspect its resolution before planning another action.');
        if (next.kind === 'answer') next.beforeInformation = true;
      }
    }
    if (new Set(expectedStackIds).size !== expectedStackIds.length || expectedStackIds.some((id) => !initial.stack.some((card) => card.id === id))) {
      throw new ToolError('bad_stack_expectation', 'Adopt only exact, distinct objects visible at the current stack cursor.');
    }
    if (steps.some((step, index) => step.kind === 'advance_to_own_turn' && index !== steps.length - 1)) {
      throw new ToolError('bad_sequence', 'Advance to your next turn only as the final step; replan before taking another action.');
    }
    if (this.#current || this.#inFlight) throw new ToolError('sequence_running', 'Finish or cancel the current decision or sequence first.');
    const sequence = {
      id: randomUUID(), gameId, status: 'running', reason: null, completedSteps: 0, appliedDecisions: 0, cursor, startCursor: cursor,
      startedAtEpochMs: Date.now(),
      controller: new AbortController(),
      finishListeners: new Set(),
    };
    this.#current = sequence;
    this.#sequences.set(sequence.id, sequence);
    if (this.#sequences.size > 40) this.#sequences.delete(this.#sequences.keys().next().value);
    void this.#runSequence(sequence, initial, steps, authorize, responsePolicy, { expectedStackIds, allowPlannedCombatDamage, autoAdvance });
    return this.sequenceStatus({ gameId, sequenceId: sequence.id });
  }

  /** Compile significant intentions; ordinary priority handoffs are the executor's responsibility. */
  startTurn({ gameId, cursor, actions, expectedStackIds, finish = 'next_turn', settle = true }, authorize) {
    const initial = this.snapshot(gameId);
    if (initial.cursor !== cursor || initial.status !== 'active') throw new ToolError('stale_decision', 'Plan from the latest game state.');
    const steps = [];
    const terminalPass = (action) => ['pass_until', 'pass_priority'].includes(action?.kind);
    const finalPass = terminalPass(actions.at(-1));
    if (actions.slice(0, -1).some(terminalPass)) throw new ToolError('bad_sequence', 'Put an explicit pass at the end of the line.');
    const ownId = initial.players?.find((player) => player.yourSeat)?.id;
    const resolvingInformation = initial.stack.some((card) => (card.controllerId === ownId || expectedStackIds?.includes(card.id)) && needsStackReevaluation(card));
    const answeringObservedInformation = actions.length === 1 && actions[0].kind === 'choose' && initial.decision
      && (actions[0].decisionId === initial.decision.id || actions[0].guard?.kind === initial.decision.kind
        && actions[0].guard?.instruction === initial.decision.instruction && reaches(initial, actions[0].guard));
    const respondingBeforeResolution = actions[0]?.kind === 'play' && actions[0].when === 'priority'
      && actions.every((action) => action.kind === 'play' && action.when === 'priority' || guardedCostChoice(action));
    const resumingCast = resolvingInformation && resumesObservedCast(initial, actions, ownId, expectedStackIds);
    const yieldingOnce = actions.length === 1 && actions[0].kind === 'pass_priority';
    if (resolvingInformation && actions.length && !answeringObservedInformation && !respondingBeforeResolution && !resumingCast && !yieldingOnce) throw new ToolError('reevaluation_required', 'The existing stack can reveal information or require an unknown decision. Resolve/inspect it before planning new actions; use when:priority for deliberate responses before resolution.');
    const exact = actions.length === 1 && actions[0];
    const singleObservedChoice = !settle && finish === 'none' && exact?.kind === 'choose' && exact.choiceId
      && exact.decisionId === initial.decision?.id && !exact.expectCast && !exact.expectAbility
      && !exact.expectTriggers?.length && !exact.expectTargetTriggers?.length && !exact.reevaluateAfter && !expectedStackIds?.length;
    let reevaluate = resolvingInformation;
    let beforeInformation = resolvingInformation && !answeringObservedInformation;
    for (const [actionIndex, action] of actions.entries()) {
      const terminal = declaredInformation({ ...action, expectCast: action.kind === 'play' ? action.playAs !== 'land' && action.expectCast !== false : action.expectCast }, initial);
      if (terminal && actions.slice(actionIndex + 1).some((next) => !guardedCostChoice(next) || declaredInformation(next, initial))) throw new ToolError('reevaluation_required', 'An information-changing intention must be last except for guarded casting costs/modes/targets. Inspect its actual result before planning the remainder.');
      const selectedCard = planCard(initial, action);
      const trackedEffect = action.expectAbility || (action.kind === 'play' ? action.expectCast !== false : action.expectCast)
        && selectedCard?.cardId && Array.isArray(selectedCard.types) && !selectedCard.types.includes('LAND') && !selectedCard.faceDown;
      if (action.reevaluateAfter && actionIndex !== actions.length - 1 && !trackedEffect) throw new ToolError('reevaluation_required', 'An untracked terminal choice must be last; no later choice can be assumed to precede its unknown outcome.');
      reevaluate ||= terminal;
      const firstStep = steps.length;
      if (action.kind === 'play') {
        steps.push({ kind: 'answer', guard: { kind: 'priority', priority: 'self' }, select: action.select, playAs: action.playAs,
          expectCast: action.playAs === 'land' || action.expectCast === false ? false : 'auto', reevaluateAfter: action.reevaluateAfter, semanticPlay: true,
          requiresEmptyStack: action.when !== 'priority', expectTriggers: action.expectTriggers, expectTargetTriggers: action.expectTargetTriggers });
        for (const target of action.targets ?? []) steps.push({ kind: 'answer', guard: { kind: 'target', instruction: target.instruction }, select: target.select, semanticTarget: true,
          skipIfTargetedBy: action.select.cardId });
        for (const source of action.payWith ?? []) steps.push({ kind: 'answer', guard: { kind: 'payMana' }, select: { objectId: source, zone: 'battlefield' } });
      } else if (action.kind === 'choose') {
        const allowOpeningTransition = actionIndex === 0 && !initial.step
          && (initial.turn == null || initial.turn === 0 || initial.turn === 1)
          && initial.decision?.kind === 'mulligan' && action.decisionId === initial.decision.id;
        steps.push({ ...action, kind: 'answer', resumeCastId: resumingCast ? initial.stack[0].id : undefined, allowOpeningTransition });
      } else if (action.kind === 'attack') {
        if (action.attackers === 'all' || action.attackers === undefined) steps.push({ kind: 'answer', guard: { kind: 'declareAttackers' }, intent: 'attack_all' });
        else for (const id of action.attackers) steps.push({ kind: 'answer', guard: { kind: 'declareAttackers' }, select: { objectId: id, zone: 'battlefield' } });
        steps.push({ kind: 'answer', guard: { kind: 'declareAttackers' }, intent: 'confirm_attack', expectTriggers: action.expectTriggers });
      } else if (action.kind === 'pass_priority') {
        steps.push({ kind: 'yield_priority', allowTurnBoundary: true });
      } else if (action.kind === 'pass_until') {
        const { destination, phase, step, priority } = action;
        if (destination === 'current_turn' && phase === undefined && step === undefined && priority === undefined) {
          throw new ToolError('bad_sequence', 'Choose a phase, step or priority for a current-turn destination.');
        }
        steps.push({ kind: 'pass_to_boundary', destination, phase, step, priority, skipOptionalResponses: action.policy === 'decline_optional' });
      } else steps.push(action);
      for (let index = firstStep; index < steps.length; index++) {
        steps[index].actionIndex = actionIndex;
        if (beforeInformation || terminal) steps[index].beforeInformation = true;
      }
      beforeInformation ||= terminal;
    }
    if (!finalPass) {
      // Legacy turns and terminal effects retain the settlement fence. An exact
      // choice in a play line observes the next prompt without making a pass.
      if ((settle || reevaluate || finish !== 'none') && !singleObservedChoice) steps.push({ kind: 'pass_until', priority: 'self', stackEmpty: true, allowPlannedResolutions: true, skipOptionalResponses: true });
      if (reevaluate && !singleObservedChoice) steps.push({ kind: 'reevaluate' });
      else if (finish === 'next_turn') steps.push({ kind: 'advance_to_own_turn' });
      else if (finish === 'end_step') steps.push({ kind: 'pass_until', step: 'END_TURN' });
      else if (!settle) steps.push({ kind: 'observe_next' });
    }
    if (steps.length > 96) throw new ToolError('bad_sequence', 'The semantic turn exceeds its bounded action budget.');
    const adopted = expectedStackIds ?? (singleObservedChoice ? [] : initial.stack.filter((card) => card.controllerId === ownId).map((card) => card.id));
    if (adopted.length > 16) throw new ToolError('bad_stack_expectation', 'A semantic turn may adopt at most sixteen visible objects.');
    return this.startSequence({ gameId, cursor, steps, autoAdvance: !singleObservedChoice, allowPlannedCombatDamage: !singleObservedChoice,
      expectedStackIds: adopted }, authorize);
  }

  sequenceStatus({ gameId, sequenceId, startCursor }) {
    if (!sequenceId && startCursor === undefined) throw new ToolError('missing_sequence', 'Supply the sequenceId, or its exact startCursor if the transport lost the plan receipt.');
    const sequence = sequenceId ? this.#sequences.get(sequenceId)
      : [...this.#sequences.values()].reverse().find((item) => item.gameId === gameId && item.startCursor === startCursor);
    if (!sequence || sequence.gameId !== gameId) throw new ToolError('unknown_sequence', 'This seat does not have that sequence.');
    if (startCursor !== undefined && sequence.startCursor !== startCursor) throw new ToolError('unknown_sequence', 'The plan does not match that starting cursor.');
    const { controller, finishListeners, id, ...status } = sequence;
    return { sequenceId: id, ...status };
  }

  async waitSequenceStatus(args, timeoutMs, signal) {
    signal?.throwIfAborted();
    const status = this.sequenceStatus(args);
    const pendingRollback = () => {
      const state = this.snapshot();
      return state.gameId === args.gameId && state.rollbackRequest;
    };
    if (status.status !== 'running' || timeoutMs === 0 || pendingRollback()) return status;
    const { finishListeners } = this.#sequences.get(status.sequenceId);
    await new Promise((resolve, reject) => {
      const done = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(signal.reason); };
      const cleanup = () => {
        clearTimeout(timer);
        finishListeners.delete(done);
        unsubscribe();
        signal?.removeEventListener('abort', abort);
      };
      const timer = setTimeout(done, timeoutMs);
      const unsubscribe = this.engine.subscribe(() => { if (pendingRollback()) done(); });
      finishListeners.add(done);
      signal?.addEventListener('abort', abort, { once: true });
      if (pendingRollback()) done();
    });
    return this.sequenceStatus(args);
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

  async #runSequence(sequence, initial, steps, authorize, responsePolicy, { expectedStackIds, allowPlannedCombatDamage, autoAdvance }) {
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
    const publicCardState = ({ hints: _derivedHints, ...card }) => card;
    const publicCounters = (counters = []) => counters.map(({ name, count }) => ({ name, count }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
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
        players: opponents.map(({ id, life, counters, handCount, libraryCount, battlefield, graveyard, exile }) =>
          ({ id, life, counters: publicCounters(counters), handCount, libraryCount, battlefield: battlefield?.map(publicCardState), graveyard: graveyard?.map(publicCardState), exile: exile?.map(publicCardState) })),
        combat: (state.combat ?? []).flatMap((group, index) => {
          const attackers = (group.attackers ?? []).filter(opposingCombatCard);
          const blockers = (group.blockers ?? []).filter(opposingCombatCard);
          return attackers.length || blockers.length
            ? [{ index, attackerIds: (group.attackers ?? []).map((card) => card.id), attackers: attackers.map(publicCardState), blockers: blockers.map(publicCardState) }] : [];
        }),
      });
    };
    let expectedOpponentState = opponentState(initial);
    let previousPublicFrame = initial;
    const ownPlayerId = initial.players?.find((player) => player.yourSeat)?.id;
    const initialEvidence = initial.sequenceEvidence;
    let evidenceRevision = initialEvidence?.resolutionRevision;
    let combatRevision = initialEvidence?.combatRevision;
    const informationRevision = initialEvidence?.informationRevision;
    const plannedAttackers = new Set((initial.combat ?? []).flatMap((group) => group.attackers ?? []).filter((card) => card.controllerId === ownPlayerId
      || initial.players?.some((player) => player.yourSeat && player.battlefield?.some((own) => own.id === card.id))).map((card) => card.id));
    let attackDeclarationPending = false;
    const pendingCombatDamage = new Map();
    const permanentCombat = new PlannedPermanentCombat();
    let settlingResolution = false;
    const resolvingPlanned = new Set();
    let advancingOwnTurn = false;
    let crossingTurnBoundary = false;
    let waitingForOpeningTurn = false;
    let requestedPassBoundary;
    const validEvidence = (evidence) => evidence && typeof evidence.epoch === 'string'
      && Number.isSafeInteger(evidence.resolutionRevision) && evidence.resolutionRevision >= 0
      && evidence.publicActions && evidence.resolutions
      && Object.values(evidence.publicActions).every((value) => Number.isSafeInteger(value) && value >= 0)
      && Object.values(evidence.resolutions).every((value) => Number.isSafeInteger(value) && value > 0);
    const initialEvidenceValid = validEvidence(initialEvidence);
    let turn = initial.turn;
    let activePlayer = initial.activePlayer;
    let activeTurnPlayerId = initial.activePlayerId;
    const beforeDraw = (state) => state.step === 'UNTAP' || state.step === 'UPKEEP';
    let targetsThisDraw = false;
    const nextOwnTurn = (state) => state.turn > turn && state.activePlayerId === ownPlayerId;
    const atOrAfterOwnDraw = (state) => {
      const ownDrawTurn = requestedPassBoundary === 'my_draw' && targetsThisDraw
        ? state.turn === turn && state.activePlayerId === ownPlayerId : nextOwnTurn(state);
      return ownDrawTurn && state.step && !beforeDraw(state);
    };
    const reportInformation = (state, message) => {
      // Allow this terminal boundary to observe the actionable post-draw
      // snapshot, but never pass again once it observes the information.
      if (['my_draw', 'my_upkeep'].includes(requestedPassBoundary) && atOrAfterOwnDraw(state)) {
        sequence.observedNewInformation = true;
        return;
      }
      throw new ToolError('new_information', message);
    };
    let previousDecisionId = null;
    let passCount = 0;
    let expectedStackCards = initial.stack;
    let expectedStack = stackIdentity(initial.stack);
    const plannedStackIds = new Set(expectedStackIds);
    for (const id of expectedStackIds) if (initialEvidence?.resolutions?.[id]) {
      resolvingPlanned.add(id);
      settlingResolution = true;
    }
    const initiallyKnownCards = new Set([
      ...(initial.ownHand ?? []), ...initial.stack,
      ...(initial.revealed ?? []).flatMap((group) => group.cards ?? []), ...(initial.lookedAt ?? []).flatMap((group) => group.cards ?? []),
      ...(initial.decision?.choices ?? []).flatMap((choice) => [choice.card, ...(choice.cards ?? [])].filter(Boolean)),
      ...(initial.players ?? []).flatMap((player) => [
        ...(player.topCard ? [player.topCard] : []),
        ...(player.battlefield ?? []), ...(player.exile ?? []), ...(player.graveyard ?? []),
      ]),
    ].filter((card) => !card.faceDown).map((card) => card.cardId ?? card.id));
    const allowPlannedResolutions = autoAdvance || expectedStackIds.length > 0 || steps.some((step) => step.allowPlannedResolutions === true);
    let pendingCast = null;
    let pendingTriggers = [];
    const pendingIntention = () => pendingCast
      || pendingTriggers.some((entry) => entry.abilityType === 'ACTIVATED_NONMANA' && entry.remaining > 0);
    const explicitInformationObjects = new Set();
    let canCallHeads = false;
    let informationResolutionStarted = expectedStackIds.some((id) => initialEvidence?.resolutions?.[id] && initial.stack.some((card) => card.id === id
      && needsStackReevaluation(card)));
    const checkStack = (state, openingTransition) => {
      if (responsePolicy === 'ignore') return;
      if (state.decision?.informationBoundary && state.decision.id !== initial.decision?.id) {
        throw new ToolError('new_information', 'A newly presented library, pile or random-result choice needs a fresh plan after inspecting its information.');
      }
      const evidence = state.sequenceEvidence;
      if ((autoAdvance || allowPlannedResolutions) && !Number.isSafeInteger(informationRevision)) throw new ToolError('evidence_unavailable', 'Automating resolutions requires current information evidence; read a fresh state from a compatible engine.');
      const witnessed = initialEvidenceValid && validEvidence(evidence) && evidence.epoch === initialEvidence.epoch;
      const newResolutions = witnessed ? Object.entries(evidence.resolutions)
        .filter(([, revision]) => revision > evidenceRevision).sort((a, b) => a[1] - b[1]) : [];
      if (initialEvidenceValid) {
        if (!witnessed || evidence.resolutionRevision < evidenceRevision
          || newResolutions.length !== evidence.resolutionRevision - evidenceRevision
          || newResolutions.some(([, revision], index) => revision !== evidenceRevision + index + 1)) {
          throw new ToolError('evidence_unavailable', 'Public action/resolution evidence changed or has a gap; read a fresh state.');
        }
        for (const player of state.players ?? []) if (!player.yourSeat
          && (evidence.publicActions[player.id] ?? 0) !== (initialEvidence.publicActions[player.id] ?? 0)) {
          throw new ToolError('opponent_action', 'The opponent took a public non-pass action; replan the unapplied remainder.');
        }
        if (informationRevision !== undefined) {
          if (!Number.isSafeInteger(evidence.informationRevision) || evidence.informationRevision < informationRevision) throw new ToolError('evidence_unavailable', 'Information evidence is unavailable or moved backwards.');
          if (evidence.informationRevision !== informationRevision) reportInformation(state, 'A new public or own random outcome needs a fresh plan.');
        }
      }
      if (attackDeclarationPending) {
        const ownIds = new Set(state.players?.filter((player) => player.yourSeat).flatMap((player) => player.battlefield ?? []).map((card) => card.id));
        for (const group of state.combat ?? []) for (const card of group.attackers ?? []) {
          if (card.controllerId === ownPlayerId || ownIds.has(card.id)) plannedAttackers.add(card.id);
        }
      }
      if (allowPlannedCombatDamage) {
        if (!witnessed || !Number.isSafeInteger(combatRevision) || !Number.isSafeInteger(evidence.combatRevision) || !Array.isArray(evidence.combatDamage)) {
          throw new ToolError('evidence_unavailable', 'Planned combat needs current public combat evidence.');
        }
        const fresh = evidence.combatDamage.filter((entry) => entry.revision > combatRevision).sort((a, b) => a.revision - b.revision);
        if (fresh.length !== evidence.combatRevision - combatRevision || fresh.some((entry, index) => entry.revision !== combatRevision + index + 1)) {
          throw new ToolError('evidence_unavailable', 'Public combat evidence is discontinuous.');
        }
        for (const hit of fresh) {
          if (hit.targetPermanent === true) {
            if (!Number.isSafeInteger(hit.amount) || hit.amount <= 0
              || !permanentCombat.record(previousPublicFrame, state, hit, ownPlayerId, plannedAttackers)) {
              throw new ToolError('opponent_state_changed', 'Combat damage to a permanent did not match attackers and blockers already observed.');
            }
            continue;
          }
          if (hit.controllerId !== ownPlayerId || !plannedAttackers.has(hit.sourceId) || !Number.isSafeInteger(hit.amount) || hit.amount <= 0
            || !state.players?.some((player) => !player.yourSeat && player.id === hit.targetId)) {
            throw new ToolError('opponent_state_changed', 'Combat damage was not caused by a declared own attacker.');
          }
          pendingCombatDamage.set(hit.targetId, (pendingCombatDamage.get(hit.targetId) ?? 0) + hit.amount);
        }
        combatRevision = evidence.combatRevision;
      }
      for (const [id] of newResolutions) {
        if (!allowPlannedResolutions || !plannedStackIds.has(id)) {
          throw new ToolError('state_changed', 'An unplanned stack object resolved between views.');
        }
        resolvingPlanned.add(id);
        const object = expectedStackCards.find((card) => card.id === id) ?? state.stack.find((card) => card.id === id);
        if (explicitInformationObjects.has(id) || needsStackReevaluation(object)) {
          informationResolutionStarted = true;
          canCallHeads = !!(object?.abilityType && /\bflip\b[^.]*\bcoins?\b/i.test(object.abilityText ?? '')
            || needsSpellReevaluation(object) && (object.rules ?? []).some((text) => /\bflip\b[^.]*\bcoins?\b/i.test(text)));
        }
        settlingResolution = true;
      }
      const currentOpponentState = opponentState(state);
      if (openingTransition && currentOpponentState !== expectedOpponentState) {
        // London mulligans may change the rival's public hand and library
        // counts in the transition to turn one. Keep every other comparison.
        const expected = JSON.parse(expectedOpponentState);
        const current = JSON.parse(currentOpponentState);
        for (const player of expected.players) {
          const now = current.players.find(({ id }) => id === player.id);
          if (now) {
            player.handCount = now.handCount;
            player.libraryCount = now.libraryCount;
          }
        }
        expectedOpponentState = JSON.stringify(expected);
      }
      let combatExplainsChange = false;
      if (currentOpponentState !== expectedOpponentState) {
        const priorPlayers = JSON.parse(expectedOpponentState).players;
        const countersChanged = JSON.parse(currentOpponentState).players.some((player) =>
          JSON.stringify(player.counters) !== JSON.stringify(priorPlayers.find((prior) => prior.id === player.id)?.counters));
        // Ordinary turn advancement cannot conceal poison/toxic or another counter change.
        if (countersChanged && !(witnessed && allowPlannedResolutions && (resolvingPlanned.size || settlingResolution))) {
          throw new ToolError('opponent_state_changed', 'Public player counters changed outside a declared own resolution.');
        }
      }
      if (permanentCombat.active || currentOpponentState !== expectedOpponentState && pendingCombatDamage.size) {
        const expected = JSON.parse(expectedOpponentState);
        const actual = JSON.parse(currentOpponentState);
        if (permanentCombat.active && (newResolutions.length || resolvingPlanned.size
          || !permanentCombat.reconcile(previousPublicFrame, state, expected, actual))) {
          throw new ToolError('opponent_state_changed', 'Combat did not match witnessed damage to the declared combatants.');
        }
        const accountedFor = [];
        for (const player of expected.players) {
          const damage = pendingCombatDamage.get(player.id);
          if (!damage || !Number.isFinite(player.life)) continue;
          const afterDamage = player.life - damage;
          if (actual.players.find(({ id }) => id === player.id)?.life === afterDamage) {
            player.life = afterDamage;
            accountedFor.push(player.id);
          }
        }
        combatExplainsChange = JSON.stringify(expected) === currentOpponentState;
        if (combatExplainsChange) for (const id of accountedFor) pendingCombatDamage.delete(id);
        else if (currentOpponentState !== expectedOpponentState) {
          throw new ToolError('opponent_state_changed', 'Combat damage did not match the exact witnessed life loss and permanent changes.');
        }
      }
      if (currentOpponentState !== expectedOpponentState
        && !(witnessed && ((allowPlannedResolutions && (resolvingPlanned.size || settlingResolution)) || advancingOwnTurn || combatExplainsChange))) {
        throw new ToolError('opponent_state_changed', 'Public opponent state changed without verified planned resolution; inspect before continuing.');
      }
      const commitEvidence = () => {
        expectedOpponentState = currentOpponentState;
        previousPublicFrame = state;
        permanentCombat.finish(state);
        if (witnessed) evidenceRevision = evidence.resolutionRevision;
        for (const id of resolvingPlanned) if (!state.stack.some((item) => item.id === id)) resolvingPlanned.delete(id);
      };
      {
        const visibleCards = [
          ...(state.ownHand ?? []),
          ...(state.revealed ?? []).flatMap((group) => group.cards ?? []), ...(state.lookedAt ?? []).flatMap((group) => group.cards ?? []),
          ...(state.decision?.choices ?? []).flatMap((choice) => [
            state.decision.triggerOrder && choice.triggerSourceId ? null : choice.card, ...(choice.cards ?? []),
          ].filter(Boolean)),
          ...(state.players ?? []).flatMap((player) => [...(player.topCard ? [player.topCard] : []), ...(player.battlefield ?? []), ...(player.graveyard ?? []), ...(player.exile ?? [])]),
        ];
        if (visibleCards.some((card) => (card.cardId ?? card.id) && !card.faceDown && !card.isToken && !initiallyKnownCards.has(card.cardId ?? card.id))) {
          reportInformation(state, 'A newly visible card needs a fresh plan.');
        }
      }
      const currentStack = stackIdentity(state.stack);
      if (currentStack === expectedStack) { commitEvidence(); return; }
      const priorIds = new Set(expectedStackCards.map((card) => card.id));
      const currentIds = new Set(state.stack.map((card) => card.id));
      const added = state.stack.filter((card) => !priorIds.has(card.id));
      const removed = expectedStackCards.filter((card) => !currentIds.has(card.id));
      const oldRetained = expectedStackCards.filter((card) => currentIds.has(card.id));
      const newRetained = state.stack.filter((card) => priorIds.has(card.id));
      if (stackIdentity(oldRetained) !== stackIdentity(newRetained)
        || (removed.length && (!allowPlannedResolutions || removed.some((card) => !plannedStackIds.has(card.id) || !witnessed || !resolvingPlanned.has(card.id))))) {
        throw new ToolError('state_changed', 'The stack changed outside the sequence.');
      }
      let nextCast = pendingCast;
      const nextTriggers = pendingTriggers.map((trigger) => ({ ...trigger }));
      for (const item of added) {
        if (nextCast && item.cardId === nextCast.cardId && item.controllerId === nextCast.playerId
          && item.name === nextCast.name && item.id !== item.cardId && !item.abilityType) {
          if (nextCast.information) explicitInformationObjects.add(item.id);
          nextCast = null;
          continue;
        }
        const expected = nextTriggers.filter((trigger) => trigger.remaining > 0
          && item.abilityType === (trigger.abilityType ?? 'TRIGGERED_NONMANA') && item.sourceId === trigger.sourceId
          && item.abilityText === trigger.abilityText && item.controllerId === trigger.playerId
          && (!trigger.targetingCardId || state.stack.some((spell) => spell.cardId === trigger.targetingCardId && spell.controllerId === ownPlayerId && spell.targets?.includes(trigger.sourceId))));
        if (expected.length !== 1) throw new ToolError('state_changed', 'An unexpected or ambiguous stack object needs a fresh plan.');
        if (expected[0].information) explicitInformationObjects.add(item.id);
        expected[0].remaining--;
      }
      if (added.length || removed.length) {
        // Commit budgets only after validating the complete stack delta: a known
        // trigger must never hide an opponent response in the same update.
        pendingCast = nextCast;
        pendingTriggers = nextTriggers;
        expectedStack = currentStack;
        expectedStackCards = state.stack;
        for (const card of added) plannedStackIds.add(card.id);
        for (const card of removed) plannedStackIds.delete(card.id);
        commitEvidence();
        return;
      }
      throw new ToolError('state_changed', 'The stack changed outside the sequence.');
    };
    const checkGame = (state) => {
      accountTime(state);
      if (state.gameId !== sequence.gameId || state.status !== 'active' || state.epoch !== initial.epoch) {
        throw new ToolError('invalidated', 'The game state changed.');
      }
      if (waitingForOpeningTurn && (state.turn == null || state.turn === 0 || state.turn === 1)) {
        if (!state.step) return true;
        if (state.turn === 1 && ownPlayerId && state.activePlayerId === ownPlayerId) {
          waitingForOpeningTurn = false;
          turn = state.turn;
          activePlayer = state.activePlayer;
          activeTurnPlayerId = state.activePlayerId;
          return true;
        }
        throw new ToolError('turn_changed', 'The first turn belongs to the opponent. Inspect the current state before continuing.');
      }
      if (!crossingTurnBoundary && (state.turn !== turn || state.activePlayer !== activePlayer)) {
        throw new ToolError('turn_changed', 'The observed turn ended. Read the current state and plan again before passing.');
      }
      return false;
    };
    const unwatch = this.engine.subscribe(() => {
      try {
        const state = this.snapshot();
        checkStack(state, checkGame(state));
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
      checkStack(state, checkGame(state));
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
    const recordDestination = (state) => {
      sequence.lastDestination = { cursor: state.cursor, turn: state.turn, activePlayerId: state.activePlayerId, phase: state.phase, step: state.step };
    };
    const matchesAnswer = (state, step) => step?.kind === 'answer' && visibleDecision(state)
      && (step.decisionId ? state.decision.id === step.decisionId : step.guard?.kind === state.decision.kind && reaches(state, step.guard)
        && (step.guard.instruction === undefined || step.guard.instruction === state.decision.instruction))
      && (!step.requiresEmptyStack || state.stack.length === 0);
    const intentionReady = (state, step) => matchesAnswer(state, step) && (!step.semanticPlay || plannedChoice(state, state.decision, step));
    const checkAttackWindow = (state, step) => {
      if (autoAdvance && step.guard?.kind === 'declareAttackers'
        && (state.activePlayerId !== ownPlayerId || ['DECLARE_BLOCKERS', 'FIRST_COMBAT_DAMAGE', 'COMBAT_DAMAGE', 'END_COMBAT', 'POSTCOMBAT_MAIN', 'END_TURN', 'CLEANUP'].includes(state.step))) {
        throw new ToolError('illegal_choice', 'The intended attack has no current own attack window; replan before passing.');
      }
    };
    const canSkipTarget = (state, step) => {
      const targetId = step.select?.objectId ?? step.select?.cardId;
      if (!step.skipIfTargetedBy || step.guard?.kind !== 'target' || !targetId) return false;
      const publicTarget = state.stack.some((card) => card.id === targetId) || state.players?.some((player) => player.id === targetId || player.battlefield?.some((card) => card.id === targetId));
      const matching = state.stack.filter((card) => card.cardId === step.skipIfTargetedBy && card.controllerId === ownPlayerId && plannedStackIds.has(card.id));
      return publicTarget && matching.length === 1 && matching[0].targets?.includes(targetId);
    };
    const requireSettledCombat = () => {
      if (pendingCombatDamage.size || permanentCombat.pending) throw new ToolError('opponent_state_changed', 'Combat damage has not produced its exact witnessed changes; read a fresh state.');
    };
    const submit = async (args) => {
      requireSettledCombat();
      settlingResolution = false;
      const submission = { stepIndex: sequence.completedSteps, actionIndex: sequence.actionIndex ?? null,
        dispatchedAtEpochMs: Date.now(), finishedAtEpochMs: null, acknowledged: false };
      sequence.lastSubmission = submission;
      try { const result = await this.submit(args, sequence.id); submission.acknowledged = true; return result; }
      finally { submission.finishedAtEpochMs = Date.now(); }
    };
    const nextPredeterminedAnswer = (state) => {
      const next = steps[sequence.completedSteps + 1];
      return matchesAnswer(state, next) && next.guard?.instruction !== undefined && plannedChoice(state, state.decision, next);
    };
    const requireBeforeInformation = (step) => {
      // Calling heads/tails precedes the random outcome; choosing which result to keep does not.
      const beforeFlip = canCallHeads && step.guard?.kind === 'question' && step.guard.instruction === 'Heads or tails?';
      if (step.beforeInformation && informationResolutionStarted && !beforeFlip) throw new ToolError('new_information', 'The information-changing effect began resolving; inspect it before answering further choices.');
    };
    try {
      for (const step of steps) {
        sequence.actionIndex = step.actionIndex ?? null;
        requestedPassBoundary = step.kind === 'pass_to_boundary' ? step.destination : undefined;
        if (requestedPassBoundary) sequence.requestedDestination = requestedPassBoundary;
        const boundaryAnchor = requestedPassBoundary === 'my_draw' && sequence.completedSteps > 0 ? this.snapshot() : initial;
        targetsThisDraw = requestedPassBoundary === 'my_draw'
          && boundaryAnchor.activePlayerId === ownPlayerId && beforeDraw(boundaryAnchor);
        advancingOwnTurn = step.kind === 'advance_to_own_turn' || ['my_upkeep', 'my_draw'].includes(requestedPassBoundary);
        crossingTurnBoundary = advancingOwnTurn || !!requestedPassBoundary || step.allowTurnBoundary === true;
        let state = await stateForStep();
        if (step.kind === 'hold' || step.kind === 'pace') {
          if (!visibleDecision(state) || state.decision.id === previousDecisionId) throw new ToolError('not_actionable', 'A hold requires a current decision.');
          if (step.kind === 'pace' && (state.decision.kind !== 'priority' || state.priority !== 'self')) throw new ToolError('response_available', 'Pacing requires ordinary priority, never a mandatory prompt.');
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
          requireBeforeInformation(step);
          if (autoAdvance && state.stop) throw new ToolError('response_available', 'The configured stop needs a fresh plan.');
          checkAttackWindow(state, step);
          if ((!matchesAnswer(state, step) || step.semanticTarget && step.guard?.instruction === undefined) && canSkipTarget(state, step)) {
            sequence.skippedSteps = (sequence.skippedSteps ?? 0) + 1;
            sequence.completedSteps++;
            sequence.cursor = state.cursor;
            continue;
          }
          while (autoAdvance && !intentionReady(state, step)) {
            requireBeforeInformation(step);
            if (step.resumeCastId) throw new ToolError('response_available', 'The resumed cast reached another prompt. Inspect it before continuing.');
            checkAttackWindow(state, step);
            const decision = visibleDecision(state);
            if (!decision || decision.id === previousDecisionId) {
              if (!await waitForNext()) throw new ToolError('timeout', 'The next intended decision did not arrive.');
            } else {
              if (step.semanticPlay && decision.kind === 'priority' && state.stack.length === 0 && ['PRECOMBAT_MAIN', 'POSTCOMBAT_MAIN'].includes(state.step) && state.priority === 'self') {
                throw new ToolError('illegal_choice', 'The next planned play is unavailable in this main phase.');
              }
              const pass = decision.choices.find((choice) => choice.type === 'pass');
              if (decision.kind !== 'priority' || state.priority !== 'self' || !pass || state.stop || pendingCast
                || (!step.semanticPlay && step.guard?.kind !== 'declareAttackers' && !state.stack.length)) {
                throw new ToolError('response_available', 'An unplanned mandatory choice or unavailable intention needs a fresh plan.');
              }
              if (++passCount > 80) throw new ToolError('pass_limit', 'The semantic turn reached its priority limit.');
              await submit({ gameId: sequence.gameId, cursor: state.cursor, decisionId: decision.id, choiceId: pass.id, idempotencyKey: `${sequence.id}:implicit:${passCount}` });
              sequence.appliedDecisions++; previousDecisionId = decision.id;
            }
            state = await stateForStep();
          }
          checkAttackWindow(state, step);
          requireBeforeInformation(step);
          const decision = state.decision;
          if (step.resumeCastId && (state.stack[0]?.id !== step.resumeCastId || state.stack[0].unpaid !== true)) {
            throw new ToolError('response_available', 'The spell is no longer awaiting the resumed casting choices.');
          }
          const castingPicker = pendingCast && ['panel', 'chooseAbility'].includes(decision.kind) && matchesAnswer(state, step);
          if (step.semanticTarget && step.guard?.instruction === undefined) throw new ToolError('response_available', 'An unresolved target needs its exact instruction guard; an absent prompt is not target evidence.');
          if ((pendingCast && !castingPicker) || state.turn !== turn && !waitingForOpeningTurn || (step.decisionId ? decision.id !== step.decisionId :
            !step.guard || step.guard.kind !== decision.kind || !reaches(state, step.guard)
            || (step.guard.instruction !== undefined && step.guard.instruction !== decision.instruction))) {
            throw new ToolError('state_changed', 'The expected guarded decision changed.');
          }
          const choice = plannedChoice(state, decision, step);
          if (!choice) throw new ToolError('illegal_choice', 'The planned choice is unavailable in the current decision.');
          if (step.expectAbility) {
            const own = state.players?.find((player) => player.yourSeat);
            const source = own?.battlefield?.find((card) => card.id === step.expectAbility.sourceId);
            const matchesSource = decision.kind === 'priority' ? (choice.objectId ?? choice.card?.id) === source?.id
              : decision.kind === 'chooseAbility' || decision.kind === 'panel' && decision.sourceObjectId === source?.id
                && choice.type === 'option' && choice.abilityType === 'ACTIVATED_NONMANA';
            if (!source || source.faceDown || !matchesSource) throw new ToolError('bad_ability_expectation', 'Expect only an exact non-mana activation of the selected visible own battlefield source.');
            if (pendingTriggers.some((entry) => entry.remaining > 0 && entry.sourceId === source.id && entry.abilityText === step.expectAbility.abilityText)) throw new ToolError('ambiguous_trigger_expectation', 'An exact own stack ability already has an unconsumed expectation.');
            pendingTriggers.push({ ...step.expectAbility, playerId: own.id, remaining: 1, abilityType: 'ACTIVATED_NONMANA', information: !!step.reevaluateAfter });
          }
          if (step.expectTargetTriggers?.length) {
            for (const trigger of step.expectTargetTriggers) {
              const rival = state.players?.find((player) => !player.yourSeat && player.battlefield?.some((card) => card.id === trigger.sourceId));
              const source = rival?.battlefield.find((card) => card.id === trigger.sourceId);
              const targetingCast = step.expectCast && (choice.card?.cardId === trigger.targetingCardId || choice.card?.id === trigger.targetingCardId);
              const existing = state.stack.some((card) => card.controllerId === ownPlayerId && card.cardId === trigger.targetingCardId && plannedStackIds.has(card.id));
              if (!source || source.faceDown || !/^Ward(?:\b|[—–-])/i.test(trigger.abilityText)
                || !source.rules?.some((rule) => /^Ward(?:\b|[—–-])/i.test(rule)) || (!targetingCast && !existing)) {
                throw new ToolError('bad_target_trigger_expectation', 'Expect only exact Ward on a visible opposing target of the declared own spell.');
              }
              if (pendingTriggers.some((entry) => entry.remaining > 0 && entry.sourceId === trigger.sourceId && entry.abilityText === trigger.abilityText)) throw new ToolError('ambiguous_trigger_expectation', 'Declare one exact target-trigger budget.');
              pendingTriggers.push({ ...trigger, playerId: rival.id, remaining: trigger.count ?? 1 });
            }
          }
          if (step.expectTriggers?.length) {
            const own = state.players?.find((player) => player.yourSeat);
            const sources = [...(state.ownHand ?? []), ...(own?.battlefield ?? [])];
            const additions = [];
            for (const trigger of step.expectTriggers) {
              const source = sources.find((card) => card.id === trigger.sourceId)
                ?? (step.expectCast && choice.card?.id === trigger.sourceId ? choice.card : null);
              if (!own?.id || !source || source.faceDown || source.name === 'Face-down card') {
                throw new ToolError('bad_trigger_expectation', 'Predeclare only a visible own source or the spell you are casting.');
              }
              if ([...pendingTriggers.filter((item) => item.remaining > 0), ...additions]
                .some((item) => item.sourceId === trigger.sourceId && item.abilityText === trigger.abilityText)) {
                throw new ToolError('ambiguous_trigger_expectation', 'Use one bounded count for each exact source and ability.');
              }
              additions.push({ ...trigger, playerId: own.id, remaining: trigger.count ?? 1 });
            }
            pendingTriggers.push(...additions);
          }
          if (decision.kind === 'panel' && (castingPicker || step.expectCast)) {
            const card = visibleCastSource(state, decision.sourceObjectId);
            const playerId = state.players?.find((player) => player.yourSeat)?.id;
            if (!card || !playerId || (pendingCast && pendingCast.objectId !== card.id)
              || choice.type !== 'option' || choice.abilityType !== 'SPELL' || !choice.spellName) {
              throw new ToolError('bad_cast_expectation', 'Choose a typed spell option from the exact visible source of this cast.');
            }
            pendingCast = { objectId: card.id, cardId: card.cardId, name: choice.spellName, playerId,
              information: !!step.reevaluateAfter || !!pendingCast?.information };
          } else if (step.expectCast && !castingPicker && !(step.expectCast === 'auto' && choice.card?.types?.includes('LAND'))) {
            // The engine's visible legal choice can cast from exile/graveyard too
            // (for example Wrenn's Resolve or flashback). Never infer permission
            // from the zone alone, or treat a battlefield activation as a cast.
            const card = visibleCastSource(state, choice.card?.id);
            const playerId = state.players?.find((player) => player.yourSeat)?.id;
            if (decision.kind !== 'priority' || !playerId || !Array.isArray(card?.types) || card.types.includes('LAND')) {
              throw new ToolError('bad_cast_expectation', 'Expect a cast only for a visible legal spell from hand, exile or graveyard during priority; not a mode, target or activated ability.');
            }
            pendingCast = { objectId: card.id, cardId: card.cardId, name: card.name, playerId, information: !!step.reevaluateAfter };
          }
          if (decision.kind === 'declareAttackers') attackDeclarationPending = true;
          if (step.allowOpeningTransition && choice.type === 'button' && choice.label === 'Keep') {
            waitingForOpeningTurn = true;
          }
          await submit({
            gameId: sequence.gameId, cursor: state.cursor, decisionId: decision.id, choiceId: choice.id,
            idempotencyKey: `${sequence.id}:${sequence.completedSteps}`, value: step.value,
          });
          sequence.appliedDecisions++;
          previousDecisionId = decision.id;
          if (step.playAs === 'land') {
            const observed = await waitForNext();
            if (!observed) throw new ToolError('timeout', 'The next decision after selecting the land did not arrive.');
            const picker = observed.decision;
            if (picker.kind === 'panel') {
              const landOptions = picker.choices.filter((item) => item.abilityType === 'PLAY_LAND');
              if (picker.sourceObjectId !== choice.objectId || landOptions.length !== 1) {
                throw new ToolError('response_available', 'Choose the exact land face from the picker for the selected object.');
              }
              await submit({ gameId: sequence.gameId, cursor: observed.cursor, decisionId: picker.id,
                choiceId: landOptions[0].id, idempotencyKey: `${sequence.id}:land:${sequence.completedSteps}` });
              sequence.appliedDecisions++;
              previousDecisionId = picker.id;
            }
          }
        } else if (step.kind === 'yield_priority') {
          // A yield is one deliberate pass, never an unbounded auto-pass policy.
          while (!visibleDecision(state) || state.decision.id === previousDecisionId) {
            if (!await waitForNext()) throw new ToolError('timeout', 'The priority decision did not arrive.');
            state = await stateForStep();
          }
          const decision = state.decision;
          const choice = decision.choices.find((item) => item.type === 'pass');
          if (decision.kind !== 'priority' || state.priority !== 'self' || !choice || pendingIntention() || state.stop) {
            throw new ToolError('response_available', 'Yield requires your ordinary priority decision.');
          }
          await submit({ gameId: sequence.gameId, cursor: state.cursor, decisionId: decision.id,
            choiceId: choice.id, idempotencyKey: `${sequence.id}:yield:${sequence.completedSteps}` });
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
          if (visibleDecision(observed) && observed.decision.id !== decision.id && observed.decision.kind !== 'priority' && !nextPredeterminedAnswer(observed)) {
            throw new ToolError('response_available', 'A mandatory prompt needs a fresh decision.');
          }
          await stateForStep();
        } else if (advancingOwnTurn || step.kind === 'pass_to_boundary') {
          if (advancingOwnTurn && (!initialEvidenceValid || !ownPlayerId || !activeTurnPlayerId || !Number.isSafeInteger(turn))) {
            throw new ToolError('evidence_unavailable', 'Advancing across turns requires current public action evidence and exact player IDs.');
          }
          const handBeforePass = new Set((state.ownHand ?? []).map((card) => card.id ?? card.cardId));
          const observedDraw = (view) => view.sequenceEvidence?.informationRevision > informationRevision
            && view.ownHand?.some((card) => {
              const id = card.id ?? card.cardId;
              return id && !handBeforePass.has(id);
            });
          const inspectEndpoint = (view) => {
            if (step.kind === 'advance_to_own_turn') return nextOwnTurn(view) ? 'reached' : null;
            if (step.destination === 'current_turn') return view.turn !== turn ? 'skipped' : reaches(view, step) ? 'reached' : null;
            if (step.destination === 'end_step') {
              if (view.turn !== turn || view.step === 'CLEANUP') return 'skipped';
              return view.step === 'END_TURN' ? 'reached' : null;
            }
            if (step.destination === 'my_upkeep' && nextOwnTurn(view) && view.step === 'UPKEEP') return 'reached';
            if (step.destination === 'my_draw' && targetsThisDraw && view.turn !== turn) return 'skipped';
            if (atOrAfterOwnDraw(view)) return step.destination === 'my_draw' && observedDraw(view) ? 'reached' : 'skipped';
            return null;
          };
          const readyEndpoint = (view) => {
            const endpoint = inspectEndpoint(view);
            if (!endpoint) return null;
            if (step.kind === 'advance_to_own_turn') return endpoint;
            const handoff = step.destination === 'current_turn' && step.priority && step.priority !== 'self';
            if (endpoint === 'reached' && pendingIntention()) return null;
            return observable(view) || handoff ? endpoint : null;
          };
          for (;;) {
            state = await stateForStep();
            const endpoint = readyEndpoint(state);
            if (endpoint) {
              if (requestedPassBoundary) recordDestination(state);
              if (endpoint === 'skipped') throw new ToolError('destination_skipped', 'The engine passed the requested window; inspect the actual decision before continuing.');
              break;
            }
            if (!observable(state)) {
              if (!await waitForState((updated) => observable(updated) || (readyEndpoint(updated) ? updated : null))) {
                throw new ToolError('timeout', 'The requested destination did not arrive within the bounded wait.');
              }
              continue;
            }
            if (sequence.observedNewInformation) throw new ToolError('new_information', 'New information is available. Inspect the current decision before continuing.');
            const choice = state.decision.choices.find((item) => item.type === 'pass');
            if (state.decision.kind !== 'priority' || state.priority !== 'self' || !choice || pendingIntention() || state.stop
              || (!step.skipOptionalResponses && state.decision.choices.some((item) => item.type !== 'pass' && !plainManaChoice(item)))) {
              throw new ToolError('response_available', 'A currently legal play or mandatory choice needs your decision before advancing.');
            }
            if (++passCount > 80) throw new ToolError('pass_limit', 'The advance reached its priority window limit.');
            await submit({ gameId: sequence.gameId, cursor: state.cursor, decisionId: state.decision.id,
              choiceId: choice.id, idempotencyKey: `${sequence.id}:advance:${passCount}` });
            sequence.appliedDecisions++;
            previousDecisionId = state.decision.id;
          }
        } else if (step.kind === 'pass_until') {
          const destinationReached = (view) => reaches(view, step) && !pendingIntention()
            && (!autoAdvance || step.step || step.phase || visibleDecision(view) && view.decision.id !== previousDecisionId);
          for (;;) {
            state = await stateForStep();
            // A requested combat declaration is itself the destination, not an unknown choice to answer.
            if ((step.step || step.phase) && destinationReached(state)) break;
            if (visibleDecision(state) && state.decision.id !== previousDecisionId && state.decision.kind !== 'priority') {
              if (nextPredeterminedAnswer(state)) break;
              throw new ToolError('response_available', 'An unplanned mandatory choice needs a fresh decision.');
            }
            if (destinationReached(state)) break;
            if (!visibleDecision(state) || state.decision.id === previousDecisionId) {
              const observed = await waitForState((updated) => destinationReached(updated) ? updated : observable(updated));
              if (!observed) throw new ToolError('timeout', 'The destination did not arrive.');
              continue;
            }
            const choice = state.decision.choices.find((item) => item.type === 'pass');
            if (!choice || state.decision.kind !== 'priority' || pendingCast || state.stop
              || (!step.skipOptionalResponses && state.decision.choices.some((item) => item.type !== 'pass' && (autoAdvance ? !plainManaChoice(item) : item.type !== 'manaAbility')))) {
              throw new ToolError('response_available', 'A new response or mandatory prompt needs a decision.');
            }
            if (++passCount > (autoAdvance ? 80 : 30)) throw new ToolError('pass_limit', 'The sequence reached its priority window limit.');
            await submit({
              gameId: sequence.gameId, cursor: state.cursor, decisionId: state.decision.id, choiceId: choice.id,
              idempotencyKey: `${sequence.id}:pass:${passCount}`,
            });
            sequence.appliedDecisions++;
            previousDecisionId = state.decision.id;
          }
          recordDestination(state);
        } else if (step.kind === 'observe_next') {
          if (!await waitForNext()) throw new ToolError('timeout', 'The next actionable state did not arrive within the bounded wait.');
        } else if (step.kind === 'reevaluate') {
          throw new ToolError('reevaluation_required', 'The terminal intention resolved. Inspect its actual outcome and current legal choices before continuing.');
        }
        sequence.completedSteps++;
        sequence.cursor = this.snapshot().cursor;
        // An engine response may publish a stack change before its ACK returns.
        // Preserve accepted-action counters, but never report that abort as success.
        signal.throwIfAborted();
      }
      requireSettledCombat();
      sequence.status = 'completed';
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error;
      sequence.status = reason?.code === 'cancelled' ? 'cancelled' : 'interrupted';
      sequence.reason = reason?.code ?? 'action_failed';
      sequence.error = { code: sequence.reason, message: reason instanceof ToolError ? reason.message : 'The engine could not verify this step; inspect the fresh state before retrying.',
        stepIndex: sequence.completedSteps, actionIndex: sequence.actionIndex ?? null, expectedDecisionKind: steps[sequence.completedSteps]?.guard?.kind ?? null,
        actualDecisionKind: this.snapshot().decision?.kind ?? null,
        mismatchedGuardFields: Object.entries(steps[sequence.completedSteps]?.guard ?? {}).filter(([key, value]) => value !== undefined
          && value !== (key === 'kind' ? this.snapshot().decision?.kind : key === 'instruction' ? this.snapshot().decision?.instruction : this.snapshot()[key])).map(([key]) => key) };
      sequence.cursor = this.snapshot().cursor;
    } finally {
      unwatch();
      if (this.#current === sequence) this.#current = null;
      for (const finish of sequence.finishListeners) finish();
    }
  }
}

function maxHold(state) {
  const idle = state.timing?.inactivity;
  let cap = idle?.status === 'disabled' ? 1000
    : idle?.status === 'running' && Number.isFinite(idle.deadlineEpochMs)
      ? Math.min(1000, Math.max(0, idle.deadlineEpochMs - Date.now() - 1000)) : 250;
  // This is a separate cumulative match clock, never an inactivity deadline.
  if (Number.isFinite(state.secondsRemaining)) cap = Math.min(cap, Math.max(0, state.secondsRemaining * 1000 - 1000));
  return cap;
}
