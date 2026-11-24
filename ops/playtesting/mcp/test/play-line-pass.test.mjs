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

const forest = { id: 'forest', cardId: 'forest', name: 'Forest', types: ['LAND'] };
const londonBottom = { id: 'bottom', kind: 'mulliganBottom', choices: [{ id: 'bottom-forest', card: forest }] };
const bottomForest = { kind: 'choose', decisionId: londonBottom.id, choiceId: 'bottom-forest' };
const keepSix = { ...keep, instruction: 'Mulligan down to 5 cards?' };
const guardedKeep = { kind: 'choose', guard: { kind: 'mulligan', instruction: keepSix.instruction }, select: { label: 'Keep' } };
const bottomState = { ...pregame, decision: londonBottom, ownHand: [forest, urborg] };

for (const [start, firstPriority, reason] of [
  ['own upkeep', openingUpkeep, undefined],
  ['opponent upkeep', { ...openingUpkeep, activePlayerId: 'opponent', activePlayer: 'Opponent' }, 'turn_changed'],
  ['a revealed card', { ...openingUpkeep, sequenceEvidence: { ...evidence, informationRevision: 1 } }, 'new_information'],
  ['an opponent response', { ...openingUpkeep,
    sequenceEvidence: { ...evidence, publicActions: { me: 0, opponent: 1 } } }, 'opponent_action'],
]) {
  test('London bottom and guarded Keep followed by the first land at ' + start, async (t) => {
    const table = game(t, {
      bottom: { decision: keepSix, ownHand: [urborg] },
      'keep-prompt': firstPriority, upkeep: openingMain, main: landPlayed,
    }, bottomState);
    const receipt = await table.submit([bottomForest, guardedKeep, playUrborg]);
    const expected = [['bottom', 'bottom-forest'], ['keep-prompt', 'keep']];
    if (reason) assert.equal(receipt.reason, reason);
    else {
      assert.equal(receipt.status, 'completed', receipt.reason);
      expected.push(['upkeep', 'pass'], ['main', 'play-urborg']);
    }
    assert.deepEqual(table.applied.map(([id, choice]) => [id, choice]), expected);
  });
}

test('London bottom and guarded Keep return a different mulligan instruction to the pilot', async (t) => {
  const table = game(t, { bottom: { decision: { ...keepSix, instruction: 'Mulligan for free?' }, ownHand: [urborg] } }, bottomState);
  const receipt = await table.submit([bottomForest, guardedKeep, playUrborg]);
  assert.equal(receipt.reason, 'response_available');
  assert.deepEqual(table.applied, [['bottom', 'bottom-forest', undefined]]);
});

