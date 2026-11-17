import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { GameSeat } from '../src/game-seat.mjs';

test('a two-spell line selects its exact public mana source, resolves each planned spell and finishes in the same turn', async (t) => {
  const first = { id: 'first', cardId: 'physical-first', name: 'First spell', types: ['SORCERY'] };
  const second = { id: 'second', cardId: 'physical-second', name: 'Second spell', types: ['SORCERY'] };
  const ownLands = [1, 2].map((index) => ({ id: `own-land-${index}`, name: 'Mountain', tapped: false }));
  const rivalLand = { id: 'rival-land', name: 'Mountain', tapped: false };
  const pass = { id: 'pass', type: 'pass' };
  const priority = (id, cards = []) => ({ id, kind: 'priority', choices: [pass,
    ...cards.map((card) => ({ id: `cast-${card.id}`, type: 'object', card }))] });
  let state = { gameId: 'integration', status: 'active', epoch: 1, cursor: 1, turn: 4,
    activePlayer: 'Pilot', step: 'PRECOMBAT_MAIN', priority: 'self', stack: [], ownHand: [first, second],
    players: [{ id: 'pilot', yourSeat: true, battlefield: ownLands }, { id: 'rival', battlefield: [rivalLand] }],
    decision: priority('cast-first', [first]) };
  const listeners = new Set();
  const accepted = [];
  const timers = [];
  const update = (change) => {
    state = { ...state, ...change, cursor: state.cursor + 1 };
    for (const listener of [...listeners]) listener();
  };
  const later = (change) => timers.push(setTimeout(() => update(change), 5));
  const seat = new GameSeat({
    snapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    respond: async (decisionId, choiceId) => {
      accepted.push([decisionId, choiceId]);
      if (decisionId === 'cast-first' || decisionId === 'cast-second') {
        const card = decisionId === 'cast-first' ? first : second;
        const land = ownLands[card === first ? 0 : 1];
        update({ ownHand: state.ownHand.filter((item) => item.id !== card.id),
          stack: [{ ...card, id: `stack-${card.id}`, controllerId: 'pilot' }],
          decision: { id: `pay-${card.id}`, kind: 'payMana', choices: [{ id: `tap-${land.id}`, type: 'manaAbility', card: land }] } });
      } else if (decisionId.startsWith('pay-')) {
        update({ players: state.players.map((player) => player.yourSeat ? { ...player,
          battlefield: player.battlefield.map((card) => card.id === choiceId.slice(4) ? { ...card, tapped: true } : card),
        } : player) });
        later({ decision: priority(decisionId === 'pay-first' ? 'yield-first' : 'yield-second') });
      } else if (decisionId === 'yield-first' || decisionId === 'yield-second') {
        update({ priority: 'opponent', decision: null });
        later({ stack: [], priority: 'self', decision: decisionId === 'yield-first'
          ? priority('cast-second', [second]) : priority('advance-end') });
      } else if (decisionId === 'advance-end') {
        update({ step: 'END_TURN', decision: priority('end') });
      } else assert.fail('Unexpected decision submitted by the integrated line');
      return { submitted: true };
    },
  });
  t.after(() => { timers.forEach(clearTimeout); seat.invalidate(); });
  const cast = (card) => ({ kind: 'answer', select: { cardId: card.id, zone: 'hand' },
    guard: { kind: 'priority', step: 'PRECOMBAT_MAIN', priority: 'self' }, expectCast: true });
  const pay = (cardId) => ({ kind: 'answer', select: { cardId, zone: 'battlefield' },
    guard: { kind: 'payMana', step: 'PRECOMBAT_MAIN' } });
  const started = seat.startSequence({ gameId: state.gameId, cursor: state.cursor, steps: [
    cast(first), pay('own-land-1'), { kind: 'yield_priority', allowPlannedResolutions: true },
    cast(second), pay('own-land-2'), { kind: 'pass_until', stackEmpty: true, priority: 'self', allowPlannedResolutions: true },
    { kind: 'pass_until', step: 'END_TURN' },
  ] }, async () => true);
  let result;
  for (let i = 0; i < 100; i++) {
    result = seat.sequenceStatus({ gameId: state.gameId, sequenceId: started.sequenceId });
    if (result.status !== 'running') break;
    await sleep(5);
  }
  assert.equal(result.status, 'completed');
  assert.equal(result.completedSteps, 7);
  assert.deepEqual(accepted, [
    ['cast-first', 'cast-first'], ['pay-first', 'tap-own-land-1'], ['yield-first', 'pass'],
    ['cast-second', 'cast-second'], ['pay-second', 'tap-own-land-2'], ['yield-second', 'pass'], ['advance-end', 'pass'],
  ]);
  assert.equal(state.turn, 4);
  assert.equal(state.step, 'END_TURN');
  assert.equal(state.decision.id, 'end');
  assert.deepEqual(state.stack, []);
  assert.deepEqual(state.players[1].battlefield, [rivalLand]);
  assert.deepEqual(state.players[0].battlefield.map((card) => card.tapped), [true, true]);
});
