import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { GameSeat } from '../src/game-seat.mjs';

async function selectCard({ duplicate = false, select, illegal = false, kind = 'target' }) {
  const rival = { id: 'rival-cub', cardId: 'rival-card', name: 'Badgermole Cub' };
  const own = { id: 'own-cub', cardId: 'own-card', name: 'Badgermole Cub' };
  const choices = [{ id: 'target-rival', type: 'object', card: rival },
    ...(duplicate ? [{ id: 'target-own', type: 'object', card: own }] : [])];
  const state = { gameId: 'g', cursor: 1, status: 'active', epoch: 1, turn: 1, activePlayer: 'self',
    step: 'PRECOMBAT_MAIN', priority: 'self', stack: [], ownHand: [],
    players: [{ id: 'self', yourSeat: true, battlefield: duplicate ? [own] : [] },
      { id: 'rival', battlefield: [rival] }],
    decision: { id: 'd', kind, choices: illegal ? [] : choices } };
  const applied = [];
  const seat = new GameSeat({ snapshot: () => state, subscribe: () => () => {},
    respond: async (_id, choice) => { applied.push(choice); return { submitted: true }; } });
  const plan = seat.startSequence({ gameId: 'g', cursor: 1, steps: [
    { kind: 'answer', decisionId: 'd', select },
  ] }, async () => true);
  for (let i = 0; i < 20; i++) {
    const result = seat.sequenceStatus({ gameId: 'g', sequenceId: plan.sequenceId });
    if (result.status !== 'running') return { result, applied };
    await sleep(5);
  }
  assert.fail('Sequence did not finish');
}

test('battlefield selector can target an opponent permanent offered by the engine', async () => {
  const { result, applied } = await selectCard({ select: { cardName: 'Badgermole Cub', zone: 'battlefield' } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(applied, ['target-rival']);
});
test('same-name choices across both battlefields are ambiguous, never silently own', async () => {
  const { result, applied } = await selectCard({ duplicate: true, select: { cardName: 'Badgermole Cub', zone: 'battlefield' } });
  assert.equal(result.reason, 'ambiguous_choice');
  assert.deepEqual(applied, []);
});
for (const [id, expected] of [['rival-cub', 'target-rival'], ['own-cub', 'target-own']]) {
  test(`physical selection disambiguates ${id}`, async () => {
    const { result, applied } = await selectCard({ duplicate: true, select: { cardId: id, zone: 'battlefield' } });
    assert.equal(result.status, 'completed');
    assert.deepEqual(applied, [expected]);
  });
}
test('visible opponent permanent not in legal choices is never actionable', async () => {
  const { result, applied } = await selectCard({ illegal: true, select: { cardName: 'Badgermole Cub', zone: 'battlefield' } });
  assert.equal(result.reason, 'illegal_choice');
  assert.deepEqual(applied, []);
});
test('hand selector does not select a public battlefield card', async () => {
  const { result, applied } = await selectCard({ select: { cardName: 'Badgermole Cub', zone: 'hand' } });
  assert.equal(result.reason, 'illegal_choice');
  assert.deepEqual(applied, []);
});
