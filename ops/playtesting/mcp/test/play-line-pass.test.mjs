import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { GameSeat } from '../src/game-seat.mjs';

const pass = { id: 'pass', type: 'pass' };
const freePlay = { id: 'free-play', type: 'object' };
const priority = (id, ...choices) => ({ id, kind: 'priority', choices: [pass, ...choices] });
const evidence = { epoch: 'line-fixture', publicActions: { me: 0, opponent: 0 }, resolutions: {},
  resolutionRevision: 0, combatDamage: [], combatRevision: 0, informationRevision: 0 };

function game(t, transitions, initial) {
  const listeners = new Set();
  const applied = [];
  let state = {
    gameId: 'table-game', status: 'active', epoch: 1, cursor: 1, turn: 7, activePlayer: 'Opponent', activePlayerId: 'opponent',
    priority: 'self', step: 'END_TURN', ownHand: [], stack: [], decision: priority('end'),
    players: [{ id: 'me', yourSeat: true }, { id: 'opponent' }], sequenceEvidence: evidence, ...initial,
  };
  const publish = (change) => {
    state = { ...state, ...change, cursor: state.cursor + 1 };
    for (const listener of listeners) listener();
  };
  const seat = new GameSeat({
    snapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    async respond(decisionId, choiceId, value) {
      applied.push([decisionId, choiceId, value]);
      const transition = transitions[decisionId];
      assert.ok(transition, `Unexpected engine response to ${decisionId}`);
      if (typeof transition === 'function') transition(publish);
      else publish(transition);
      return { submitted: true };
    },
  }, { sequenceTimeoutMs: 250, maxSequenceWallMs: 1000 });
  t.after(() => seat.invalidate());
  return {
    seat, applied,
    submit: async (actions) => {
      const { sequenceId } = seat.startTurn({ gameId: state.gameId, cursor: state.cursor, actions, finish: 'none', settle: false }, async () => true);
      for (let i = 0; i < 100; i++) {
        const receipt = seat.sequenceStatus({ gameId: state.gameId, sequenceId });
        if (receipt.status !== 'running') return receipt;
        await sleep(5);
      }
      assert.fail('Expected the line to stop within the test deadline');
    },
  };
}

const upkeep = { turn: 8, activePlayer: 'Pilot', activePlayerId: 'me', decision: priority('upkeep'), step: 'UPKEEP' };
const drawnCard = { id: 'drawn-card', name: 'Island' };
const draw = {
  ...upkeep, step: 'DRAW', decision: priority('draw'), ownHand: [drawnCard],
  sequenceEvidence: { ...evidence, informationRevision: 1 },
};
const main = { ...draw, step: 'PRECOMBAT_MAIN', decision: priority('main') };

const urborg = { id: 'urborg', cardId: 'urborg', name: 'Urborg, Tomb of Yawgmoth', types: ['LAND'] };
const playUrborg = { kind: 'play', select: { cardId: urborg.id, zone: 'hand' } };
const openingUpkeep = { ...upkeep, turn: 1, ownHand: [urborg] };
const openingMain = {
  ...openingUpkeep, step: 'PRECOMBAT_MAIN', decision: priority('main', { id: 'play-urborg', card: urborg }),
};
const landPlayed = { ...openingMain, ownHand: [], decision: priority('after-land') };
const keep = { id: 'keep-prompt', kind: 'mulligan', choices: [{ id: 'keep', label: 'Keep', type: 'button' }] };
const keepHand = { kind: 'choose', decisionId: keep.id, choiceId: 'keep' };
const pregame = { turn: 0, activePlayerId: null, activePlayer: null, step: null, ownHand: [urborg], decision: keep };