test('London bottom and guarded Keep stop before choosing from a second unseen hand', async (t) => {
  const table = game(t, { bottom: { decision: keepSix, ownHand: [urborg, drawnCard],
    sequenceEvidence: { ...evidence, informationRevision: 1 } } }, bottomState);
  const receipt = await table.submit([bottomForest, guardedKeep, playUrborg]);
  assert.equal(receipt.reason, 'new_information');
  assert.deepEqual(table.applied, [['bottom', 'bottom-forest', undefined]]);
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

for (const [fixtureName, text, controllerId, drawerId] of [
  ['Sheoldred on the opponent draw', 'Whenever an opponent draws a card, they lose 2 life.', 'me', 'opponent'],
  ['Sheoldred on the pilot draw', 'Whenever you draw a card, you gain 2 life.', 'me', 'me'],
  ['Howling Mine on either draw', "At the beginning of each player's draw step, that player draws an additional card.", 'opponent', 'opponent'],
]) test(`[PM-LINE-FLOW-6] stops at upkeep before ${fixtureName} and allows an explicit new line`, async (t) => {
  // The upkeep offers a legal play, so it is the last useful window before the draw.
  const nextUpkeep = { ...upkeep, activePlayerId: drawerId, activePlayer: drawerId === 'me' ? 'Pilot' : 'Opponent', decision: priority('upkeep', freePlay) };
  const source = { id: 'source', cardId: 'source', controllerId, rules: [text] };
  const players = ['me', 'opponent'].map((id) => ({ id, yourSeat: id === 'me', battlefield: id === controllerId ? [source] : [] }));
  const table = game(t, { end: nextUpkeep, upkeep: drawerId === 'me' ? draw : { ...nextUpkeep, step: 'DRAW', decision: priority('draw') },
    draw: { ...upkeep, turn: 9 }, }, {
    activePlayerId: drawerId === 'me' ? 'opponent' : 'me', activePlayer: drawerId === 'me' ? 'Opponent' : 'Pilot', players,
  });
  const advance = { kind: 'pass_until', destination: 'my_draw', policy: 'decline_optional' };
  const stopped = await table.submit([advance]);
  assert.equal(stopped.reason, 'before_draw_trigger');
  assert.equal(stopped.lastDestination.step, 'UPKEEP');
  assert.equal(stopped.lastDestination.activePlayerId, drawerId);
  assert.deepEqual(table.applied.map(([id]) => id), ['end']);

  const deliberate = await table.submit([{ kind: 'pass_priority' }]);
  assert.equal(deliberate.status, drawerId === 'me' ? 'interrupted' : 'completed');
  assert.deepEqual(table.applied.map(([id]) => id), ['end', 'upkeep']);
});

test('[PM-LINE-FLOW-6] a queued cast cannot pass the upcoming upkeep after a draw trigger enters play', async (t) => {
  const sheoldred = { id: 'sheoldred', cardId: 'sheoldred', controllerId: 'me', name: 'Sheoldred, the Apocalypse',
    types: ['CREATURE'], rules: ['Whenever an opponent draws a card, they lose 2 life.'] };
  const spell = { ...sheoldred, id: 'sheoldred-stack' };
  const opponentUpkeep = { ...upkeep, activePlayerId: 'opponent', activePlayer: 'Opponent', decision: priority('upkeep', freePlay) };
  const table = game(t, {
    cast: { stack: [spell], ownHand: [], decision: priority('resolve') },
    resolve: { stack: [], players: [{ id: 'me', yourSeat: true, battlefield: [sheoldred] }, { id: 'opponent' }],
      decision: priority('end'), step: 'END_TURN',
      sequenceEvidence: { ...evidence, resolutions: { [spell.id]: 1 }, resolutionRevision: 1 } },
    end: opponentUpkeep,
    upkeep: { ...opponentUpkeep, step: 'DRAW', decision: priority('their-draw') },
  }, { activePlayerId: 'me', activePlayer: 'Pilot', step: 'PRECOMBAT_MAIN', ownHand: [sheoldred],
    decision: priority('cast', { id: 'cast-sheoldred', objectId: sheoldred.id, card: sheoldred }) });
  const stopped = await table.submit([
    { kind: 'play', select: { objectId: sheoldred.id, zone: 'hand' } },
    { kind: 'pass_until', destination: 'my_draw', policy: 'decline_optional' },
  ]);
  assert.equal(stopped.reason, 'before_draw_trigger');
  assert.equal(stopped.lastDestination.step, 'UPKEEP');
  assert.deepEqual(table.applied.map(([id]) => id), ['cast', 'resolve', 'end']);
});

test('[PM-LINE-FLOW-6] a new flash draw trigger stops a line that already started in upkeep', async (t) => {
  const source = { id: 'flash-source', cardId: 'flash-source', controllerId: 'me', name: 'Flash source',
    types: ['CREATURE'], rules: ['Flash', 'Whenever you draw a card, put a +1/+1 counter on this creature.'] };
  const spell = { ...source, id: 'flash-stack' };
  const table = game(t, {
    upkeep: { stack: [spell], ownHand: [], decision: priority('resolve-flash') },
    'resolve-flash': { stack: [], players: [{ id: 'me', yourSeat: true, battlefield: [source] }, { id: 'opponent' }],
      decision: priority('after-flash', freePlay), sequenceEvidence: { ...evidence, resolutions: { [spell.id]: 1 }, resolutionRevision: 1 } },
    'after-flash': { ...draw, sequenceEvidence: { ...draw.sequenceEvidence, resolutions: { [spell.id]: 1 }, resolutionRevision: 1 } },
  }, { ...upkeep, ownHand: [source], decision: priority('upkeep', { id: 'cast-flash', objectId: source.id, card: source }) });
  const stopped = await table.submit([
    { kind: 'play', select: { objectId: source.id, zone: 'hand' } },
    { kind: 'pass_until', destination: 'my_draw', policy: 'decline_optional' },
  ]);
  assert.equal(stopped.reason, 'before_draw_trigger');
  assert.equal(stopped.lastDestination.step, 'UPKEEP');
  assert.deepEqual(table.applied.map(([id]) => id), ['upkeep', 'resolve-flash']);
});

for (const [name, choices] of [
  ['only a pass', []],
  ['a pass and plain mana', [{ id: 'mountain', type: 'manaAbility', plainMana: true }]],
]) test(`[PM-LINE-FLOW-6] an upkeep with ${name} offers no window before Sheoldred's draw trigger`, async (t) => {
  const sheoldred = { id: 'sheoldred', cardId: 'sheoldred', controllerId: 'opponent', rules: ['Whenever you draw a card, you gain 2 life.'] };
  const opponentUpkeep = { ...upkeep, activePlayerId: 'opponent', activePlayer: 'Opponent', decision: priority('upkeep', ...choices) };
  const table = game(t, { end: opponentUpkeep, upkeep: { ...opponentUpkeep, step: 'END_TURN', decision: priority('their-end') } }, {
    activePlayerId: 'me', activePlayer: 'Pilot', players: [{ id: 'me', yourSeat: true, battlefield: [] }, { id: 'opponent', battlefield: [sheoldred] }],
  });
  const receipt = await table.submit([{ kind: 'pass_until', destination: 'my_upkeep', policy: 'decline_optional' }]);
  assert.notEqual(receipt.reason, 'before_draw_trigger');
  assert.deepEqual(table.applied.map(([id]) => id).slice(0, 2), ['end', 'upkeep']);
});

for (const [name, source] of [
  ['a source that applies only to the other player', { rules: ['Whenever an opponent draws a card, they lose 2 life.'] }],
  ['a card draw effect whose trigger is unrelated', { rules: ['Whenever you cast a spell, draw a card.'] }],
  ['a face-down source', { faceDown: true, rules: ['Whenever you draw a card, you gain 2 life.'] }],
]) test(`[PM-LINE-FLOW-6] does not stop before a normal own draw without a relevant public trigger: ${name}`, async (t) => {
  const table = game(t, { end: upkeep, upkeep: draw }, {
    players: [{ id: 'me', yourSeat: true, battlefield: [{ id: 'source', controllerId: 'me', ...source }] }, { id: 'opponent' }],
  });
  const result = await table.submit([{ kind: 'pass_until', destination: 'my_draw', policy: 'decline_optional' }]);
  assert.equal(result.status, 'completed');
  assert.equal(result.lastDestination.step, 'DRAW');
  assert.deepEqual(table.applied.map(([id]) => id), ['end', 'upkeep']);
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

for (const [wanted, previous, actual] of [
  ['BEGIN_COMBAT', 'PRECOMBAT_MAIN', 'POSTCOMBAT_MAIN'],
  ['POSTCOMBAT_MAIN', 'END_COMBAT', 'END_TURN'],
]) {
  test(`[PM-LINE-02] skipped ${wanted} leaves the first later visible priority untouched`, async t => {
    const table = game(t, { before: { step: actual, decision: priority('later') } },
      { ...upkeep, step: previous, decision: priority('before') });
    const receipt = await table.submit([{ kind: 'pass_until', destination: 'current_turn',
      step: wanted, priority: 'self', policy: 'decline_optional' }]);
    assert.equal(receipt.reason, 'destination_skipped');
    assert.equal(receipt.lastDestination.step, actual);
    assert.deepEqual(table.applied.map(([id]) => id), ['before']);
  });
}

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

test('[PM-LINE-SEM-4] a conditional source with only tap-for-mana options permits a safe automatic pass', async (t) => {
  const verge = { id: 'verge', name: 'Riverpyre Verge', rules: ['{T}: Add {R}.', '{T}: Add {U}. Activate only if you control an Island or a Mountain.'] };
  const ownUpkeep = { ...upkeep, decision: priority('upkeep', {
    id: 'use-verge', type: 'manaAbility', card: verge, plainMana: true,
  }) };
  const table = game(t, { upkeep: draw }, ownUpkeep);
  const receipt = await table.submit([{ kind: 'pass_until', destination: 'my_draw' }]);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.observedNewInformation, true);
  assert.equal(table.seat.snapshot().step, 'DRAW');
  assert.deepEqual(table.applied, [['upkeep', 'pass', undefined]]);
});

test('[PM-LINE-SEM-4] playable mana with a side effect stays actionable', async (t) => {
  const reef = { id: 'reef', name: 'Shivan Reef', rules: ['{T}: Add {C}.', '{T}: Add {U} or {R}. Shivan Reef deals 1 damage to you.'] };
  const ownUpkeep = { ...upkeep, decision: priority('upkeep', {
    id: 'use-reef', type: 'manaAbility', card: reef, plainMana: false,
  }) };
  const table = game(t, {}, ownUpkeep);
  const receipt = await table.submit([{ kind: 'pass_until', destination: 'my_draw' }]);
  assert.equal(receipt.reason, 'response_available');
  assert.deepEqual(table.applied, []);
});

test('[PM-LINE-SEM-1] a colored payment selects an exact ability at its source and witnesses pain', async (t) => {
  const spell = { id: 'cast-object', cardId: 'talent-card', name: 'Stormchaser’s Talent', types: ['ENCHANTMENT'] };
  const source = { id: 'reef', cardId: 'reef-card', name: 'Shivan Reef', types: ['LAND'] };
  const players = [{ id: 'me', yourSeat: true, life: 20, battlefield: [source] }, { id: 'opponent' }];
  const panel = { id: 'panel', kind: 'panel', sourceObjectId: source.id, choices: [
    { id: 'colorless', abilityId: 'colorless-ability', abilityType: 'ACTIVATED_MANA', manaColors: ['C'] },
    { id: 'blue', abilityId: 'blue-ability', abilityType: 'ACTIVATED_MANA', manaColors: ['U'] },
    { id: 'red', abilityId: 'red-ability', abilityType: 'ACTIVATED_MANA', manaColors: ['R'] },
  ] };
  const current = { ...openingMain, ownHand: [spell], players, decision: priority('start', { id: 'cast', card: spell, objectId: spell.id }) };
  const waiting = { id: 'pay', kind: 'payMana', choices: [{ id: 'tap-reef', card: source, objectId: source.id,
    manaAbilities: panel.choices.map(({ abilityId, manaColors }) => ({ abilityId, manaColors })),
  }] };
  const table = game(t, { start: { decision: waiting }, pay: { decision: panel },
    panel: { decision: priority('next'), players: [{ ...players[0], life: 19 }, players[1]],
      stack: [{ ...spell, id: 'spell-stack', controllerId: 'me' }] } }, current);
  const receipt = await table.submit([{ kind: 'play', select: { objectId: spell.id }, payWith: [{ sourceId: source.id, color: 'U' }] }]);
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt));
  assert.deepEqual(table.applied, [['start', 'cast', undefined], ['pay', 'tap-reef', undefined], ['panel', 'blue', undefined]]);
  assert.equal(table.seat.snapshot().players[0].life, 19);
});

test('[PM-LINE-SEM-3] an ordered public target uses its live role without an instruction', async (t) => {
  const spell = { id: 'spell-object', cardId: 'spell-card', name: 'Temporary Strength', types: ['INSTANT'] };
  const creature = { id: 'creature-object', cardId: 'creature-card', name: 'Creature', types: ['CREATURE'] };
  const current = { ...openingMain, ownHand: [spell], players: [{ id: 'me', yourSeat: true, battlefield: [creature] }, { id: 'opponent' }],
    decision: priority('start', { id: 'cast', card: spell, objectId: spell.id }) };
  const target = { id: 'target', kind: 'target', targetZone: 'BATTLEFIELD', targetSourceId: spell.id, targetRole: 0,
    instruction: 'Select a creature', choices: [{ id: 'creature', objectId: creature.id, card: creature }] };
  const table = game(t, { start: { decision: target },
    target: { decision: priority('next'), stack: [{ ...spell, id: 'spell-stack', controllerId: 'me', targets: [creature.id] }] } }, current);
  const receipt = await table.submit([{ kind: 'play', select: { objectId: spell.id },
    targets: [{ select: { objectId: creature.id }, targetZone: 'BATTLEFIELD', role: 0 }] }]);
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt));
  assert.deepEqual(table.applied, [['start', 'cast', undefined], ['target', 'creature', undefined]]);
});

