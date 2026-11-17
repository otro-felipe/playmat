import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drivePlanPeerOnce } from '../../product/sequence-driver.mjs';
const boundary = { gameId: 'isolated-game', turn: 9, activePlayerId: 'pilot' };
for (const [description, status, state, expectedPasses] of [
  ['completed plan while peer still has an old priority snapshot', 'completed', { ...boundary, step: 'POSTCOMBAT_MAIN' }, 0],
  ['background status not completed yet but destination already arrived', 'running', { ...boundary, step: 'END_TURN' }, 0],
  ['a later upkeep cannot receive a pass from the old plan', 'running', { ...boundary, turn: 10, activePlayerId: 'rival', step: 'UPKEEP' }, 0],
  ['an ordinary pre-destination priority window is still driven', 'running', { ...boundary, step: 'POSTCOMBAT_MAIN' }, 1],
]) test(`isolated sequence driver: ${description}`, async () => {
  const calls = [];
  const returned = await drivePlanPeerOnce({
    readStatus: async () => { calls.push('status'); return { status }; },
    readPeer: () => { calls.push('snapshot'); return state; },
    respondPeer: async () => { calls.push('pass'); }, boundary,
  });
  assert.equal(returned.status, status);
  assert.equal(calls[0], 'status');
  assert.equal(calls.filter(call => call === 'pass').length, expectedPasses);
});