test('[PM-LINE-01] keep, the first land on the play and its following priority pass form one line', async (t) => {
  const table = game(t, { 'keep-prompt': (publish) => {
    publish({ turn: 1, activePlayerId: 'me', activePlayer: 'Pilot', step: null, decision: null });
    publish(openingUpkeep);
  }, upkeep: openingMain, main: landPlayed, 'after-land': { decision: priority('combat') } }, pregame);
  const receipt = await table.submit([keepHand, playUrborg, { kind: 'pass_priority' }]);
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt));
  assert.equal(table.seat.snapshot().turn, 1);
  assert.deepEqual(table.applied.map(([id, choice]) => [id, choice]), [
    ['keep-prompt', 'keep'], ['upkeep', 'pass'], ['main', 'play-urborg'], ['after-land', 'pass'],
  ]);
});

test('[PM-LINE-01] an unplanned London bottom stops a keep and land line before the land', async (t) => {
  const bottom = { id: 'bottom', kind: 'mulliganBottom', choices: [{ id: 'bottom-urborg', card: urborg }] };
  const table = game(t, { 'keep-prompt': { decision: bottom } }, pregame);
  const receipt = await table.submit([keepHand, playUrborg]);
  assert.equal(receipt.reason, 'response_available');
  assert.equal(table.seat.snapshot().decision, bottom);
  assert.deepEqual(table.applied, [['keep-prompt', 'keep', undefined]]);
});

test('[PM-LINE-01] an exact London bottom stays in the opening line through public hand count updates', async (t) => {
  const island = { id: 'island', cardId: 'island', name: 'Island', types: ['LAND'] };
  const bottom = { id: 'bottom', kind: 'mulliganBottom', instruction: 'Choose a card to put on the bottom', choices: [
    { id: 'bottom-island', card: island }, { id: 'bottom-urborg', card: urborg },
  ] };
  const players = [{ id: 'me', yourSeat: true }, { id: 'opponent', handCount: 7, libraryCount: 53 }];
  const table = game(t, {
    'keep-prompt': { turn: 1, decision: bottom },
    bottom: { ...openingMain, players: [players[0], { ...players[1], handCount: 6, libraryCount: 54 }] },
    main: landPlayed,
  }, { ...pregame, players, ownHand: [urborg, island] });
  const receipt = await table.submit([keepHand, {
    kind: 'choose', guard: { kind: 'mulliganBottom', instruction: bottom.instruction }, select: { cardId: island.id },
  }, playUrborg]);
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt));
  assert.deepEqual(table.applied.map(([id, choice]) => [id, choice]), [
    ['keep-prompt', 'keep'], ['bottom', 'bottom-island'], ['main', 'play-urborg'],
  ]);
});

test('[PM-LINE-01] a keep cannot carry a queued land through the opponent’s first turn', async (t) => {
  const table = game(t, { 'keep-prompt': { ...openingUpkeep, activePlayerId: 'opponent', activePlayer: 'Opponent' } }, pregame);
  const receipt = await table.submit([keepHand, playUrborg]);
  assert.equal(receipt.reason, 'turn_changed');
  assert.deepEqual(table.applied, [['keep-prompt', 'keep', undefined]]);
});

test('[PM-LINE-01] submitting a keep alone observes the new turn without passing', async (t) => {
  const table = game(t, { 'keep-prompt': openingUpkeep }, pregame);
  const receipt = await table.submit([keepHand]);
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt));
  assert.equal(table.seat.snapshot().decision.id, openingUpkeep.decision.id);
  assert.deepEqual(table.applied, [['keep-prompt', 'keep', undefined]]);
});

test('[PM-LINE-02] an explicit draw destination started in opening upkeep reports the omitted draw', async (t) => {
  const table = game(t, { upkeep: openingMain, main: landPlayed, 'after-land': { decision: priority('combat') } }, openingUpkeep);
  const receipt = await table.submit([{ kind: 'pass_until', destination: 'my_draw' }]);
  assert.equal(receipt.reason, 'destination_skipped');
  assert.equal(receipt.lastDestination.step, 'PRECOMBAT_MAIN');
  assert.equal(receipt.lastDestination.turn, 1);
  assert.deepEqual(table.applied, [['upkeep', 'pass', undefined]]);
});