for (const knownTarget of [true, false]) test(`[PM-LINE-SEM-3] a named cast resumes payment after its exact automatic stack target, matched: ${knownTarget}`, async (t) => {
  const counter = { id: 'counter-hand', cardId: 'counter-source', name: 'Precise Redaction', types: ['INSTANT'] };
  const target = { id: 'rival-spell', name: 'Visible rival spell', controllerId: 'opponent' };
  const land = { id: 'island', name: 'Island', types: ['LAND'] };
  const players = [{ id: 'me', yourSeat: true, battlefield: [land] }, { id: 'opponent' }];
  const current = { ...openingMain, ownHand: [counter], stack: [target], players,
    decision: priority('start', { id: 'cast', card: counter, objectId: counter.id }) };
  const cast = { ...counter, id: 'counter-stack', controllerId: 'me', targets: [knownTarget ? target.id : 'different-object'] };
  const payment = { id: 'pay', kind: 'payMana', choices: [{ id: 'tap-island', card: land, objectId: land.id }] };
  const table = game(t, {
    start: { ownHand: [], stack: [cast, target], decision: payment },
    pay: { decision: priority('after-payment') },
  }, current);
  const receipt = await table.submit([{ kind: 'play', when: 'priority', select: { cardName: counter.name, zone: 'hand' },
    targets: [{ select: { objectId: target.id }, targetZone: 'STACK', role: 0 }], payWith: [land.id] }]);
  assert.equal(receipt.status, knownTarget ? 'completed' : 'interrupted', JSON.stringify(receipt));
  assert.deepEqual(table.applied.map(([id, choice]) => [id, choice]),
    [['start', 'cast'], ...(knownTarget ? [['pay', 'tap-island']] : [])]);
});

