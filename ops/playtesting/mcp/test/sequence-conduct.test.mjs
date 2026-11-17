import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { GameSeat } from '../src/game-seat.mjs';
const pass = { id: 'pass', type: 'pass' };
const decision = (id, choices = [pass]) => ({ id, kind: 'priority', choices });
const evidence = (actions = 0) => ({ epoch: 'public-feed', publicActions: { us: 0, them: actions }, resolutions: {}, resolutionRevision: 0 });
async function scenario(t, { initial = {}, updates = [], steps = [{ kind: 'advance_to_own_turn' }], options } = {}) {
  const listeners = new Set(), submitted = [];
  let state = { gameId: 'conduct', status: 'active', epoch: 1, cursor: 1, turn: 4, activePlayer: 'Us', activePlayerId: 'us',
    priority: 'self', step: 'END_TURN', stack: [], players: [{ id: 'us', yourSeat: true }, { id: 'them', handCount: 3 }],
    sequenceEvidence: evidence(), decision: decision('our-end'), ...initial };
  const seat = new GameSeat({ snapshot: () => state, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    respond: async (id, choice) => {
      submitted.push([id, choice]);
      assert.ok(updates.length, 'Every automatic answer must correspond to an independently specified engine window');
      state = { ...state, ...updates.shift(), cursor: state.cursor + 1 };
      for (const fn of [...listeners]) fn();
      return { submitted: true };
    } }, options);
  t.after(() => seat.invalidate());
  const started = seat.startSequence({ gameId: state.gameId, cursor: 1, steps }, async () => true);
  for (let i = 0; i < 150; i++) {
    const status = seat.sequenceStatus({ gameId: state.gameId, sequenceId: started.sequenceId });
    if (status.status !== 'running') return { status, state, submitted };
    await sleep(3);
  }
  assert.fail('Conduct must terminate within its explicit bounded scenario');
}
test('advance skips only empty windows, including an automatic rival draw, and leaves our next land decision untouched', async (t) => {
  const ownLand = decision('our-new-main', [pass, { id: 'land', type: 'object', card: { name: 'Forest', types: ['LAND'] } }]);
  const { status, state, submitted } = await scenario(t, { updates: [
    { turn: 5, activePlayer: 'Them', activePlayerId: 'them', step: 'UPKEEP', decision: decision('their-upkeep') },
    { step: 'DRAW', players: [{ id: 'us', yourSeat: true }, { id: 'them', handCount: 4 }], decision: decision('their-draw') },
    { turn: 6, activePlayer: 'Us', activePlayerId: 'us', step: 'PRECOMBAT_MAIN', decision: ownLand },
  ] });
  assert.equal(status.status, 'completed');
  assert.equal(status.appliedDecisions, 3);
  assert.equal(state.decision.id, 'our-new-main');
  assert.deepEqual(submitted, [['our-end', 'pass'], ['their-upkeep', 'pass'], ['their-draw', 'pass']]);
});
for (const [label, choice] of [
  ['land', { id: 'land', type: 'object' }],
  ['free spell with no mana', { id: 'free', type: 'object', card: { manaCost: ['{0}'] } }],
  ['alternate-cost spell', { id: 'alternate', type: 'object' }],
  ['activated ability', { id: 'ability', type: 'object' }],
  ['mana ability with a useful side effect', { id: 'mana-life', type: 'manaAbility', card: { rules: ['{T}: Add {G}. You gain 1 life.'] } }],
  ['unknown mana ability', { id: 'unknown', type: 'manaAbility' }],
]) test(`advance never assumes no useful play from zero mana: ${label}`, async (t) => {
  const { status, submitted } = await scenario(t, { initial: { secondsRemaining: null, decision: decision('choice', [pass, choice]) } });
  assert.equal(status.reason, 'response_available'); assert.equal(submitted.length, 0);
});
test('advance may decline plain tap-for-mana when it is the only optional choice', async (t) => {
  const { status, submitted } = await scenario(t, { initial: { decision: decision('mana', [pass, { id: 'mana', type: 'manaAbility', card: { rules: ['{T}: Add {G}.'] } }]) },
    updates: [{ turn: 6, activePlayerId: 'us', activePlayer: 'Us', decision: decision('next-own') }] });
  assert.equal(status.status, 'completed'); assert.equal(submitted.length, 1);
});
test('advance never answers a mandatory blocking/target decision', async (t) => {
  const { status, submitted } = await scenario(t, { initial: { decision: { id: 'blocks', kind: 'blockers', choices: [pass] } } });
  assert.equal(status.reason, 'response_available'); assert.equal(submitted.length, 0);
});
test('advance stops for a real rival action even without a new stack object', async (t) => {
  const { status, submitted } = await scenario(t, { updates: [{ sequenceEvidence: evidence(1), decision: decision('after-rival-mana') }] });
  assert.equal(status.reason, 'opponent_action'); assert.equal(status.appliedDecisions, 1); assert.equal(submitted.length, 1);
});
test('advance cannot cross turns without public causal evidence', async (t) => {
  const { status, submitted } = await scenario(t, { initial: { sequenceEvidence: null } });
  assert.equal(status.reason, 'evidence_unavailable'); assert.equal(submitted.length, 0);
});
test('brief pace keeps an ordinary choice current and caps unknown inactivity timing', async (t) => {
  const { status, submitted } = await scenario(t, { steps: [{ kind: 'pace', delayMs: 1000 }] });
  assert.equal(status.status, 'completed'); assert.equal(status.effectiveDelayMs, 250); assert.equal(submitted.length, 0);
});
test('brief pace refuses a mandatory prompt', async (t) => {
  const { status, submitted } = await scenario(t, { initial: { decision: { id: 'target', kind: 'target', choices: [pass] } }, steps: [{ kind: 'pace', delayMs: 1 }] });
  assert.equal(status.reason, 'response_available'); assert.equal(submitted.length, 0);
});