test('[PM-LINE-02] after playing Urborg the terminal draw destination aims beyond the skipped opening draw', async (t) => {
  const nextDraw = { ...draw, turn: 3 };
  const table = game(t, { 'keep-prompt': openingUpkeep, upkeep: openingMain, main: landPlayed, 'after-land': nextDraw }, pregame);
  const receipt = await table.submit([keepHand, playUrborg, { kind: 'pass_until', destination: 'my_draw' }]);
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt));
  assert.equal(receipt.lastDestination.step, 'DRAW');
  assert.equal(receipt.lastDestination.turn, 3);
  assert.equal(receipt.observedNewInformation, true);
  assert.deepEqual(table.applied.map(([id]) => id), ['keep-prompt', 'upkeep', 'main', 'after-land']);
});

test('[PM-LINE-02] on the play, a terminal priority pass can follow Urborg in the same line', async (t) => {
  const table = game(t, { upkeep: openingMain, main: landPlayed, 'after-land': { decision: priority('combat') } }, openingUpkeep);
  const receipt = await table.submit([playUrborg, { kind: 'pass_priority' }]);
  assert.equal(receipt.status, 'completed');
  assert.deepEqual(table.applied, [
    ['upkeep', 'pass', undefined], ['main', 'play-urborg', undefined], ['after-land', 'pass', undefined],
  ]);
});

test('[PM-LINE-01] on the draw, the revealed opening draw interrupts the queued land and pass', async (t) => {
  const table = game(t, { upkeep: { ...draw, turn: 1, ownHand: [urborg, drawnCard] } }, openingUpkeep);
  const receipt = await table.submit([playUrborg, { kind: 'pass_priority' }]);
  assert.equal(receipt.reason, 'new_information');
  assert.equal(table.seat.snapshot().step, 'DRAW');
  assert.deepEqual(table.applied, [['upkeep', 'pass', undefined]]);
});

test('[PM-LINE-02] safe pass considers a legal free play even with an empty mana pool', async (t) => {
  const table = game(t, {}, { decision: priority('end', freePlay) });
  const receipt = await table.submit([{ kind: 'pass_until', destination: 'my_upkeep' }]);
  assert.equal(receipt.reason, 'response_available');
  assert.deepEqual(table.applied, []);
});

test('[PM-LINE-02] an explicit decline preserves secrecy and stops at own upkeep before the draw', async (t) => {
  const table = game(t, { end: upkeep }, { decision: priority('end', freePlay) });
  const receipt = await table.submit([{ kind: 'pass_until', destination: 'my_upkeep', policy: 'decline_optional' }]);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.lastDestination.step, 'UPKEEP');
  assert.equal(receipt.lastDestination.turn, 8);
  assert.deepEqual(table.applied, [['end', 'pass', undefined]]);
});

test('[PM-LINE-02] own draw stops at the first actionable view with the new card', async (t) => {
  const table = game(t, { end: upkeep, upkeep: (publish) => {
    publish({ ...draw, decision: null });
    setTimeout(() => publish({ decision: draw.decision }), 5);
  } });
  const receipt = await table.submit([{ kind: 'pass_until', destination: 'my_draw' }]);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.lastDestination.step, 'DRAW');
  assert.equal(receipt.observedNewInformation, true);
  assert.equal(table.seat.snapshot().decision.id, 'draw');
  assert.deepEqual(table.applied.map(([id]) => id), ['end', 'upkeep']);
});

test('[PM-LINE-02] skipped upkeep reports the actual decision and submits no draw-window pass', async (t) => {
  const table = game(t, { end: main });
  const receipt = await table.submit([{ kind: 'pass_until', destination: 'my_upkeep' }]);
  assert.equal(receipt.reason, 'destination_skipped');
  assert.equal(receipt.lastDestination.step, 'PRECOMBAT_MAIN');
  assert.equal(receipt.observedNewInformation, true);
  assert.equal(table.seat.snapshot().decision.id, 'main');
  assert.deepEqual(table.applied.map(([id]) => id), ['end']);
});