test('[PM-LINE-FLOW-2] a boolean answer selects the current legal engine action by meaning', async (t) => {
  const decision = { id: 'question', kind: 'question', choices: [
    { id: 'one', label: 'Let it go', answer: false }, { id: 'two', label: 'Do it', answer: true },
  ] };
  const table = game(t, { question: { decision: priority('next') } }, { ...openingMain, decision });
  const receipt = await table.submit([{ kind: 'choose', decisionId: decision.id, select: { answer: false } }]);
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt));
  assert.deepEqual(table.applied, [['question', 'one', undefined]]);
});


for (const matchingSource of [true, false]) {
  test(`[PM-LINE-SEM-2] a named mode stays bound to the cast source: ${matchingSource}`, async (t) => {
    const spell = { id: 'known-spell', cardId: 'print', name: 'Two options', types: ['SORCERY'] };
    const panel = { id: 'mode-panel', kind: 'panel', modePicker: true, sourceObjectId: matchingSource ? spell.id : 'other-source', choices: [
      { id: 'fence', abilityId: 'fence-id', label: 'Fence — Put a counter on target creature.', type: 'option' },
    ] };
    const current = { ...openingMain, ownHand: [spell], decision: priority('start', { id: 'cast', card: spell, objectId: spell.id }) };
    const table = game(t, { start: { decision: panel },
      'mode-panel': { decision: priority('next'), stack: [{ ...spell, id: 'stack', controllerId: 'me' }] } }, current);
    const receipt = await table.submit([{ kind: 'play', select: { objectId: spell.id }, mode: 'Fence' }]);
    assert.equal(receipt.status, matchingSource ? 'completed' : 'interrupted', JSON.stringify(receipt));
    assert.deepEqual(table.applied.map(([id, choice]) => [id, choice]), matchingSource ? [['start', 'cast'], ['mode-panel', 'fence']] : [['start', 'cast']]);
  });
}

