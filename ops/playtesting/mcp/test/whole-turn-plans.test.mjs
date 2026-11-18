import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { GameSeat } from '../src/game-seat.mjs';
import { visibleAgentGame } from '../dist/engine-core.mjs';

const pass = { id: 'pass', type: 'pass' };
const spell = { id: 'physical', cardId: 'physical', name: 'Burst Lightning', types: ['INSTANT'] };
const otter = { id: 'otter', name: 'Otter', controllerId: 'me', types: ['CREATURE'] };
const priority = (id, choices = []) => ({ id, kind: 'priority', instruction: 'Play spells and abilities', choices: [pass, ...choices] });
const evidence = (resolutions = {}, resolutionRevision = 0, extra = {}) => ({ epoch: 'turn-feed', publicActions: { me: 0, rival: 0 }, resolutions, resolutionRevision, combatRevision: 0, combatDamage: [], informationRevision: 0, ...extra });
const answer = (id, kind = 'priority', extra = {}) => ({ kind: 'answer', choiceId: id, guard: { kind, step: 'PRECOMBAT_MAIN' }, ...extra });
const resolve = { kind: 'pass_until', priority: 'self', stackEmpty: true, allowPlannedResolutions: true };

async function run(t, { initial = {}, steps, options = {}, respond }) {
  let state = { gameId: 'turn', status: 'active', epoch: 1, cursor: 1, turn: 3, activePlayer: 'Pilot', activePlayerId: 'me', step: 'PRECOMBAT_MAIN', phase: 'PRECOMBAT_MAIN', priority: 'self', stack: [], ownHand: [spell],
    players: [{ id: 'me', yourSeat: true, battlefield: [otter] }, { id: 'rival', life: 17, battlefield: [] }], sequenceEvidence: evidence(), decision: priority('cast', [{ id: 'cast', card: spell }]), ...initial };
  const listeners = new Set(), applied = [];
  const update = (change) => { state = { ...state, ...change, cursor: state.cursor + 1 }; for (const fn of [...listeners]) fn(); };
  const seat = new GameSeat({ snapshot: () => state, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, respond: async (id, choice) => {
    applied.push([id, choice]); await respond({ id, choice, update, state }); return { submitted: true };
  } });
  t.after(() => seat.invalidate());
  const started = seat.startSequence({ gameId: 'turn', cursor: 1, steps, ...options }, async () => true);
  for (let n = 0; n < 100; n++) {
    const result = seat.sequenceStatus({ gameId: 'turn', sequenceId: started.sequenceId });
    if (result.status !== 'running') return { result, applied, state };
    await sleep(2);
  }
  assert.fail('A finite plan must terminate');
}

test('[PM-AC-09-TURN] hints in battlefield and graveyard do not turn our cast into a rival action', async (t) => {
  const project = (count) => visibleAgentGame({ playerId: 'me', view: { players: [{ playerId: 'rival', battlefield: { annex: { id: 'annex', name: 'Unholy Annex', rules: ['Static rules', '<hintstart/>ICON_GOOD Controls a Demon'] } }, graveyard: { trespasser: { id: 'trespasser', name: 'Graveyard Trespasser', rules: ['Daybound', `<hintstart/>ICON_INFO Active player cast ${count} spell(s)`] } } }] } }).players[0];
  const before = project(0), after = project(1);
  const { result, applied } = await run(t, { initial: { players: [{ id: 'me', yourSeat: true, battlefield: [otter] }, before] }, steps: [answer('cast', 'priority', { expectCast: true }), answer('tap', 'payMana'), resolve], respond: ({ id, update, state }) => {
    if (id === 'cast') update({ ownHand: [], stack: [{ ...spell, id: 's', controllerId: 'me' }], players: [state.players[0], after], decision: { id: 'pay', kind: 'payMana', choices: [{ id: 'tap' }] } });
    else if (id === 'pay') update({ decision: priority('pass') });
    else update({ stack: [], sequenceEvidence: evidence({ s: 1 }, 1), decision: priority('done') });
  } });
  assert.equal(result.status, 'completed'); assert.equal(applied.length, 3);
  assert.deepEqual(after.graveyard[0].rules, ['Daybound']);
  assert.match(after.graveyard[0].hints[0].text, /cast 1/);
});

test('[PM-AC-09-TURN] explicitly adopted existing stack objects may resolve before the next play', async (t) => {
  const { result, applied } = await run(t, { initial: { stack: [{ ...spell, id: 'existing', controllerId: 'me' }], decision: priority('pass') }, options: { expectedStackIds: ['existing'] }, steps: [resolve], respond: ({ update }) => update({ stack: [], sequenceEvidence: evidence({ existing: 1 }, 1), decision: priority('done') }) });
  assert.equal(result.status, 'completed'); assert.equal(applied.length, 1);
});