test('[PM-LINE-02] a passed-over draw window returns the actual post-draw decision without another pass', async (t) => {
  const table = game(t, { end: main });
  const receipt = await table.submit([{ kind: 'pass_until', destination: 'my_draw' }]);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.lastDestination.step, 'PRECOMBAT_MAIN');
  assert.deepEqual(table.applied.map(([id]) => id), ['end']);
});

for (const skipped of [
  { ...upkeep, step: 'DRAW', decision: priority('draw') },
  { ...upkeep, step: 'PRECOMBAT_MAIN', decision: priority('main') },
  { ...main, ownHand: [] },
]) test(`[PM-LINE-02] a missed draw reports the real ${skipped.step} window without claiming a card`, async (t) => {
  const table = game(t, { end: skipped });
  const receipt = await table.submit([{ kind: 'pass_until', destination: 'my_draw' }]);
  assert.equal(receipt.reason, 'destination_skipped');
  assert.equal(receipt.lastDestination.step, skipped.step);
  assert.deepEqual(table.applied.map(([id]) => id), ['end']);
});

test('[PM-LINE-02] a line at own upkeep can advance to this turn’s draw', async (t) => {
  const table = game(t, { upkeep: draw }, upkeep);
  const receipt = await table.submit([{ kind: 'pass_until', destination: 'my_draw', policy: 'decline_optional' }]);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.lastDestination.turn, 8);
  assert.equal(receipt.lastDestination.step, 'DRAW');
  assert.equal(receipt.observedNewInformation, true);
  assert.deepEqual(table.applied.map(([id]) => id), ['upkeep']);
});

for (const [cause, transition, reason] of [
  ['opponent action', { ...upkeep, sequenceEvidence: { ...evidence, publicActions: { me: 0, opponent: 1 } } }, 'opponent_action'],
  ['unseen mandatory choice', { step: 'CLEANUP', decision: { id: 'trigger-choice', kind: 'target', choices: [] } }, 'response_available'],
  ['unplanned new information before the draw boundary', { ...upkeep, ownHand: [drawnCard], sequenceEvidence: draw.sequenceEvidence }, 'new_information'],
]) test(`[PM-LINE-02] explicit decline still stops for ${cause}`, async (t) => {
  const table = game(t, { end: transition });
  const receipt = await table.submit([{ kind: 'pass_until', destination: 'my_draw', policy: 'decline_optional' }]);
  assert.equal(receipt.reason, reason);
  assert.deepEqual(table.applied.map(([id]) => id), ['end']);
});

test('[PM-LINE-02] passing to the current end step does not consume the decision there', async (t) => {
  const table = game(t, { main: { step: 'END_TURN', decision: priority('end') } }, { step: 'POSTCOMBAT_MAIN', decision: priority('main') });
  const receipt = await table.submit([{ kind: 'pass_until', destination: 'end_step' }]);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.lastDestination.step, 'END_TURN');
  assert.deepEqual(table.applied.map(([id]) => id), ['main']);
});

test('[PM-LINE-02] a current-turn destination can stop on an opponent priority handoff', async (t) => {
  const table = game(t, { end: { priority: 'opponent', decision: null, phase: 'ENDING' } });
  const receipt = await table.submit([{ kind: 'pass_until', destination: 'current_turn', priority: 'opponent', phase: 'ENDING' }]);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.lastDestination.step, 'END_TURN');
  assert.deepEqual(table.applied.map(([id]) => id), ['end']);
});

test('[PM-LINE-02] missing a current-turn destination never passes into a new turn', async (t) => {
  const table = game(t, { end: upkeep });
  const receipt = await table.submit([{ kind: 'pass_until', destination: 'current_turn', step: 'CLEANUP', policy: 'decline_optional' }]);
  assert.equal(receipt.reason, 'destination_skipped');
  assert.equal(receipt.lastDestination.step, 'UPKEEP');
  assert.deepEqual(table.applied.map(([id]) => id), ['end']);
});