test('[PM-LINE-SEM-2] a unique typed prepared-cast option can follow the exact exile object', async (t) => {
  const prepared = { id: 'prepared', cardId: 'print', name: 'Prepared side', types: ['SORCERY'] };
  const players = [{ id: 'me', yourSeat: true, exile: [prepared] }, { id: 'opponent' }];
  const current = { ...openingMain, ownHand: [], players, decision: priority('start', { id: 'from-exile', objectId: prepared.id, card: prepared }) };
  const table = game(t, {
    start: { decision: { id: 'options', kind: 'panel', sourceObjectId: prepared.id, choices: [
      { id: 'cast-prepared', abilityId: 'spell-id', abilityType: 'SPELL', spellName: prepared.name, type: 'option' },
      { id: 'other', abilityId: 'special-action-id', abilityType: 'SPECIAL_ACTION', type: 'option' },
    ] } },
    options: { decision: priority('next'), stack: [{ ...prepared, id: 'stack', controllerId: 'me' }] },
  }, current);
  const receipt = await table.submit([{ kind: 'play', select: { objectId: prepared.id, zone: 'exile' } }]);
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt));
  assert.deepEqual(table.applied.map(([id, choice]) => [id, choice]), [['start', 'from-exile'], ['options', 'cast-prepared']]);
});

for (const extraTarget of [false, true]) {
  test(`[PM-LINE-SEM-3] a same-role finish confirms precisely the declared targets: extraneous=${extraTarget}`, async (t) => {
    const spell = { id: 'sorcery-object', cardId: 'spell-card', name: 'Boost One or Two', types: ['SORCERY'] };
    const creature = { id: 'creature-object', cardId: 'creature-card', name: 'Creature', types: ['CREATURE'] };
    const current = { ...openingMain, ownHand: [spell], players: [{ id: 'me', yourSeat: true, battlefield: [creature] }, { id: 'opponent' }],
      decision: priority('start', { id: 'cast', card: spell, objectId: spell.id }) };
    const role = { kind: 'target', targetZone: 'BATTLEFIELD', targetSourceId: spell.id, targetRole: 0 };
    const table = game(t, {
      start: { decision: { id: 'target', ...role, choices: [{ id: 'creature', objectId: creature.id, card: creature }] } },
      target: { decision: { id: 'done', ...role, chosenTargetIds: extraTarget ? [creature.id, 'other'] : [creature.id],
        choices: [{ id: 'confirm', intent: 'confirm_targets' }] } },
      done: { decision: priority('next'), stack: [{ ...spell, id: 'stack', controllerId: 'me', targets: [creature.id] }] },
    }, current);
    const receipt = await table.submit([{ kind: 'play', select: { objectId: spell.id }, targets: [
      { select: { objectId: creature.id }, role: 0, targetZone: 'BATTLEFIELD' },
    ] }]);
    assert.equal(receipt.status, extraTarget ? 'interrupted' : 'completed', JSON.stringify(receipt));
    assert.deepEqual(table.applied.map(([id, choice]) => [id, choice]), [
      ['start', 'cast'], ['target', 'creature'], ...(extraTarget ? [] : [['done', 'confirm']]),
    ]);
  });
}

for (const { name, result, observed, duplicate } of [
  { name: 'Reckless Rage', result: 'completed' },
  { name: 'Pit Fight', result: 'completed' },
  { name: 'Reckless Rage', result: 'interrupted', observed: 'wrong-role-target' },
  { name: 'Pit Fight', result: 'interrupted', observed: 'wrong-role-target', duplicate: true },
]) test(`[PM-LINE-SEM-3] ${name} reconciles an automatic first target by exact cast and role (${observed ? duplicate ? 'older matching copy' : 'mismatch' : 'match'})`, async (t) => {
  const spell = { id: 'spell-object', cardId: 'spell-card', name, types: ['INSTANT'] };
  const friendly = { id: 'friendly', name: 'Friendly creature', types: ['CREATURE'] };
  const enemy = { id: 'enemy', name: 'Enemy creature', types: ['CREATURE'] };
  const other = { id: 'wrong-role-target', name: 'Other creature', types: ['CREATURE'] };
  const mana = { id: 'mana', name: 'Mana source', types: ['LAND'] };
  const [first, second] = name === 'Reckless Rage' ? [enemy, friendly] : [friendly, enemy];
  const announced = observed ?? first.id;
  const spellOnStack = { ...spell, id: 'fresh-cast', controllerId: 'me', unpaid: true,
    targets: [announced, first.id], spellTargetGroups: [[announced], []] };
  const matchingStack = { ...spellOnStack, id: 'older-cast', unpaid: false, targets: [first.id], spellTargetGroups: [[first.id], []] };
  const prior = duplicate ? [matchingStack] : [];
  const current = { ...openingMain, ownHand: [spell], stack: prior,
    players: [{ id: 'me', yourSeat: true, battlefield: [friendly, mana] }, { id: 'opponent', battlefield: [enemy, other] }],
    decision: priority('start', { id: 'cast', card: spell, objectId: spell.id }) };
  const table = game(t, {
    start: { stack: [spellOnStack, ...prior], decision: { id: 'second-role', kind: 'target', targetZone: 'BATTLEFIELD',
      targetSourceId: spell.id, targetRole: 1, choices: [{ id: 'second', card: second, objectId: second.id }] } },
    'second-role': { stack: [{ ...spellOnStack, targets: [announced, second.id], spellTargetGroups: [[announced], [second.id]] }, ...prior],
      decision: { id: 'pay', kind: 'payMana', choices: [{ id: 'tap', card: mana, objectId: mana.id }] } },
    pay: { decision: priority('paid') },
  }, current);
  const select = observed ? { cardId: spell.cardId } : { objectId: spell.id };
  const receipt = await table.submit([{ kind: 'play', when: 'priority', select,
    targets: [{ select: { objectId: first.id }, role: 0, targetZone: 'BATTLEFIELD' },
      { select: { objectId: second.id }, role: 1, targetZone: 'BATTLEFIELD' }],
    payWith: [mana.id] }]);
  assert.equal(receipt.status, result, JSON.stringify(receipt));
  assert.deepEqual(table.applied.map(([decisionId, choiceId]) => [decisionId, choiceId]),
    [['start', 'cast'], ...(result === 'completed' ? [['second-role', 'second'], ['pay', 'tap']] : [])]);
});

