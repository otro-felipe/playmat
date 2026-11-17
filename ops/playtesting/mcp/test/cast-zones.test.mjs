import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { GameSeat } from '../src/game-seat.mjs';

async function run(zone, { kind = 'priority', types = ['SORCERY'], unexpected = false, opponentOwned = false } = {}) {
  const card = { id: 'card', cardId: 'physical-card', name: "Wrenn's Resolve", types };
  const players = [{ id: 'self', yourSeat: true }, { id: 'opponent', yourSeat: false }];
  if (zone !== 'hand') players[opponentOwned ? 1 : 0][zone] = [card];
  let state = { gameId: 'game', status: 'active', epoch: 1, cursor: 1, turn: 1, activePlayer: 'Pilot',
    priority: 'self', step: 'PRECOMBAT_MAIN', stack: [], players, ownHand: zone === 'hand' ? [card] : [],
    decision: { id: 'cast', kind, choices: [{ id: 'cast-choice', type: 'object', card }] } };
  const listeners = new Set();
  const applied = [];
  const engine = {
    snapshot: () => state,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    respond: async (decisionId) => {
      applied.push(decisionId);
      if (decisionId === 'cast') {
        state = { ...state, cursor: 2, stack: [{ ...card, id: 'stack-item', controllerId: unexpected ? 'opponent' : 'self' }],
          decision: { id: 'payment', kind: 'payMana', choices: [{ id: 'mana', type: 'manaAbility' }] } };
        for (const fn of listeners) fn();
      }
      return { submitted: true };
    },
  };
  const seat = new GameSeat(engine);
  const plan = seat.startSequence({ gameId: 'game', cursor: 1, steps: [
    { kind: 'answer', decisionId: 'cast', choiceId: 'cast-choice', expectCast: true },
    { kind: 'answer', guard: { kind: 'payMana', step: 'PRECOMBAT_MAIN' }, choiceId: 'mana' },
  ] }, async () => true);
  for (let i = 0; i < 30; i++) {
    const result = seat.sequenceStatus({ gameId: 'game', sequenceId: plan.sequenceId });
    if (result.status !== 'running') return { result, applied };
    await sleep(5);
  }
  seat.cancelSequence({ gameId: 'game', sequenceId: plan.sequenceId });
  assert.fail('Sequence did not terminate');
}

for (const zone of ['hand', 'exile', 'graveyard']) {
  test(`expectCast accepts a visible legal spell from ${zone} and pays only for that spell`, async () => {
    const { result, applied } = await run(zone);
    assert.equal(result.status, 'completed');
    assert.deepEqual(applied, ['cast', 'payment']);
  });
}

test('a legal spell from opponent exile is controlled by the casting seat on the stack', async () => {
  const { result, applied } = await run('exile', { opponentOwned: true });
  assert.equal(result.status, 'completed');
  assert.deepEqual(applied, ['cast', 'payment']);
});
for (const [zone, options] of [['exile', { types: ['LAND'] }], ['exile', { kind: 'chooseAbility' }], ['battlefield', {}]]) {
  test(`rejects non-cast expectation: ${zone} ${JSON.stringify(options)}`, async () => {
    const { result, applied } = await run(zone, options);
    assert.equal(result.reason, 'bad_cast_expectation');
    assert.deepEqual(applied, []);
  });
}

test('casting from exile does not permit an unrelated controller on the stack', async () => {
  const { result, applied } = await run('exile', { unexpected: true });
  assert.equal(result.reason, 'state_changed');
  assert.deepEqual(applied, ['cast']);
});
