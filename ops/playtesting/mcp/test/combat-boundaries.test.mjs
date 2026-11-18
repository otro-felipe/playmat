import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { GameSeat } from '../src/game-seat.mjs';
import { visibleAgentGame } from '../dist/engine-core.mjs';

const pass = { id: 'pass', type: 'pass' };
const priority = (id) => ({ id, kind: 'priority', choices: [pass] });
const evidence = (hit = false) => ({ epoch: 'combat-boundary', publicActions: { me: 0, rival: 0 },
  resolutions: {}, resolutionRevision: 0, informationRevision: 0, combatRevision: hit ? 1 : 0,
  combatDamage: hit ? [{ revision: 1, sourceId: 'attacker', controllerId: 'me', targetId: 'rival', amount: 3 }] : [] });

async function settled(seat, started) {
  for (let n = 0; n < 100; n++) {
    const result = seat.sequenceStatus({ gameId: 'boundary', sequenceId: started.sequenceId });
    if (result.status !== 'running') return result;
    await sleep(2);
  }
  assert.fail('The boundary must return control in bounded time');
}

for (const variant of ['normal', 'delayed-normal', 'infect', 'toxic', 'delayed-toxic', 'no-life-change', 'no-life-change-next-answer']) {
  test(`combat credit requires exact life-only effects before continuing: ${variant}`, async (t) => {
    let state = { gameId: 'boundary', status: 'active', epoch: 1, cursor: 1, turn: 3, activePlayer: 'Pilot', activePlayerId: 'me',
      step: 'COMBAT_DAMAGE', priority: 'self', ownHand: [], stack: [], sequenceEvidence: evidence(), decision: priority('damage'),
      combat: [{ attackers: [{ id: 'attacker', controllerId: 'me' }], blockers: [] }],
      players: [{ id: 'me', yourSeat: true, battlefield: [{ id: 'attacker', controllerId: 'me' }] }, { id: 'rival', life: 20, battlefield: [], counters: [] }] };
    const listeners = new Set(), applied = [];
    const update = (change) => { state = { ...state, ...change, cursor: state.cursor + 1 }; for (const listener of [...listeners]) listener(); };
    const seat = new GameSeat({ snapshot: () => state, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }, respond: async (id) => {
      applied.push(id);
      assert.equal(id, 'damage', 'The unresolved combat must not submit the following answer');
      if (variant === 'delayed-normal') {
        update({ sequenceEvidence: evidence(true), priority: 'opponent', decision: null });
        setTimeout(() => update({ step: 'POSTCOMBAT_MAIN', players: [state.players[0], { ...state.players[1], life: 17 }], priority: 'self', decision: priority('done') }), 2);
      } else {
        const life = ['infect', 'no-life-change', 'no-life-change-next-answer'].includes(variant) ? 20 : 17;
        const counters = ['infect', 'toxic'].includes(variant) ? [{ name: 'poison', count: 3 }] : [];
        update({ step: 'POSTCOMBAT_MAIN', players: [state.players[0], { ...state.players[1], life, counters }], sequenceEvidence: evidence(true), decision: priority('done') });
        if (variant === 'delayed-toxic') update({ players: [state.players[0], { ...state.players[1], counters: [{ name: 'poison', count: 1 }] }] });
      }
      return { submitted: true };
    } });
    t.after(() => seat.invalidate());
    const steps = [{ kind: 'pass_until', step: 'POSTCOMBAT_MAIN' }];
    if (variant === 'no-life-change-next-answer') steps.push({ kind: 'answer', choiceId: 'pass', guard: { kind: 'priority', step: 'POSTCOMBAT_MAIN' } });
    const started = seat.startSequence({ gameId: 'boundary', cursor: 1, allowPlannedCombatDamage: true, steps }, async () => true);
    const result = await settled(seat, started);
    if (['normal', 'delayed-normal'].includes(variant)) assert.equal(result.status, 'completed');
    else { assert.equal(result.status, 'interrupted'); assert.equal(result.reason, 'opponent_state_changed'); }
    assert.deepEqual(applied, ['damage']);
  });
}

