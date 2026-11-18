import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { GameSeat } from '../src/game-seat.mjs';

const land = { id: 'land', cardId: 'land', name: 'Mountain', types: ['LAND'], rules: ['{T}: Add {R}.'], tapped: false };
const swift = { id: 'swift', cardId: 'swift', name: 'Monastery Swiftspear', controllerId: 'me', types: ['CREATURE'] };
const pass = { id: 'pass', type: 'pass' };
const priority = (id, choices = []) => ({ id, kind: 'priority', choices: [pass, ...choices] });
const evidence = () => ({ epoch: 'semantic-feed', publicActions: { me: 0, rival: 0 }, resolutions: {}, resolutionRevision: 0, combatDamage: [], combatRevision: 0, informationRevision: 0 });

async function turn(t, variant = 'normal') {
  const listeners = new Set(), applied = [];
  const free = { id: 'free', cardId: 'free', name: 'Free spell', types: ['INSTANT'] };
  let state = { gameId: 'semantic', status: 'active', epoch: 1, cursor: 1, turn: 1, activePlayer: 'Pilot', activePlayerId: 'me', priority: 'self', step: 'PRECOMBAT_MAIN', ownHand: [land, swift, ...(variant === 'free-play' ? [free] : [])], stack: [],
    players: [{ id: 'me', yourSeat: true, battlefield: [], manaPool: {} }, { id: 'rival', life: 20, battlefield: [] }], sequenceEvidence: evidence(), decision: priority('land', [{ id: 'land-choice', card: land }]) };
  const update = (change) => { state = { ...state, ...change, cursor: state.cursor + 1 }; for (const fn of [...listeners]) fn(); };
  const seat = new GameSeat({ snapshot: () => state, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, respond: async (id, choice) => {
    applied.push([id, choice]);
    if (id === 'land') update({ ownHand: state.ownHand.filter((card) => card.id !== 'land'), players: [{ ...state.players[0], battlefield: [land] }, state.players[1]], decision: priority('cast', [{ id: 'cast-choice', card: swift }]) });
    else if (id === 'cast') update({ ownHand: state.ownHand.filter((card) => card.id !== 'swift'), stack: [{ ...swift, id: 'stack-swift' }], decision: { id: 'pay', kind: 'payMana', choices: [{ id: 'tap-choice', card: land, objectId: 'land', type: 'manaAbility' }] } });
    else if (id === 'pay') update({ players: [{ ...state.players[0], battlefield: [{ ...land, tapped: true }] }, state.players[1]], decision: priority('resolve') });
    else if (id === 'resolve') update({ stack: variant === 'unknown-trigger' ? [{ id: 'surprise', controllerId: 'me' }] : [], sequenceEvidence: { ...evidence(), resolutions: { 'stack-swift': 1 }, resolutionRevision: 1, publicActions: { me: 2, rival: variant === 'rival-action' ? 1 : 0 } },
      players: [{ ...state.players[0], battlefield: [{ ...land, tapped: true }, swift] }, state.players[1]],
      decision: variant === 'mandatory' ? { id: 'unplanned', kind: 'target', choices: [{ id: 'mandatory-choice' }] } : priority('combat'), ...(variant === 'chosen-stop' ? { stop: true } : {}), ...(variant === 'new-card' ? { ownHand: [{ id: 'new', name: 'New information' }] } : {}) });
    else if (id === 'combat') update({ step: 'DECLARE_ATTACKERS', decision: { id: 'attack', kind: 'declareAttackers', choices: [{ id: 'all-choice', intent: 'attack_all', type: 'button' }] } });
    else if (id === 'attack') update({ combat: [{ attackers: [swift], blockers: [] }], decision: { id: 'confirm', kind: 'declareAttackers', choices: [{ id: 'confirm-choice', intent: 'confirm_attack', type: 'button' }] } });
    else if (id === 'confirm') update({ decision: priority('damage') });
    else if (id === 'damage') update({ step: 'POSTCOMBAT_MAIN', players: [state.players[0], { ...state.players[1], life: 19 }], sequenceEvidence: { ...state.sequenceEvidence, combatRevision: 1, combatDamage: [{ revision: 1, sourceId: 'swift', controllerId: 'me', targetId: 'rival', amount: 1 }] }, decision: priority('postcombat', variant === 'free-play' ? [{ id: 'free-choice', card: free, type: 'object' }] : variant === 'useful-mana' ? [{ id: 'mana-draw', type: 'manaAbility', card: { ...land, rules: ['{T}: Add {R}. Draw a card.'] } }] : []) });
    else if (id === 'postcombat') update({ step: 'END_TURN', decision: priority('end') });
    else if (id === 'end') update({ turn: 2, activePlayer: 'Rival', activePlayerId: 'rival', step: 'UPKEEP', decision: priority('rival-turn') });
    else if (id === 'rival-turn') update({ turn: 3, activePlayer: 'Pilot', activePlayerId: 'me', step: 'UNTAP', decision: priority('next-turn') });
    else assert.fail(`No unplanned action: ${id}`);
    return { submitted: true };
  } });
  t.after(() => seat.invalidate());
  const args = { gameId: 'semantic', cursor: 1, actions: [{ kind: 'play', select: { cardId: 'land', zone: 'hand' } }, { kind: 'play', select: { cardId: 'swift', zone: 'hand' }, payWith: ['land'] }, { kind: 'attack', attackers: 'all' }], finish: variant === 'useful-mana' ? 'end_step' : 'next_turn' };
  assert.equal(JSON.stringify(args.actions).includes('pass'), false, 'The agent plans meaningful actions, not priority choreography');
  const started = seat.startTurn(args, async () => true);
  for (let n = 0; n < 100; n++) {
    const result = seat.sequenceStatus({ gameId: 'semantic', sequenceId: started.sequenceId });
    if (result.status !== 'running') return { result, state, applied };
    await sleep(3);
  }
  assert.fail('The complete semantic turn must finish in bounded time');
}

