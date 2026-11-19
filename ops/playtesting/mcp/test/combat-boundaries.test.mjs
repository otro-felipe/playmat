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

for (const variant of ['matched', 'one-view', 'marks-first', 'unwitnessed', 'wrong-pair', 'wrong-mark', 'wrong-graveyard', 'unrelated-tap', 'opponent-action']) test(`[PM-LINE-01] mixed Cottage and Sheoldred combat requires exact public evidence: ${variant}`, async (t) => {
  const cottage = { id: 'cottage-object', cardId: 'cottage-card', name: 'Restless Cottage', controllerId: 'me', types: ['LAND', 'CREATURE'], power: '4', toughness: '4', damage: 0 };
  const attacker = { id: 'attacker', name: 'Sheoldred, the Apocalypse', controllerId: 'me', types: ['CREATURE'], power: '4', toughness: '5', damage: 0 };
  const blocker = { ...attacker, id: 'blocker', controllerId: 'rival', tapped: false };
  const cottageInGrave = { id: 'cottage-card', cardId: 'cottage-card', name: cottage.name, types: ['LAND'] };
  const pilot = { id: 'me', yourSeat: true, battlefield: [cottage, attacker] };
  const rival = { id: 'rival', life: 13, battlefield: [blocker], counters: [] };
  let state = { gameId: 'boundary', status: 'active', epoch: 1, cursor: 1, turn: 10, activePlayer: 'Pilot', activePlayerId: 'me',
    step: 'DECLARE_BLOCKERS', priority: 'self', ownHand: [], stack: [], sequenceEvidence: evidence(), decision: priority('blocks'),
    combat: [{ attackers: [cottage], blockers: [blocker] }, { attackers: [attacker], blockers: [] }], players: [pilot, rival] };
  const listeners = new Set(), applied = [];
  const update = (change) => { state = { ...state, ...change, cursor: state.cursor + 1 }; for (const listener of [...listeners]) listener(); };
  const seat = new GameSeat({ snapshot: () => state, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }, respond: async (id) => {
    applied.push(id);
    if (id === 'postcombat') return { submitted: true };
    assert.equal(id, 'blocks');
    const damagedCottage = { ...cottage, damage: 4 };
    const damagedBlocker = { ...blocker, damage: variant === 'wrong-mark' ? 3 : 4, tapped: variant === 'unrelated-tap' };
    const damage = [{ revision: 1, sourceId: attacker.id, controllerId: 'me', targetId: 'rival', amount: 4 }];
    if (variant !== 'unwitnessed') damage.push(
      { revision: 2, sourceId: variant === 'wrong-pair' ? attacker.id : cottage.id, controllerId: 'me', targetId: blocker.id, amount: 4, targetPermanent: true },
      { revision: 3, sourceId: blocker.id, controllerId: 'rival', targetId: cottage.id, amount: 4, targetPermanent: true });
    const sequenceEvidence = { ...evidence(true), combatRevision: damage.length, combatDamage: damage,
      publicActions: { me: 0, rival: variant === 'opponent-action' ? 1 : 0 } };
    const rivalAfter = { ...rival, life: 9, battlefield: [damagedBlocker] };
    const pilotAfter = { ...pilot, battlefield: [attacker], graveyard: variant === 'wrong-graveyard' ? [] : [cottageInGrave] };
    if (variant !== 'one-view') {
      update({ step: 'COMBAT_DAMAGE', decision: null,
        combat: [{ attackers: [damagedCottage], blockers: [damagedBlocker] }, { attackers: [attacker], blockers: [] }],
        players: [{ ...pilot, battlefield: [damagedCottage, attacker] }, variant === 'marks-first' ? { ...rivalAfter, life: 13 } : rivalAfter], sequenceEvidence });
      update({ step: 'END_COMBAT', decision: null,
        combat: [{ attackers: [], blockers: [damagedBlocker] }, { attackers: [attacker], blockers: [] }], players: [pilotAfter, rivalAfter] });
    }
    update({ step: 'POSTCOMBAT_MAIN', decision: priority('postcombat'), combat: [], players: [pilotAfter, rivalAfter], sequenceEvidence });
    return { submitted: true };
  } });
  t.after(() => seat.invalidate());
  const result = await settled(seat, seat.startSequence({ gameId: 'boundary', cursor: 1, allowPlannedCombatDamage: true,
    steps: [{ kind: 'pass_until', step: 'POSTCOMBAT_MAIN' }, { kind: 'answer', choiceId: 'pass', guard: { kind: 'priority', step: 'POSTCOMBAT_MAIN' } }] }, async () => true));
  const matched = ['matched', 'one-view', 'marks-first'].includes(variant);
  assert.equal(result.status, matched ? 'completed' : 'interrupted', JSON.stringify(result));
  if (!matched) assert.equal(result.reason, variant === 'opponent-action' ? 'opponent_action' : 'opponent_state_changed');
  assert.deepEqual(applied, matched ? ['blocks', 'postcombat'] : ['blocks']);
});