test('safe turn advance still stops on a public poison change after matched combat damage', async (t) => {
  let state = { gameId: 'boundary', status: 'active', epoch: 1, cursor: 1, turn: 3, activePlayer: 'Pilot', activePlayerId: 'me', step: 'COMBAT_DAMAGE', priority: 'self', ownHand: [], stack: [],
    sequenceEvidence: evidence(), decision: priority('damage'), combat: [{ attackers: [{ id: 'attacker', controllerId: 'me' }], blockers: [] }],
    players: [{ id: 'me', yourSeat: true, battlefield: [{ id: 'attacker', controllerId: 'me' }] }, { id: 'rival', life: 20, battlefield: [], counters: [] }] };
  const listeners = new Set(), applied = [];
  const update = (change) => { state = { ...state, ...change, cursor: state.cursor + 1 }; for (const listener of [...listeners]) listener(); };
  const seat = new GameSeat({ snapshot: () => state, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }, respond: async (id) => {
    applied.push(id);
    assert.equal(id, 'damage', 'A counter change must interrupt before the next ordinary pass');
    update({ step: 'POSTCOMBAT_MAIN', sequenceEvidence: evidence(true), players: [state.players[0], { ...state.players[1], life: 17 }] });
    update({ players: [state.players[0], { ...state.players[1], counters: [{ name: 'poison', count: 1 }] }], decision: priority('done') });
    return { submitted: true };
  } });
  t.after(() => seat.invalidate());
  const result = await settled(seat, seat.startSequence({ gameId: 'boundary', cursor: 1, allowPlannedCombatDamage: true, steps: [{ kind: 'advance_to_own_turn' }] }, async () => true));
  assert.equal(result.status, 'interrupted'); assert.equal(result.reason, 'opponent_state_changed'); assert.deepEqual(applied, ['damage']);
});

for (const [step, activePlayerId] of [['POSTCOMBAT_MAIN', 'me'], ['END_TURN', 'me'], ['PRECOMBAT_MAIN', 'rival']]) {
  test(`an impossible attack cannot pass another window: ${step}/${activePlayerId}`, async (t) => {
    const state = { gameId: 'boundary', status: 'active', epoch: 1, cursor: 1, turn: 3, activePlayerId, step, priority: 'self', ownHand: [], stack: [], players: [{ id: 'me', yourSeat: true, battlefield: [] }, { id: 'rival', battlefield: [] }], sequenceEvidence: evidence(), decision: priority('keep-this-choice') };
    const applied = [];
    const seat = new GameSeat({ snapshot: () => state, subscribe: () => () => {}, respond: async () => { applied.push('pass'); throw Error('No ordinary pass is justified by this impossible attack'); } });
    t.after(() => seat.invalidate());
    const result = await settled(seat, seat.startTurn({ gameId: 'boundary', cursor: 1, actions: [{ kind: 'attack' }], finish: 'none' }, async () => true));
    assert.equal(result.status, 'interrupted'); assert.equal(result.reason, 'illegal_choice'); assert.deepEqual(applied, []);
  });
}

test('player counters use their public allowlisted representation', () => {
  const projected = visibleAgentGame({ playerId: 'me', view: { players: [{ playerId: 'rival', counters: [{ name: 'poison', count: 3, hidden: 'not-a-counter-field' }] }] } });
  assert.deepEqual(projected.players[0].counters, [{ name: 'poison', count: 3 }]);
  assert.equal(JSON.stringify(projected).includes('not-a-counter-field'), false);
});

for (const missedStep of ['POSTCOMBAT_MAIN', 'END_TURN']) {
  test(`an attack whose window disappears during implicit passing stops at ${missedStep}`, async (t) => {
    let state = { gameId: 'boundary', status: 'active', epoch: 1, cursor: 1, turn: 3, activePlayerId: 'me', step: 'PRECOMBAT_MAIN', priority: 'self', ownHand: [], stack: [], players: [{ id: 'me', yourSeat: true, battlefield: [] }, { id: 'rival', battlefield: [] }], sequenceEvidence: evidence(), decision: priority('pre') };
    const listeners = new Set(), applied = [];
    const seat = new GameSeat({ snapshot: () => state, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }, respond: async (id) => {
      applied.push(id);
      assert.equal(id, 'pre', 'The missed attack must not consume another priority window');
      state = { ...state, cursor: 2, step: missedStep, decision: priority('after-missed-attack') };
      for (const listener of [...listeners]) listener();
      return { submitted: true };
    } });
    t.after(() => seat.invalidate());
    const result = await settled(seat, seat.startTurn({ gameId: 'boundary', cursor: 1, actions: [{ kind: 'attack' }], finish: 'none' }, async () => true));
    assert.equal(result.status, 'interrupted'); assert.equal(result.reason, 'illegal_choice'); assert.deepEqual(applied, ['pre']);
  });
}
