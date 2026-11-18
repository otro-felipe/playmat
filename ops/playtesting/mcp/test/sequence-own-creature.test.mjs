import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { GameSeat } from '../src/game-seat.mjs';

const land = { id: 'mountain', cardId: 'mountain', name: 'Mountain', types: ['LAND'], tapped: false };
const swiftspear = { id: 'swift', cardId: 'swift', name: 'Monastery Swiftspear', types: ['CREATURE'] };
const pass = { id: 'pass', type: 'pass' };
const priority = (id, choices = []) => ({ id, kind: 'priority', choices: [pass, ...choices] });
const evidence = (resolutions = {}, revision = 0, rivalActions = 0) => ({ epoch: 'creature-feed', publicActions: { me: 0, rival: rivalActions }, resolutions, resolutionRevision: revision });

async function line(t, variant) {
  let state = { gameId: 'own-creature', status: 'active', epoch: 1, cursor: 1, turn: 1, activePlayer: 'Pilot', activePlayerId: 'me', priority: 'self', phase: 'PRECOMBAT_MAIN', step: 'PRECOMBAT_MAIN', stack: [], ownHand: [land, swiftspear],
    players: [{ id: 'me', yourSeat: true, battlefield: [], manaPool: {} }, { id: 'rival', life: 20, battlefield: [] }], sequenceEvidence: evidence(), decision: priority('land', [{ id: 'play', card: land }]) };
  const listeners = new Set(), applied = [];
  const update = (change) => { state = { ...state, ...change, cursor: state.cursor + 1 }; for (const fn of [...listeners]) fn(); };
  const seat = new GameSeat({ snapshot: () => state, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, respond: async (id, choice) => {
    applied.push([id, choice]);
    if (id === 'land') update({ ownHand: [swiftspear], players: [{ ...state.players[0], battlefield: [land] }, state.players[1]], decision: priority('cast', [{ id: 'cast', card: swiftspear }]) });
    else if (id === 'cast') update({ ownHand: [], stack: [{ ...swiftspear, id: 'stack-swift', controllerId: 'me' }], decision: { id: 'pay', kind: 'payMana', choices: [{ id: 'tap', type: 'manaAbility', card: land }] } });
    else if (id === 'pay') update({ players: [{ ...state.players[0], battlefield: [{ ...land, tapped: true }] }, state.players[1]], decision: priority('resolve') });
    else if (id === 'resolve') {
      update({ priority: 'opponent', decision: null });
      const ev = variant === 'missing-evidence' ? evidence() : evidence({ 'stack-swift': 1 }, 1, variant === 'rival-action' ? 1 : 0);
      // Permanent entry can publish while the resolving object still appears in the stack view.
      if (variant === 'mid-resolution') update({ sequenceEvidence: ev, players: [{ ...state.players[0], battlefield: [{ ...land, tapped: true }, swiftspear] }, state.players[1]] });
      update({ sequenceEvidence: ev, stack: variant === 'unexpected-trigger' ? [{ id: 'prowess-surprise', controllerId: 'me', abilityType: 'TRIGGERED_NONMANA' }] : variant === 'rival-spell' ? [{ id: 'rival-response', controllerId: 'rival' }] : [],
        players: [{ ...state.players[0], battlefield: [{ ...land, tapped: true }, swiftspear] }, state.players[1]], priority: 'self', decision: priority('combat') });
    } else if (id === 'combat') update({ phase: 'COMBAT', step: 'DECLARE_ATTACKERS', decision: { id: 'attack', kind: 'declareAttackers', choices: [{ id: 'attack-swift', card: swiftspear }] } });
    else if (id === 'attack') update({ decision: { id: 'finish', kind: 'declareAttackers', choices: [{ id: 'done' }] } });
    else if (id === 'finish') update({ decision: priority('after-attack'), combat: [{ attackers: [{ ...swiftspear, controllerId: 'me' }], blockers: [] }] });
    else assert.fail(`Unexpected action ${id}`);
    return { submitted: true };
  } });
  t.after(() => seat.invalidate());
  const started = seat.startSequence({ gameId: state.gameId, cursor: 1, steps: [
    { kind: 'answer', choiceId: 'play', guard: { kind: 'priority', step: 'PRECOMBAT_MAIN' } },
    { kind: 'answer', choiceId: 'cast', guard: { kind: 'priority', step: 'PRECOMBAT_MAIN' }, expectCast: true },
    { kind: 'answer', choiceId: 'tap', guard: { kind: 'payMana', step: 'PRECOMBAT_MAIN' } },
    { kind: 'pass_until', stackEmpty: true, priority: 'self', allowPlannedResolutions: true },
    { kind: 'pass_until', step: 'DECLARE_ATTACKERS' },
    { kind: 'answer', select: { cardId: 'swift', zone: 'battlefield' }, guard: { kind: 'declareAttackers', step: 'DECLARE_ATTACKERS' } },
    { kind: 'answer', choiceId: 'done', guard: { kind: 'declareAttackers', step: 'DECLARE_ATTACKERS' } },
  ] }, async () => true);
  for (let i = 0; i < 100; i++) {
    const result = seat.sequenceStatus({ gameId: state.gameId, sequenceId: started.sequenceId });
    if (result.status !== 'running') return { result, applied, state };
    await sleep(2);
  }
  assert.fail('The creature line must terminate');
}

for (const variant of ['normal', 'mid-resolution']) test(`[PM-AC-09-CREATURE] declared Swiftspear resolves and continues from land/payment through attack: ${variant}`, async (t) => {
  const { result, applied, state } = await line(t, variant);
  assert.equal(result.status, 'completed');
  assert.equal(result.completedSteps, 7);
  assert.deepEqual(applied, [['land', 'play'], ['cast', 'cast'], ['pay', 'tap'], ['resolve', 'pass'], ['combat', 'pass'], ['attack', 'attack-swift'], ['finish', 'done']]);
  assert.equal(state.combat[0].attackers[0].name, 'Monastery Swiftspear');
  assert.equal(state.players[0].battlefield[0].tapped, true);
});
for (const variant of ['missing-evidence', 'rival-action', 'rival-spell', 'unexpected-trigger']) test(`[PM-AC-09-CREATURE] does not attack after ${variant}`, async (t) => {
  const { result, applied } = await line(t, variant);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.reason, variant === 'rival-action' ? 'opponent_action' : 'state_changed');
  assert.equal(result.appliedDecisions, 4);
  assert.equal(applied.length, 4);
});