test('[PM-LINE-WINDOW] intermediate current-turn windows require own priority, a named phase or step and an immediate action', async (t) => {
  const table = game(t, {});
  const choose = { kind: 'choose', decisionId: 'known', choiceId: 'known' };
  for (const first of [
    { kind: 'pass_priority' },
    { kind: 'pass_until', destination: 'my_draw' },
    { kind: 'pass_until', destination: 'end_step' },
    { kind: 'pass_until', destination: 'current_turn', priority: 'self' },
    { kind: 'pass_until', destination: 'current_turn', step: 'POSTCOMBAT_MAIN' },
    { kind: 'pass_until', destination: 'current_turn', step: 'BEGIN_COMBAT', priority: 'opponent' },
    { kind: 'pass_until', destination: 'current_turn', step: 'NOT_AN_ENGINE_STEP', priority: 'self' },
  ])
    await assert.rejects(table.submit([first, choose]), { code: 'bad_sequence', actionIndex: 0 });
  await assert.rejects(
    table.submit([
      { kind: 'pass_until', destination: 'current_turn', step: 'BEGIN_COMBAT', priority: 'self' },
      { kind: 'pass_until', destination: 'my_draw' },
    ]),
    { code: 'bad_sequence', actionIndex: 0 },
  );
  assert.deepEqual(table.applied, []);
});

test('[PM-LINE-WINDOW] a useful option before the phase pauses an intermediate if_no_play without consuming priority', async (t) => {
  const choice = { id: 'free', kind: 'spell', type: 'object' };
  const table = game(
    t,
    {},
    { turn: 3, activePlayerId: 'me', phase: 'PRECOMBAT_MAIN', step: 'PRECOMBAT_MAIN', decision: priority('initial', choice) },
  );
  const receipt = await table.submit([
    { kind: 'pass_until', destination: 'current_turn', phase: 'POSTCOMBAT_MAIN', priority: 'self' },
    { kind: 'play', select: { cardId: 'future' } },
  ]);
  assert.equal(receipt.reason, 'response_available');
  assert.equal(receipt.actionIndex, 0);
  assert.deepEqual(table.applied, []);
});

test('[PM-LINE-WINDOW] omitted blocker declaration never uses the following priority to select a blocker', async (t) => {
  const table = game(
    t,
    { combat: { phase: 'POSTCOMBAT_MAIN', step: 'POSTCOMBAT_MAIN', decision: priority('after-skipped') } },
    { turn: 7, activePlayerId: 'opponent', phase: 'COMBAT', step: 'BEGIN_COMBAT', decision: priority('combat') },
  );
  const receipt = await table.submit([
    { kind: 'pass_until', destination: 'current_turn', step: 'DECLARE_BLOCKERS', priority: 'self' },
    { kind: 'block', assignments: [] },
    { kind: 'pass_until', destination: 'end_step' },
  ]);
  assert.equal(receipt.reason, 'destination_skipped');
  assert.equal(receipt.lastDestination.step, 'POSTCOMBAT_MAIN');
  assert.deepEqual(
    table.applied.map(([id, choice]) => [id, choice]),
    [['combat', 'pass']],
  );
});

for (const [step, activePlayerId, action] of [
  ['DECLARE_ATTACKERS', 'me', { kind: 'attack', attackers: [] }],
  ['DECLARE_BLOCKERS', 'opponent', { kind: 'block', assignments: [] }],
]) {
  test(`[PM-LINE-WINDOW] priority after ${step} cannot be passed to recover a missed declaration`, async (t) => {
    const table = game(
      t,
      { ordinary: { step: 'POSTCOMBAT_MAIN', decision: priority('too-late') } },
      { turn: 7, activePlayerId, phase: 'COMBAT', step, decision: priority('ordinary') },
    );
    const receipt = await table.submit([action, { kind: 'pass_until', destination: 'end_step' }]);
    assert.equal(receipt.reason, 'illegal_choice');
    assert.deepEqual(table.applied, []);
  });
}