test('[PM-AC-09-TURN] land, Swiftspear, chosen mana and all attackers complete a turn with implicit passes and preserve the next turn', async (t) => {
  const { result, state, applied } = await turn(t);
  assert.equal(result.status, 'completed');
  assert.equal(state.turn, 3); assert.equal(state.decision.id, 'next-turn');
  assert.equal(state.players[1].life, 19);
  assert.deepEqual(applied, [['land', 'land-choice'], ['cast', 'cast-choice'], ['pay', 'tap-choice'], ['resolve', 'pass'], ['combat', 'pass'], ['attack', 'all-choice'], ['confirm', 'confirm-choice'], ['damage', 'pass'], ['postcombat', 'pass'], ['end', 'pass'], ['rival-turn', 'pass']]);
});
for (const [variant, reason] of [['rival-action', 'opponent_action'], ['unknown-trigger', 'state_changed'], ['new-card', 'new_information'], ['mandatory', 'response_available'], ['chosen-stop', 'response_available'], ['free-play', 'response_available'], ['useful-mana', 'response_available']]) test(`[PM-AC-09-TURN] semantic passing stops for ${variant}`, async (t) => {
  const { result, state, applied } = await turn(t, variant);
  assert.equal(result.status, 'interrupted'); assert.equal(result.reason, reason);
  assert.notEqual(applied.at(-1)[0], 'rival-turn');
  if (!['free-play','useful-mana'].includes(variant)) assert.equal(applied.length, 4);
  else { assert.equal(state.step, 'POSTCOMBAT_MAIN'); assert.equal(state.players[0].manaPool.red ?? 0, 0); }
});

test('[PM-AC-09-TURN] semantic play adopts only the initial own stack and cannot invent an expected stack object', () => {
  const state = { gameId: 'x', status: 'active', cursor: 1, stack: [], players: [{ id: 'me', yourSeat: true }] };
  const seat = new GameSeat({ snapshot: () => state });
  assert.throws(() => seat.startTurn({ gameId: 'x', cursor: 1, actions: [], expectedStackIds: ['not-visible'] }, async () => true), { code: 'bad_stack_expectation' });
});