test('[PM-LINE-01] permanent combat witnesses retain only public evidence fields', () => {
  const hit = { revision: 2, sourceId: 'attacker', controllerId: 'me', targetId: 'blocker', amount: 4, targetPermanent: true };
  const projected = visibleAgentGame({ view: { sequenceEvidence: { combatDamage: [{ ...hit, privateField: 'omit' }] } } });
  assert.deepEqual(projected.sequenceEvidence.combatDamage, [hit]);
});

for (const rivalActs of [false, true]) test(`[PM-LINE-COMBAT-1] a confirmed blocker survives while the opposing attacker dies, opponent action: ${rivalActs}`, async (t) => {
  const cub = { id: 'cub', cardId: 'cub-card', name: 'Badgermole Cub', controllerId: 'rival', types: ['CREATURE'], power: '2', toughness: '2', damage: 0 };
  const blocker = { id: 'blocker', cardId: 'blocker-card', name: 'Monastery Swiftspear', controllerId: 'me', types: ['CREATURE'], power: '5', toughness: '3', damage: 0 };
  const pilot = { id: 'me', yourSeat: true, life: 20, battlefield: [blocker] };
  const rival = { id: 'rival', life: 20, counters: [], battlefield: [cub] };
  let state = { gameId: 'boundary', status: 'active', epoch: 1, cursor: 1, turn: 10, activePlayer: 'Rival', activePlayerId: 'rival',
    step: 'DECLARE_BLOCKERS', priority: 'self', ownHand: [], stack: [], sequenceEvidence: evidence(), decision: priority('blocks'),
    combat: [{ attackers: [cub], blockers: [blocker] }], players: [pilot, rival] };
  const listeners = new Set(), applied = [];
  const seat = new GameSeat({ snapshot: () => state, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }, respond: async (id) => {
    applied.push(id);
    if (id === 'postcombat') return { submitted: true };
    assert.equal(id, 'blocks');
    const hits = [
      { revision: 1, sourceId: cub.id, controllerId: rival.id, targetId: blocker.id, amount: 2, targetPermanent: true },
      { revision: 2, sourceId: blocker.id, controllerId: pilot.id, targetId: cub.id, amount: 5, targetPermanent: true },
    ];
    state = { ...state, cursor: 2, step: 'POSTCOMBAT_MAIN', decision: priority('postcombat'), combat: [],
      players: [{ ...pilot, battlefield: [{ ...blocker, damage: 2 }] },
        { ...rival, battlefield: [], graveyard: [{ id: 'cub-card', cardId: 'cub-card', name: cub.name, types: ['CREATURE'] }] }],
      sequenceEvidence: { ...evidence(), combatRevision: 2, combatDamage: hits, publicActions: { me: 0, rival: Number(rivalActs) } } };
    for (const listener of [...listeners]) listener();
    return { submitted: true };
  } });
  t.after(() => seat.invalidate());
  const result = await settled(seat, seat.startSequence({ gameId: 'boundary', cursor: 1, allowPlannedCombatDamage: true,
    steps: [{ kind: 'pass_until', step: 'POSTCOMBAT_MAIN' }, { kind: 'answer', choiceId: 'pass', guard: { kind: 'priority', step: 'POSTCOMBAT_MAIN' } }] }, async () => true));
  assert.equal(result.status, rivalActs ? 'interrupted' : 'completed', JSON.stringify(result));
  if (rivalActs) assert.equal(result.reason, 'opponent_action');
  assert.deepEqual(applied, rivalActs ? ['blocks'] : ['blocks', 'postcombat']);
});