for (const [kind, declaration, activePlayerId] of [
  ['attack', 'DECLARE_ATTACKERS', 'me'],
  ['block', 'DECLARE_BLOCKERS', 'opponent'],
]) {
  const action = kind === 'attack' ? { kind, attackers: [] } : { kind, assignments: [] };
  const phase = { kind: 'pass_until', destination: 'current_turn', step: 'BEGIN_COMBAT', priority: 'self' };
  const final = { kind: 'pass_until', destination: 'end_step' };
  const promptKind = kind === 'attack' ? 'declareAttackers' : 'declareBlockers';
  const intent = kind === 'attack' ? 'confirm_attack' : 'confirm_block';
  for (const skipped of [false, true])
    test(`[PM-LINE-WINDOW] beginning of combat reaches the next ${kind} declaration or reports its omission: ${skipped}`, async (t) => {
      const initial = { turn: 7, activePlayerId, phase: 'COMBAT', step: 'BEGIN_COMBAT', decision: priority('beginning') };
      const after = { phase: 'POSTCOMBAT_MAIN', step: 'POSTCOMBAT_MAIN', decision: priority('after') };
      const table = game(
        t,
        {
          beginning: skipped
            ? after
            : { step: declaration, decision: { id: 'declare', kind: promptKind, choices: [{ id: 'confirm', intent }] } },
          declare: { phase: 'END', step: 'END_TURN', decision: priority('at-end') },
          after: { phase: 'END', step: 'END_TURN', decision: priority('extra-pass') },
        },
        initial,
      );
      const result = await table.submit([phase, action, final]);
      if (skipped) {
        assert.equal(result.reason, 'destination_skipped');
        assert.equal(result.actionIndex, 1);
        assert.equal(table.seat.snapshot().decision.id, 'after');
        assert.deepEqual(
          table.applied.map(([, choice]) => choice),
          ['pass'],
        );
      } else {
        assert.equal(result.status, 'completed');
        assert.deepEqual(
          table.applied.map(([, choice]) => choice),
          ['pass', 'confirm'],
        );
      }
    });
  test(`[PM-LINE-WINDOW] ${kind} cannot follow an arbitrary phase or the other side's declaration step`, async (t) => {
    const table = game(t, {});
    for (const overrides of [
      { step: 'POSTCOMBAT_MAIN' },
      { step: kind === 'attack' ? 'DECLARE_BLOCKERS' : 'DECLARE_ATTACKERS' },
      { phase: 'COMBAT', step: undefined },
      { phase: 'END' },
    ]) {
      await assert.rejects(table.submit([{ ...phase, ...overrides }, action, final]), { code: 'bad_sequence', actionIndex: 0 });
    }
    assert.deepEqual(table.applied, []);
  });
}

for (const policy of ['if_no_play', 'decline_optional'])
  test(`[PM-LINE-WINDOW] ${policy} applies between beginning of combat and the declaration`, async (t) => {
    const table = game(
      t,
      {
        beginning: {
          step: 'DECLARE_ATTACKERS',
          decision: { id: 'attack', kind: 'declareAttackers', choices: [{ id: 'confirm', intent: 'confirm_attack' }] },
        },
        attack: { step: 'END_TURN', phase: 'END', decision: priority('end') },
      },
      {
        turn: 7,
        activePlayerId: 'me',
        phase: 'COMBAT',
        step: 'BEGIN_COMBAT',
        decision: priority('beginning', { id: 'optional', type: 'object' }),
      },
    );
    const receipt = await table.submit([
      { kind: 'pass_until', destination: 'current_turn', priority: 'self', step: 'BEGIN_COMBAT', policy },
      { kind: 'attack', attackers: [] },
      { kind: 'pass_until', destination: 'end_step' },
    ]);
    if (policy === 'if_no_play') {
      assert.equal(receipt.reason, 'response_available');
      assert.deepEqual(table.applied, []);
    } else {
      assert.equal(receipt.status, 'completed');
      assert.deepEqual(
        table.applied.map(([, choice]) => choice),
        ['pass', 'confirm'],
      );
    }
  });

for (const [step, kind, actor, intent] of [
  ['DECLARE_ATTACKERS', 'declareAttackers', 'me', 'confirm_attack'],
  ['DECLARE_BLOCKERS', 'declareBlockers', 'opponent', 'confirm_block'],
])
  test(`[PM-LINE-WINDOW] an observed ${step} declaration executes directly inside its named window`, async (t) => {
    const table = game(
      t,
      { declare: { phase: 'END', step: 'END_TURN', decision: priority('end') } },
      { turn: 7, activePlayerId: actor, phase: 'COMBAT', step, decision: { id: 'declare', kind, choices: [{ id: 'confirm', intent }] } },
    );
    const action = kind === 'declareAttackers' ? { kind: 'attack', attackers: [] } : { kind: 'block', assignments: [] };
    const receipt = await table.submit([
      { kind: 'pass_until', destination: 'current_turn', step, priority: 'self' },
      action,
      { kind: 'pass_until', destination: 'end_step' },
    ]);
    assert.equal(receipt.status, 'completed');
    assert.deepEqual(
      table.applied.map(([, choice]) => choice),
      ['confirm'],
    );
  });