test('[PM-AC-09-TURN] an observed end-step destination stops even before a replacement decision callback', async (t) => {
  const { result, applied } = await run(t, { initial: { ownHand: [], step: 'POSTCOMBAT_MAIN', decision: priority('pass') }, options: { autoAdvance: true }, steps: [{ kind: 'pass_until', step: 'END_TURN' }], respond: ({ update }) => update({ step: 'END_TURN' }) });
  assert.equal(result.status, 'completed');
  assert.equal(result.lastDestination.step, 'END_TURN');
  assert.deepEqual(applied, [['pass', 'pass']], 'The previous decision must never cause an extra end-step pass');
});

test('[PM-AC-09-TURN] a declared prowess trigger may auto-resolve during the final payment before the pass step', async (t) => {
  const trigger = { id: 'prowess', controllerId: 'me', abilityType: 'TRIGGERED_NONMANA', sourceId: 'otter', abilityText: 'Prowess' };
  const { result } = await run(t, { steps: [answer('cast', 'priority', { expectCast: true, expectTriggers: [{ sourceId: 'otter', abilityText: 'Prowess' }] }), answer('tap', 'payMana'), resolve], respond: ({ id, update }) => {
    if (id === 'cast') update({ ownHand: [], stack: [{ ...spell, id: 's', controllerId: 'me' }], decision: { id: 'pay', kind: 'payMana', choices: [{ id: 'tap' }] } });
    else if (id === 'pay') {
      update({ stack: [{ ...spell, id: 's', controllerId: 'me' }, trigger] });
      update({ stack: [{ ...spell, id: 's', controllerId: 'me' }], sequenceEvidence: evidence({ prowess: 1 }, 1), decision: priority('pass') });
    } else update({ stack: [], sequenceEvidence: evidence({ prowess: 1, s: 2 }, 2), decision: priority('done') });
  } });
  assert.equal(result.status, 'completed');
});

test('[PM-AC-09-TURN] Burst removal and its public effects may arrive in successive views before a fresh decision', async (t) => {
  const rival = { id: 'rival', life: 17, battlefield: [{ id: 'mutavault', name: 'Mutavault' }] };
  const { result } = await run(t, { initial: { players: [{ id: 'me', yourSeat: true }, rival] }, steps: [answer('cast', 'priority', { expectCast: true }), resolve], respond: ({ id, update, state }) => {
    if (id === 'cast') update({ ownHand: [], stack: [{ ...spell, id: 's', controllerId: 'me' }], decision: priority('pass') });
    else {
      update({ sequenceEvidence: evidence({ s: 1 }, 1), priority: 'opponent', decision: null });
      update({ stack: [] });
      update({ players: [state.players[0], { ...rival, battlefield: [], graveyard: [{ id: 'mutavault', name: 'Mutavault' }] }], priority: 'self', decision: priority('done') });
    }
  } });
  assert.equal(result.status, 'completed');
});

for (const change of ['damage', 'unwitnessed', 'rival-action', 'unrelated-change']) test(`[PM-AC-09-TURN] own combat witness accepts only the exact life delta: ${change}`, async (t) => {
  const initial = { ownHand: [], combat: [{ attackers: [otter], blockers: [] }], decision: priority('combat') };
  const { result, applied } = await run(t, { initial, options: { allowPlannedCombatDamage: true }, steps: [{ kind: 'pass_until', step: 'POSTCOMBAT_MAIN' }], respond: ({ update, state }) => update({ step: 'POSTCOMBAT_MAIN', players: [state.players[0], { ...state.players[1], life: 14, ...(change === 'unrelated-change' ? { handCount: 5 } : {}) }],
    sequenceEvidence: evidence({}, 0, { publicActions: { me: 0, rival: change === 'rival-action' ? 1 : 0 }, combatRevision: change === 'unwitnessed' ? 0 : 1, combatDamage: change === 'unwitnessed' ? [] : [{ revision: 1, sourceId: 'otter', controllerId: 'me', targetId: 'rival', amount: 3 }] }), decision: priority('done') }) });
  assert.equal(result.status, change === 'damage' ? 'completed' : 'interrupted'); assert.equal(applied.length, 1);
  if (change !== 'damage') assert.equal(result.reason, change === 'rival-action' ? 'opponent_action' : 'opponent_state_changed');
});