for (const targetPrompt of [false, true]) test(`[PM-LINE-COMBAT-1] chooses and confirms the exact blocker pair, extra attacker prompt: ${targetPrompt}`, async (t) => {
  const cub = { id: 'cub', controllerId: 'rival' };
  const other = { id: 'other', controllerId: 'rival' };
  const blocker = { id: 'blocker', controllerId: 'me' };
  const confirm = { id: 'confirm', type: 'button', intent: 'confirm_block' };
  const block = { id: 'candidate', objectId: blocker.id, card: blocker };
  const attackers = targetPrompt ? [cub, other] : [cub];
  let state = { gameId: 'boundary', status: 'active', epoch: 1, cursor: 1, turn: 10, activePlayer: 'Rival', activePlayerId: 'rival',
    step: 'DECLARE_BLOCKERS', priority: 'self', ownHand: [], stack: [], sequenceEvidence: evidence(),
    decision: { id: 'pick-blocker', kind: 'declareBlockers', choices: [block, confirm] },
    combat: attackers.map(attacker => ({ attackers: [attacker], blockers: [] })),
    players: [{ id: 'me', yourSeat: true, life: 20, battlefield: [blocker] }, { id: 'rival', life: 20, battlefield: attackers }] };
  const listeners = new Set(), applied = [];
  const seat = new GameSeat({ snapshot: () => state, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    respond: async (_, choiceId) => {
      applied.push(choiceId);
      if (choiceId === 'confirm') {
        state = { ...state, cursor: state.cursor + 1, decision: priority('declared') };
      } else if (choiceId === block.id && targetPrompt) {
        state = { ...state, cursor: state.cursor + 1, decision: { id: 'pick-attacker', kind: 'target', instruction: 'Select attacker to block',
          choices: [{ id: 'wrong', objectId: other.id }, { id: 'right', objectId: cub.id }] } };
      } else {
        assert.equal(choiceId, targetPrompt ? 'right' : block.id);
        state = { ...state, cursor: state.cursor + 1, decision: { id: 'confirm-blockers', kind: 'declareBlockers', choices: [block, confirm] },
          combat: state.combat.map(group => group.attackers[0] === cub ? { ...group, blockers: [blocker] } : group) };
      }
      for (const listener of [...listeners]) listener();
      return { submitted: true };
    } });
  t.after(() => seat.invalidate());
  const result = await settled(seat, seat.startTurn({ gameId: 'boundary', cursor: 1, finish: 'none',
    actions: [{ kind: 'block', assignments: [{ blockerId: blocker.id, attackerId: cub.id }] }] }, async () => true));
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.deepEqual(applied, targetPrompt ? ['candidate', 'right', 'confirm'] : ['candidate', 'confirm']);
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

for (const variant of ['matched', 'delayed', 'first-strike', 'poison', 'late-poison', 'wrong-life', 'wrong-source',
  'opponent-action', 'blocked', 'planeswalker', 'missing-defender', 'unrelated-tap']) {
  test(`[PM-LINE-COMBAT-1] defensive damage needs an exact unblocked attacker and own defender: ${variant}`, async (t) => {
    const attacker = { id: 'attacking-cottage', controllerId: 'rival', types: ['LAND', 'CREATURE'], power: '3', damage: 0, tapped: true };
    const pilot = { id: 'me', yourSeat: true, life: 17, counters: [], battlefield: [] };
    const rival = { id: 'rival', life: 20, counters: [], battlefield: [attacker] };
    const group = { attackers: [attacker], blockers: [], isBlocked: variant === 'blocked',
      defenderId: variant === 'missing-defender' ? undefined : variant === 'planeswalker' ? 'defended-walker' : 'me' };
    let state = { gameId: 'boundary', status: 'active', epoch: 1, cursor: 1, turn: 10, activePlayer: 'Rival', activePlayerId: 'rival',
      step: 'DECLARE_BLOCKERS', priority: 'self', ownHand: [], stack: [], sequenceEvidence: evidence(), decision: priority('blocks'),
      combat: [group], players: [pilot, rival] };
    const listeners = new Set();
    const applied = [];
    const update = (change) => {
      state = { ...state, ...change, cursor: state.cursor + 1 };
      for (const listener of [...listeners]) listener();
    };
    const seat = new GameSeat({ snapshot: () => state, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      respond: async (id) => {
        applied.push(id);
        if (id === 'postcombat') {
          update({ step: 'END_TURN', decision: priority('done') });
          return { submitted: true };
        }
        assert.equal(id, 'blocks');
        const hit = { revision: 1, sourceId: variant === 'wrong-source' ? 'other-attacker' : attacker.id,
          controllerId: rival.id, targetId: pilot.id, amount: 3 };
        const witnessed = { ...evidence(), combatRevision: 1, combatDamage: [hit], publicActions: { me: 0, rival: Number(variant === 'opponent-action') } };
        if (variant === 'first-strike') {
          update({ step: 'FIRST_COMBAT_DAMAGE', decision: null, players: [{ ...pilot, life: 14 }, rival], sequenceEvidence: witnessed });
        } else if (variant === 'delayed') {
          update({ step: 'COMBAT_DAMAGE', decision: null, sequenceEvidence: witnessed });
        }
        const counters = variant === 'poison' ? [{ name: 'poison', count: 1 }] : [];
        update({ step: 'POSTCOMBAT_MAIN', decision: priority('postcombat'), combat: [],
          players: [{ ...pilot, life: variant === 'wrong-life' ? 13 : variant === 'first-strike' ? 11 : 14, counters },
            variant === 'unrelated-tap' ? { ...rival, battlefield: [{ ...attacker, tapped: false }] } : rival],
          sequenceEvidence: variant === 'first-strike' ? { ...witnessed, combatRevision: 2, combatDamage: [hit, { ...hit, revision: 2 }] } : witnessed });
        if (variant === 'late-poison') {
          update({ players: [{ ...state.players[0], counters: [{ name: 'poison', count: 1 }] }, rival] });
        }
        return { submitted: true };
      } });
    t.after(() => seat.invalidate());
    const result = await settled(seat, seat.startTurn({ gameId: 'boundary', cursor: 1, settle: false, finish: 'none',
      actions: [{ kind: 'pass_until', destination: 'end_step', policy: 'decline_optional' }] }, async () => true));
    const matched = ['matched', 'delayed', 'first-strike'].includes(variant);
    assert.equal(result.status, matched ? 'completed' : 'interrupted', JSON.stringify(result));
    if (!matched) assert.equal(result.reason, variant === 'opponent-action' ? 'opponent_action' : 'opponent_state_changed');
    assert.deepEqual(applied, matched ? ['blocks', 'postcombat'] : ['blocks']);
  });
}

test('[PM-LINE-COMBAT-1] the combat projection preserves public defender and blocked state', () => {
  const projected = visibleAgentGame({ view: { combat: [{ defenderId: 'me', isBlocked: false, unrelated: 'omit' }] } });
  assert.deepEqual(projected.combat, [{ defenderId: 'me', isBlocked: false, attackers: [], blockers: [] }]);
});
