import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { GameSeat } from '../src/game-seat.mjs';

const pass = { id: 'pass', type: 'pass' };
const land = { id: 'land', type: 'object', label: 'Play Forest' };
const decision = (id, choices = [pass]) => ({ id, kind: 'priority', choices });

async function run({ initial = {}, updates = [], step = {} } = {}) {
  const listeners = new Set();
  const played = [];
  let state = { gameId: 'game', status: 'active', epoch: 1, cursor: 1, turn: 1, activePlayer: 'Opponent',
    step: 'POSTCOMBAT_MAIN', priority: 'self', stack: [], decision: decision('opening'), ...initial };
  const engine = {
    snapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    respond: async (id, choice) => {
      played.push({ id, choice });
      const update = updates.shift();
      assert.ok(update, 'Every submitted choice must have an expected state transition');
      state = { ...state, ...update, cursor: state.cursor + 1 };
      for (const listener of listeners) listener();
      return { submitted: true };
    },
  };
  const seat = new GameSeat(engine);
  const plan = seat.startSequence({ gameId: 'game', cursor: 1,
    steps: [{ kind: 'pass_until', step: 'END_TURN', ...step }] }, async () => true);
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = seat.sequenceStatus({ gameId: 'game', sequenceId: plan.sequenceId });
    if (result.status !== 'running') return { result, played, state };
    await sleep(5);
  }
  seat.cancelSequence({ gameId: 'game', sequenceId: plan.sequenceId });
  assert.fail('The pass sequence did not terminate');
}

for (const boundary of [
  { turn: 2, activePlayer: 'Pilot', step: 'PRECOMBAT_MAIN', decision: decision('own-main', [pass, land]) },
  { activePlayer: 'Pilot', step: 'PRECOMBAT_MAIN', decision: decision('own-main', [pass, land]) },
  { turn: 2, step: 'END_TURN', decision: decision('later-end') },
  { turn: 2, activePlayer: 'Pilot', step: 'UNTAP', decision: null },
]) {
  test(`pass_until stops at a turn boundary before passing again: ${JSON.stringify(boundary)}`, async () => {
    const { result, played, state } = await run({ updates: [boundary], step: { skipOptionalResponses: true } });
    assert.equal(result.status, 'interrupted');
    assert.equal(result.reason, 'turn_changed');
    assert.equal(result.completedSteps, 0);
    assert.equal(result.appliedDecisions, 1);
    assert.deepEqual(played, [{ id: 'opening', choice: 'pass' }]);
    assert.equal(state.decision?.id, boundary.decision?.id);
  });
}

test('a land choice stops ordinary passing in your own main phase', async () => {
  const { result, played } = await run({ initial: { activePlayer: 'Pilot', step: 'PRECOMBAT_MAIN', decision: decision('land-drop', [pass, land]) } });
  assert.equal(result.reason, 'response_available');
  assert.deepEqual(played, []);
});

test('an already matching END_TURN completes without submitting a pass', async () => {
  const { result, played } = await run({ initial: { step: 'END_TURN' } });
  assert.equal(result.status, 'completed');
  assert.equal(result.completedSteps, 1);
  assert.deepEqual(played, []);
});

test('ordinary passes reach the end step within the observed turn', async () => {
  const { result, played } = await run({ updates: [{ step: 'END_TURN', decision: decision('end') }] });
  assert.equal(result.status, 'completed');
  assert.equal(result.appliedDecisions, 1);
  assert.deepEqual(played, [{ id: 'opening', choice: 'pass' }]);
});

test('explicit optional-play skipping remains supported within the observed turn', async () => {
  const { result, played } = await run({
    initial: { activePlayer: 'Pilot', step: 'PRECOMBAT_MAIN', decision: decision('land-drop', [pass, land]) },
    updates: [{ step: 'END_TURN', decision: decision('end') }], step: { skipOptionalResponses: true },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(played, [{ id: 'land-drop', choice: 'pass' }]);
});