test('[PM-LINE-02] a current-turn destination requires a phase, step or priority', async (t) => {
  const table = game(t, {});
  await assert.rejects(table.submit([{ kind: 'pass_until', destination: 'current_turn' }]), { code: 'bad_sequence' });
  assert.deepEqual(table.applied, []);
});

test('[PM-LINE-02] a deliberate priority pass yields exactly once and waits for a fresh decision', async (t) => {
  const table = game(t, { end: (publish) => {
    publish({ decision: null, priority: 'opponent' });
    setTimeout(() => publish({ ...upkeep, priority: 'self' }), 5);
  } }, { decision: priority('end', freePlay) });
  const receipt = await table.submit([{ kind: 'pass_priority' }]);
  assert.equal(receipt.status, 'completed');
  assert.equal(table.seat.snapshot().decision.id, 'upkeep');
  assert.deepEqual(table.applied.map(([id]) => id), ['end']);
});

test('[PM-LINE-02] a deliberate pass waits for a declared activation to appear on the stack', async (t) => {
  const source = { id: 'source', name: 'Class' };
  const table = game(t, {
    end: { decision: priority('after-activation') },
    'after-activation': { decision: priority('next') },
  }, {
    decision: priority('end', { id: 'activate', type: 'object', objectId: source.id, card: source }),
    players: [{ id: 'me', yourSeat: true, battlefield: [source] }, { id: 'opponent' }],
  });
  const receipt = await table.submit([
    { kind: 'choose', decisionId: 'end', choiceId: 'activate', expectAbility: { sourceId: 'source', abilityText: 'Level 2' } },
    { kind: 'pass_priority' },
  ]);
  assert.equal(receipt.reason, 'response_available');
  assert.deepEqual(table.applied.map(([, id]) => id), ['activate']);
});

test('[PM-LINE-02] a current-turn stop cannot complete before a pending spell target arrives', async (t) => {
  const bolt = { id: 'bolt', cardId: 'bolt', name: 'Lightning Bolt', types: ['INSTANT'] };
  const target = { id: 'target', kind: 'target', choices: [{ id: 'legal-target', type: 'object' }] };
  const table = game(t, { main: (publish) => {
    publish({ decision: null });
    setTimeout(() => publish({ decision: target }), 5);
  } }, {
    turn: 8, activePlayer: 'Pilot', activePlayerId: 'me', step: 'PRECOMBAT_MAIN', ownHand: [bolt],
    decision: priority('main', { id: 'cast', type: 'object', card: bolt }),
  });
  const receipt = await table.submit([
    { kind: 'play', select: { cardId: 'bolt', zone: 'hand' } },
    { kind: 'pass_until', destination: 'current_turn', priority: 'self' },
  ]);
  assert.equal(receipt.reason, 'response_available');
  assert.equal(table.seat.snapshot().decision.id, target.id);
  assert.deepEqual(table.applied.map(([, id]) => id), ['cast']);
});

test('[PM-LINE-02] explicit passes must be the final action', async (t) => {
  const table = game(t, {});
  await assert.rejects(table.submit([{ kind: 'pass_priority' }, { kind: 'pass_until', destination: 'my_draw' }]), { code: 'bad_sequence' });
  assert.deepEqual(table.applied, []);
});

test('[PM-LINE-01] a single exact observed choice waits for new state without an implicit pass', async (t) => {
  const table = game(t, { selection: (publish) => {
    setTimeout(() => publish({ decision: priority('later') }), 5);
  } }, { decision: { id: 'selection', kind: 'unknownEnginePrompt', choices: [{ id: 'exact' }] }, sequenceEvidence: undefined });
  const receipt = await table.submit([{ kind: 'choose', decisionId: 'selection', choiceId: 'exact', value: [1, 3] }]);
  assert.equal(receipt.status, 'completed');
  assert.equal(table.seat.snapshot().decision.id, 'later');
  assert.deepEqual(table.applied, [['selection', 'exact', [1, 3]]]);
});
