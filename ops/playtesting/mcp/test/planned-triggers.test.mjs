import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { GameSeat } from '../src/game-seat.mjs';
import { visibleAgentGame } from '../dist/engine-core.mjs';

const source = { id: 'our-source', cardId: 'source-card', name: 'Our trigger source', controllerId: 'self', types: ['CREATURE'] };
const trigger = { id: 'trigger-1', name: 'Ability', controllerId: 'self', abilityType: 'TRIGGERED_NONMANA', sourceId: source.id, abilityText: 'Whenever you cast a spell, target creature gets +1/+1.' };
const expectation = { sourceId: source.id, abilityText: trigger.abilityText };
const spell = { id: 'our-spell', cardId: 'our-spell', name: 'Our spell', types: ['INSTANT'] };
const target = { id: 'our-target', cardId: 'target-card', name: 'Our creature', controllerId: 'self' };
async function run(t, variant = 'normal') {
  let state = { gameId: 'g', status: 'active', epoch: 1, cursor: 1, turn: 1, activePlayer: 'self', priority: 'self', step: 'PRECOMBAT_MAIN',
    stack: [], ownHand: variant === 'simultaneous' ? [spell] : [], players: [{ id: 'self', yourSeat: true, battlefield: [source, target] }],
    decision: { id: 'start', kind: 'priority', choices: [{ id: 'act', type: 'object', card: variant === 'simultaneous' ? spell : source }] } };
  const listeners = new Set(), applied = [];
  const update = (data) => { state = { ...state, ...data, cursor: state.cursor + 1 }; for (const fn of [...listeners]) fn(); };
  const seat = new GameSeat({ snapshot: () => state, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    respond: async (id, choice) => {
      applied.push(choice);
      if (id === 'start') {
        const stack = variant === 'before-stack' ? []
          : variant === 'simultaneous' ? [{ ...spell, id: 'spell-stack', controllerId: 'self' }, trigger]
          : variant === 'opponent' ? [{ ...trigger, controllerId: 'enemy' }]
          : variant === 'text' ? [{ ...trigger, abilityText: 'A different ability' }]
          : variant === 'extra' ? [trigger, { id: 'enemy-spell', controllerId: 'enemy', name: 'Response' }]
          : variant === 'count' ? [trigger, { ...trigger, id: 'trigger-2' }] : [trigger];
        update({ stack, decision: { id: 'target', kind: 'target', instruction: variant === 'instruction' ? 'Sacrifice a creature' : 'Choose target creature',
          choices: variant === 'illegal' ? [] : [{ id: 'target-choice', type: 'object', card: target }] } });
      }
      if (id === 'target' && variant === 'before-stack') update({ stack: [trigger] });
      return { submitted: true };
    } });
  const plan = seat.startSequence({ gameId: 'g', cursor: 1, steps: [
    { kind: 'answer', decisionId: 'start', choiceId: 'act', expectCast: variant === 'simultaneous', expectTriggers: variant === 'ambiguous' ? [expectation, expectation] : [expectation] },
    { kind: 'answer', guard: { kind: 'target', step: 'PRECOMBAT_MAIN', instruction: 'Choose target creature' }, select: { cardId: target.id, zone: 'battlefield' } },
  ] }, async () => true);
  t.after(() => seat.cancelSequence({ gameId: 'g', sequenceId: plan.sequenceId }));
  for (let i = 0; i < 40; i++) {
    const result = seat.sequenceStatus({ gameId: 'g', sequenceId: plan.sequenceId });
    if (result.status !== 'running') return { result, applied };
    await sleep(5);
  }
  assert.fail('Plan did not terminate');
}
for (const variant of ['normal', 'simultaneous', 'before-stack', 'opponent', 'text', 'extra', 'count', 'ambiguous', 'illegal', 'instruction']) {
  test(`predeclared own trigger with guarded target: ${variant}`, async (t) => {
    const { result, applied } = await run(t, variant);
    if (['normal', 'simultaneous', 'before-stack'].includes(variant)) {
      assert.equal(result.status, 'completed'); assert.deepEqual(applied, ['act', 'target-choice']);
    } else {
      assert.equal(result.status, 'interrupted');
      assert.equal(result.reason, variant === 'ambiguous' ? 'ambiguous_trigger_expectation' : variant === 'illegal' ? 'illegal_choice' : 'state_changed');
      assert.deepEqual(applied, variant === 'ambiguous' ? [] : ['act']);
    }
  });
}
test('public trigger projection exposes identity without copying hidden source details', () => {
  const state = visibleAgentGame({ playerId: 'self', view: { stack: { 'trigger-1': {
    id: 'trigger-1', controllerId: 'self', name: 'Ability', abilityType: 'TRIGGERED_NONMANA',
    sourceCard: { id: 'public-source', faceDown: true, name: 'Hidden identity', rules: ['private text'] },
    rules: ['<b>Public trigger text</b>'],
  } } } });
  assert.equal(state.stack[0].sourceId, 'public-source');
  assert.equal(state.stack[0].abilityText, 'Public trigger text');
  assert.equal(state.stack[0].controllerId, 'self');
  assert.equal(JSON.stringify(state).includes('Hidden identity'), false);
  assert.equal(JSON.stringify(state).includes('private text'), false);
});


test('an unexpected trigger during the final accepted action reports interruption, not completion', async () => {
  let state = { gameId: 'g', status: 'active', epoch: 1, cursor: 1, turn: 1, activePlayer: 'self', priority: 'self',
    stack: [], ownHand: [], players: [{ id: 'self', yourSeat: true, battlefield: [source] }],
    decision: { id: 'd', kind: 'priority', choices: [{ id: 'action', card: source }] } };
  const listeners = new Set();
  const seat = new GameSeat({ snapshot: () => state, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    respond: async () => {
      state = { ...state, cursor: 2, stack: [{ ...trigger, controllerId: 'opponent' }] };
      for (const fn of listeners) fn();
      return { submitted: true };
    } });
  const plan = seat.startSequence({ gameId: 'g', cursor: 1, steps: [
    { kind: 'answer', decisionId: 'd', choiceId: 'action', expectTriggers: [expectation] },
  ] }, async () => true);
  await sleep(5);
  const result = seat.sequenceStatus({ gameId: 'g', sequenceId: plan.sequenceId });
  assert.equal(result.status, 'interrupted'); assert.equal(result.reason, 'state_changed');
  assert.equal(result.appliedDecisions, 1); assert.equal(result.completedSteps, 1);
});
