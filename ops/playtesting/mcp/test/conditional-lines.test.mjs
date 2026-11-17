import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { GameSeat } from '../src/game-seat.mjs';
const pass = { id: 'pass', type: 'pass' };
const spell = { id: 'card', cardId: 'physical', name: 'Spell', types: ['SORCERY'] };
const priority = (id, choices = [pass]) => ({ id, kind: 'priority', choices });
async function run(t, steps, { initial = {}, onRespond, seatOptions, responsePolicy = 'interrupt' } = {}) {
  let state = { gameId: 'g', status: 'active', epoch: 1, cursor: 1, turn: 1, activePlayer: 'self',
    priority: 'self', step: 'PRECOMBAT_MAIN', ownHand: [spell], players: [{ id: 'self', yourSeat: true }],
    stack: [], sequenceEvidence: { epoch: 'conditional-feed', publicActions: {}, resolutions: {}, resolutionRevision: 0 }, decision: priority('initial'), ...initial };
  const listeners = new Set(), timers = [], applied = [];
  const update = (data) => { state = { ...state, ...data, cursor: state.cursor + 1 }; for (const f of [...listeners]) f(); };
  const later = (data) => timers.push(setTimeout(() => update(data), 10));
  const seat = new GameSeat({ snapshot: () => state, subscribe: (f) => { listeners.add(f); return () => listeners.delete(f); },
    respond: async (id, choice) => { applied.push([id, choice]); await onRespond?.({ id, choice, update, later, state }); return { submitted: true }; } }, seatOptions);
  t.after(() => { timers.forEach(clearTimeout); });
  const started = seat.startSequence({ gameId: 'g', cursor: 1, steps }, async () => true, responsePolicy);
  for (let i = 0; i < 100; i++) {
    const result = seat.sequenceStatus({ gameId: 'g', sequenceId: started.sequenceId });
    if (result.status !== 'running') return { result, applied, state };
    await sleep(5);
  }
  seat.cancelSequence({ gameId: 'g', sequenceId: started.sequenceId });
  assert.fail('Plan did not terminate');
}
test('yield waits through delayed ACK state and returns at a new self decision, one pass only', async (t) => {
  const { result, applied, state } = await run(t, [{ kind: 'yield_priority' }], {
    onRespond: ({ later }) => later({ decision: priority('returned') }),
  });
  assert.equal(result.status, 'completed'); assert.equal(state.decision.id, 'returned');
  assert.deepEqual(applied, [['initial', 'pass']]);
});
test('yield can stop at opponent handoff without passing again', async (t) => {
  const { result, applied } = await run(t, [{ kind: 'yield_priority', until: 'opponent' }], {
    onRespond: ({ later }) => later({ priority: 'opponent', decision: { kind: 'waiting' } }),
  });
  assert.equal(result.status, 'completed'); assert.equal(applied.length, 1);
});
const cast = { kind: 'answer', choiceId: 'cast', guard: { kind: 'priority', priority: 'self' }, expectCast: true };
const pay = { kind: 'answer', choiceId: 'mana', guard: { kind: 'payMana', step: 'PRECOMBAT_MAIN' } };
const initial = { decision: priority('cast', [{ id: 'cast', type: 'object', card: spell }, pass]) };
for (const variant of ['normal', 'auto', 'response', 'default', 'turn', 'mandatory', 'draw']) {
  test(`cast, pay, resolve, continue conditional line: ${variant}`, async (t) => {
    const { result, applied } = await run(t, [cast, pay,
      variant === 'auto'
        ? { kind: 'pass_until', stackEmpty: true, priority: 'self', allowPlannedResolutions: true }
        : { kind: 'yield_priority', allowPlannedResolutions: variant !== 'default' },
      { kind: 'answer', choiceId: 'followup', guard: { kind: 'priority', priority: 'self' } },
    ], { initial, onRespond: ({ id, update, later }) => {
      if (id === 'cast') update({ stack: [{ ...spell, id: 'stack-spell', controllerId: 'self' }],
        decision: { id: 'pay', kind: 'payMana', choices: [{ id: 'mana' }] } });
      if (id === 'pay') later({ decision: priority('yield') });
      if (id === 'yield') {
        update({ priority: 'opponent', decision: { kind: 'waiting' } });
        if (variant === 'response') later({ stack: [{ ...spell, id: 'stack-spell', controllerId: 'self' }, { id: 'enemy-spell', controllerId: 'enemy' }] });
        else if (variant === 'turn') later({ turn: 2 });
        else later({ stack: [], sequenceEvidence: { epoch: 'conditional-feed', publicActions: {}, resolutions: { 'stack-spell': 1 }, resolutionRevision: 1 }, ...(variant === 'draw' ? { ownHand: [{ id: 'new-draw', cardId: 'new-draw' }] } : {}), priority: 'self', decision: variant === 'mandatory'
          ? { id: 'mandatory', kind: 'target', choices: [{ id: 'followup' }] }
          : priority('follow', [{ id: 'followup', type: 'object' }, pass]) });
      }
    } });
    assert.equal(result.status, ['normal', 'auto'].includes(variant) ? 'completed' : 'interrupted');
    assert.equal(applied.length, ['normal', 'auto'].includes(variant) ? 4 : 3);
    if (!['normal', 'auto'].includes(variant)) assert.equal(result.reason, variant === 'turn' ? 'turn_changed' : variant === 'draw' ? 'new_information' : variant === 'mandatory' ? 'response_available' : 'state_changed');
  });
}
test('auto-pass stops for zero-mana legal plays instead of guessing resources', async (t) => {
  const { result, applied } = await run(t, [{ kind: 'pass_until', step: 'END_TURN' }], {
    initial: { decision: priority('free-spell', [pass, { id: 'free', type: 'object' }]) },
  });
  assert.equal(result.reason, 'response_available'); assert.deepEqual(applied, []);
});
test('auto-pass advances pass-only and mana-only windows within same turn', async (t) => {
  const { result, applied } = await run(t, [{ kind: 'pass_until', step: 'END_TURN' }], {
    initial: { decision: priority('mana-only', [pass, { id: 'mana', type: 'manaAbility' }]) },
    onRespond: ({ update }) => update({ step: 'END_TURN', decision: priority('end') }),
  });
  assert.equal(result.status, 'completed'); assert.equal(applied.length, 1);
});