for (const correct of [true, false]) test(`[PM-AC-09-TURN] skip auto-selected target prompts only with exact public stack evidence: ${correct}`, async (t) => {
  const target = { id: 'enemy-creature', name: 'Enemy creature' };
  const { result, applied } = await run(t, { initial: { players: [{ id: 'me', yourSeat: true, battlefield: [otter] }, { id: 'rival', battlefield: [target] }] }, steps: [answer('cast', 'priority', { expectCast: true }),
    ...['otter', 'enemy-creature'].map((cardId) => ({ kind: 'answer', guard: { kind: 'target', step: 'PRECOMBAT_MAIN' }, select: { cardId, zone: 'battlefield' }, skipIfTargetedBy: 'physical' })), answer('tap', 'payMana'), resolve], respond: ({ id, update }) => {
    if (id === 'cast') update({ ownHand: [], stack: [{ ...spell, id: 's', controllerId: 'me', targets: correct ? ['otter', 'enemy-creature'] : [] }], decision: { id: 'pay', kind: 'payMana', choices: [{ id: 'tap' }] } });
    else if (id === 'pay') update({ decision: priority('pass') });
    else update({ stack: [], sequenceEvidence: evidence({ s: 1 }, 1), decision: priority('done') });
  } });
  assert.equal(result.status, correct ? 'completed' : 'interrupted');
  assert.equal(applied.length, correct ? 3 : 1);
  if (correct) assert.equal(result.skippedSteps, 2);
});

for (const variant of ['ward', 'not-ward', 'other-trigger', 'wrong-target', 'rival-action']) test(`[PM-AC-09-TURN] predeclared target-derived Ward has guarded own discard decisions: ${variant}`, async (t) => {
  const card = { id: 'discard', cardId: 'discard', name: 'Mountain', types: ['LAND'] };
  const source = { id: 'trespasser', name: 'Graveyard Trespasser', controllerId: 'rival', rules: [variant === 'not-ward' ? 'Menace' : 'Ward—Discard a card.'] };
  const ward = { id: 'ward', sourceId: source.id, controllerId: 'rival', abilityType: 'TRIGGERED_NONMANA', abilityText: variant === 'other-trigger' ? 'Whenever another creature dies, draw a card.' : 'Ward—Discard a card.' };
  const { result, applied } = await run(t, { initial: { ownHand: [spell, card], players: [{ id: 'me', yourSeat: true }, { id: 'rival', battlefield: [source] }] }, steps: [answer('cast', 'priority', { expectCast: true, expectTargetTriggers: [{ sourceId: source.id, targetingCardId: spell.cardId, abilityText: ward.abilityText }] }),
    { kind: 'yield_priority', allowPlannedResolutions: true },
    answer('yes', 'question', { guard: { kind: 'question', step: 'PRECOMBAT_MAIN', instruction: 'discard a card?' } }),
    { kind: 'answer', select: { cardId: 'discard', zone: 'hand' }, guard: { kind: 'target', step: 'PRECOMBAT_MAIN', instruction: 'Select a card (discard cost)' } }, resolve], respond: ({ id, update }) => {
    if (id === 'cast') update({ ownHand: [card], stack: [{ ...spell, id: 's', controllerId: 'me', targets: variant === 'wrong-target' ? ['elsewhere'] : [source.id] }, ward], sequenceEvidence: evidence({}, 0, { publicActions: { me: 1, rival: variant === 'rival-action' ? 1 : 0 } }), decision: priority('ward-pass') });
    else if (id === 'ward-pass') update({ priority: 'opponent', decision: { id: 'question', kind: 'question', instruction: 'discard a card?', choices: [{ id: 'yes' }] } });
    else if (id === 'question') update({ decision: { id: 'discard-choice', kind: 'target', instruction: 'Select a card (discard cost)', choices: [{ id: 'discard-card', card }] } });
    else if (id === 'discard-choice') update({ ownHand: [], stack: [{ ...spell, id: 's', controllerId: 'me', targets: [source.id] }], sequenceEvidence: evidence({ ward: 1 }, 1), priority: 'self', decision: priority('spell-pass') });
    else update({ stack: [], sequenceEvidence: evidence({ ward: 1, s: 2 }, 2), decision: priority('done') });
  } });
  assert.equal(result.status, variant === 'ward' ? 'completed' : 'interrupted');
  assert.equal(applied.length, variant === 'ward' ? 5 : ['not-ward', 'other-trigger'].includes(variant) ? 0 : 1);
});

for (const kind of ['draw', 'exile', 'random']) test(`[PM-AC-09-TURN] new information still interrupts a declared own resolution: ${kind}`, async (t) => {
  const { result, applied } = await run(t, { steps: [answer('cast', 'priority', { expectCast: true }), resolve], respond: ({ id, update, state }) => {
    if (id === 'cast') update({ ownHand: [], stack: [{ ...spell, id: 's', controllerId: 'me' }], decision: priority('pass') });
    else update({ stack: [], sequenceEvidence: evidence({ s: 1 }, 1, { informationRevision: kind === 'random' ? 1 : 0 }), ...(kind === 'draw' ? { ownHand: [{ id: 'new-card', name: 'New card' }] } : kind === 'exile' ? { players: [{ ...state.players[0], exile: [{ id: 'new-exile', name: 'New exile' }] }, state.players[1]] } : {}), decision: priority('done') });
  } });
  assert.equal(result.status, 'interrupted'); assert.equal(result.reason, 'new_information'); assert.equal(applied.length, 2);
});
