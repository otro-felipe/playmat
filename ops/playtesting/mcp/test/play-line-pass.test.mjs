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