test('guarded pass interrupts on an opponent mana tap without a new stack object', async (t) => {
  const players = [{ id: 'self', yourSeat: true }, { id: 'opponent', battlefield: [{ id: 'land', tapped: false }] }];
  const { result, applied } = await run(t, [{ kind: 'pass_until', step: 'END_TURN', skipOptionalResponses: true }], {
    initial: { players }, onRespond: ({ update }) => update({ players: [players[0], { ...players[1], battlefield: [{ id: 'land', tapped: true }] }] }),
  });
  assert.equal(result.reason, 'opponent_state_changed'); assert.equal(applied.length, 1);
});
test('intentional standalone pass continues past a response but stops at its exact destination', async (t) => {
  let count = 0;
  const { result, applied } = await run(t, [{ kind: 'pass_until', step: 'END_TURN', skipOptionalResponses: true }], {
    responsePolicy: 'ignore', onRespond: ({ update }) => {
      if (++count === 1) update({ stack: [{ id: 'response', controllerId: 'opponent' }], decision: priority('response', [pass, { id: 'optional', type: 'object' }]) });
      else update({ step: 'END_TURN', decision: priority('end') });
    },
  });
  assert.equal(result.status, 'completed'); assert.equal(applied.length, 2);
});
test('intentional standalone pass still stops for mandatory choices', async (t) => {
  const { result, applied } = await run(t, [{ kind: 'pass_until', step: 'END_TURN', skipOptionalResponses: true }], {
    responsePolicy: 'ignore', onRespond: ({ update }) => update({ decision: { id: 'target', kind: 'target', choices: [{ id: 'select' }] } }),
  });
  assert.equal(result.reason, 'response_available'); assert.equal(applied.length, 1);
});
test('opponent thinking time does not consume the active sequence budget', async (t) => {
  let timer;
  t.after(() => clearTimeout(timer));
  const { result, applied } = await run(t, [{ kind: 'yield_priority' }], {
    seatOptions: { sequenceTimeoutMs: 30, maxSequenceWallMs: 500 },
    onRespond: ({ update }) => {
      update({ priority: 'opponent', decision: null });
      timer = setTimeout(() => update({ priority: 'self', decision: priority('returned') }), 90);
    },
  });
  assert.equal(result.status, 'completed'); assert.equal(applied.length, 1);
});
test('opponent wait has a hard lifetime cap and never keeps passing', async (t) => {
  const { result, applied } = await run(t, [{ kind: 'yield_priority' }], {
    seatOptions: { sequenceTimeoutMs: 10, maxSequenceWallMs: 35 },
    onRespond: ({ update }) => update({ priority: 'opponent', decision: null }),
  });
  assert.equal(result.reason, 'timeout'); assert.equal(applied.length, 1);
});


test('guarded combat line stops when the opponent declares a blocker without tapping', async (t) => {
  const { result, applied } = await run(t, [{ kind: 'pass_until', step: 'POSTCOMBAT_MAIN' }], {
    initial: { players: [{ id: 'self', yourSeat: true }, { id: 'opponent' }], combat: [] },
    onRespond: ({ update }) => update({ combat: [{ attackers: [], blockers: [{ id: 'blocker', controllerId: 'opponent' }] }] }),
  });
  assert.equal(result.reason, 'opponent_state_changed'); assert.equal(applied.length, 1);
});


for (const priorityHolder of ['opponent', 'none']) {
  test(`yield promptly interrupts for our mandatory prompt while displayed priority is ${priorityHolder}`, async (t) => {
    const { result, applied } = await run(t, [{ kind: 'yield_priority' }], {
      onRespond: ({ update }) => update({ priority: priorityHolder, decision: { id: 'mandatory', kind: 'target', choices: [{ id: 'target' }] } }),
    });
    assert.equal(result.reason, 'response_available'); assert.equal(applied.length, 1);
  });
}


test('guarded combat detects a face-down blocker without reading its hidden identity', async (t) => {
  const hidden = { id: 'hidden-public-object', faceDown: true, name: 'Face-down card', tapped: false };
  const { result, applied } = await run(t, [{ kind: 'pass_until', step: 'POSTCOMBAT_MAIN' }], {
    initial: { players: [{ id: 'self', yourSeat: true }, { id: 'opponent', battlefield: [hidden] }], combat: [] },
    onRespond: ({ update }) => update({ combat: [{ attackers: [{ id: 'our-attacker', controllerId: 'self' }], blockers: [hidden] }] }),
  });
  assert.equal(result.reason, 'opponent_state_changed'); assert.equal(applied.length, 1);
});