// Sheoldred's lifegain and an emblem's drain trigger on the rival's own draw (judge review, 24 Nov 2026).
function rivalDrawTriggers(t, { gain = {}, drain = {}, initialPlayers, drawChoices = [] } = {}) {
  const sheoldred = { id: 'sheoldred', cardId: 'sheoldred', controllerId: 'opponent', name: 'Sheoldred, the Apocalypse',
    types: ['CREATURE'], rules: ['Whenever you draw a card, you gain 2 life.'] };
  const emblem = { id: 'emblem', name: 'Emblem Fel', rules: ['Whenever you gain life, target opponent loses that much life.'] };
  const gainTrigger = { id: 'gain-trigger', name: 'Ability', controllerId: 'opponent', abilityType: 'TRIGGERED_NONMANA',
    sourceId: sheoldred.id, abilityText: 'Whenever you draw a card, you gain 2 life.', rules: ['Whenever you draw a card, you gain 2 life.'], ...gain };
  const drainTrigger = { id: 'drain-trigger', name: 'Ability', controllerId: 'opponent', abilityType: 'TRIGGERED_NONMANA',
    sourceId: emblem.id, abilityText: emblem.rules[0], rules: emblem.rules, targets: ['me'], ...drain };
  const players = (life, opponentLife) => [{ id: 'me', yourSeat: true, life, battlefield: [] },
    { id: 'opponent', life: opponentLife, battlefield: [sheoldred], command: [emblem] }];
  const theirDraw = { turn: 8, activePlayer: 'Opponent', activePlayerId: 'opponent', step: 'DRAW' };
  const table = game(t, {
    draw: { stack: [gainTrigger], decision: priority('gain', ...drawChoices) },
    gain: { stack: [drainTrigger], players: players(20, 22), decision: priority('drain', ...drawChoices),
      sequenceEvidence: { ...evidence, resolutions: { [gainTrigger.id]: 1 }, resolutionRevision: 1 } },
    drain: { stack: [], players: players(18, 22), step: 'END_TURN', decision: priority('their-end'),
      sequenceEvidence: { ...evidence, resolutions: { [gainTrigger.id]: 1, [drainTrigger.id]: 2 }, resolutionRevision: 2 } },
  }, { ...theirDraw, decision: priority('draw', ...drawChoices), players: initialPlayers ?? players(20, 20) });
  return { table, players };
}

for (const policy of ['decline_optional', 'if_no_play']) {
  test(`[PM-LINE-FLOW-4] a ${policy} pass resolves rival triggers from public battlefield and emblem sources`, async (t) => {
    const { table } = rivalDrawTriggers(t);
    const receipt = await table.submit([{ kind: 'pass_until', destination: 'end_step', policy }]);
    assert.equal(receipt.status, 'completed', receipt.error?.message);
    assert.equal(receipt.lastDestination.step, 'END_TURN');
    assert.deepEqual(table.applied.map(([id]) => id), ['draw', 'gain', 'drain']);
  });
}

for (const [name, options, reason] of [
  ['targets a permanent', { drain: { targets: ['my-creature'] } }, 'state_changed'],
  ['reveals information', { gain: { abilityText: 'Whenever you draw a card, reveal it.', rules: ['Whenever you draw a card, reveal it.'] } }, 'state_changed'],
  ['comes from a source that was not public when the line began', {
    initialPlayers: [{ id: 'me', yourSeat: true, life: 20, battlefield: [] }, { id: 'opponent', life: 20, battlefield: [] }] }, 'state_changed'],
  ['meets a legal response under if_no_play', { drawChoices: [freePlay] }, 'response_available'],
]) test(`[PM-LINE-FLOW-4] a pass still stops when a rival trigger ${name}`, async (t) => {
  const { table } = rivalDrawTriggers(t, options);
  const receipt = await table.submit([{ kind: 'pass_until', destination: 'end_step' }]);
  assert.equal(receipt.reason, reason);
});

test('[PM-LINE-FLOW-4] a rival trigger during a planned cast still interrupts the cast', async (t) => {
  const bolt = { id: 'bolt', cardId: 'bolt', name: 'Lightning Bolt', types: ['INSTANT'], rules: ['Lightning Bolt deals 3 damage to any target.'] };
  const sheoldredTrigger = { id: 'cast-trigger', name: 'Ability', controllerId: 'opponent', abilityType: 'TRIGGERED_NONMANA',
    sourceId: 'sheoldred', abilityText: 'Whenever you draw a card, you gain 2 life.', rules: ['Whenever you draw a card, you gain 2 life.'] };
  const cast = game(t, { main: { stack: [sheoldredTrigger, { ...bolt, id: 'bolt-stack', controllerId: 'me' }], ownHand: [], decision: priority('after-cast') } }, {
    activePlayerId: 'me', activePlayer: 'Pilot', step: 'PRECOMBAT_MAIN', ownHand: [bolt],
    players: [{ id: 'me', yourSeat: true, battlefield: [] }, { id: 'opponent', battlefield: [{ id: 'sheoldred', controllerId: 'opponent', rules: [] }] }],
    decision: priority('main', { id: 'cast-bolt', type: 'object', objectId: bolt.id, card: bolt }),
  });
  const receipt = await cast.submit([{ kind: 'play', select: { objectId: bolt.id, zone: 'hand' }, when: 'priority' },
    { kind: 'pass_until', destination: 'end_step' }]);
  assert.equal(receipt.reason, 'state_changed');
});
