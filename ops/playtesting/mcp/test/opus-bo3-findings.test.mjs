import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { GameSeat } from '../src/game-seat.mjs';

// Reproductions from the Opus Bo3 (Golgari vs Greasefang, 26 November 2026):
// renewed Urborg mana IDs, Evoke and Cycling with payWith, and a scoped decline
// followed by the rest of the turn.

const pass = { id: 'pass', type: 'pass' };
const priority = (id, ...choices) => ({ id, kind: 'priority', choices: [pass, ...choices] });
const evidence = (resolutions = {}, revision = 0) => ({ epoch: 'opus-bo3', publicActions: { me: 0, rival: 0 }, resolutions,
  resolutionRevision: revision, informationRevision: 0, combatRevision: 0, combatDamage: [] });

async function run(t, { initial, actions, respond, observe = [] }) {
  let state = { gameId: 'opus', cursor: 1, epoch: 1, status: 'active', turn: 6, activePlayer: 'Pilot', activePlayerId: 'me',
    step: 'PRECOMBAT_MAIN', priority: 'self', stack: [], ownHand: [], sequenceEvidence: evidence(), ...initial };
  const listeners = new Set(), applied = [];
  const update = (change) => { state = { ...state, ...change, cursor: state.cursor + 1 }; for (const fn of [...listeners]) fn(); };
  const seat = new GameSeat({ snapshot: () => state, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    respond: async (id, choice, value) => { applied.push([id, choice]); await respond({ id, choice, value, state, update }); return { submitted: true }; } });
  t.after(() => seat.invalidate());
  // What the pilot saw in earlier tool replies.
  for (const seen of observe) seat.withChoiceActions({ ...state, ...seen });
  let start;
  try {
    start = seat.startTurn({ gameId: 'opus', cursor: state.cursor, actions, finish: 'none' }, async () => true);
  } catch (error) {
    return { rejected: error, applied, state };
  }
  for (let n = 0; n < 200; n++) {
    const result = seat.sequenceStatus({ gameId: 'opus', sequenceId: start.sequenceId });
    if (result.status !== 'running') return { result, applied, state };
    await sleep(2);
  }
  assert.fail('The line must terminate');
}

const land = (id, name) => ({ id, cardId: id, name, types: ['LAND'], controllerId: 'me' });
const manaObject = (card, abilities) => ({ id: `object-${card.id}`, type: 'object', objectId: card.id, card,
  manaAbilities: abilities.map(([abilityId, color]) => ({ abilityId, manaColors: [color] })) });
const manaPanel = (id, card, abilities) => ({ id, kind: 'panel', sourceObjectId: card.id, choices: abilities.map(([abilityId, color], index) =>
  ({ id: `ability-${index}`, type: 'option', label: `{T}: Add {${color}}.`, abilityType: 'ACTIVATED_MANA', abilityId, manaColors: [color] })) });

// Mutavault and Llanowar Wastes under Urborg. XMage renews each granted {B} ID whenever effects apply.
const mutavault = land('mutavault', 'Mutavault');
const wastes = land('wastes', 'Llanowar Wastes');
const urborg = land('urborg', 'Urborg, Tomb of Yawgmoth');
const mutavaultAbilities = (round) => [['mutavault-c', 'C'], [`mutavault-urborg-${round}`, 'B']];
const wastesAbilities = (round) => [['wastes-c', 'C'], ['wastes-b', 'B'], ['wastes-g', 'G'], [`wastes-urborg-${round}`, 'B']];
const decay = { id: 'decay', cardId: 'decay', name: 'Abrupt Decay', types: ['INSTANT'], controllerId: 'me' };
const lands = [mutavault, wastes, urborg];

for (const variant of ['renewed Mutavault black', 'renewed granted black, not the painful one', 'never observed ID']) {
  test(`[OPUS-BO3-1] payWith resolves a renewed granted mana ability by source and color: ${variant}`, async (t) => {
    const observed = priority('seen', { id: 'cast-decay', type: 'object', objectId: decay.id, card: decay },
      manaObject(mutavault, mutavaultAbilities(1)), manaObject(wastes, wastesAbilities(1)));
    const payWith = {
      'renewed Mutavault black': [{ sourceId: mutavault.id, abilityId: 'mutavault-urborg-1', color: 'B' }, { sourceId: wastes.id, abilityId: 'wastes-g', color: 'G' }],
      'renewed granted black, not the painful one': [{ sourceId: wastes.id, abilityId: 'wastes-urborg-1', color: 'B' }, { sourceId: mutavault.id, abilityId: 'mutavault-c', color: 'C' }],
      'never observed ID': [{ sourceId: mutavault.id, abilityId: 'mutavault-never-seen', color: 'B' }, { sourceId: wastes.id, abilityId: 'wastes-g', color: 'G' }],
    }[variant];
    const pay = (id, sources, round) => ({ id, kind: 'payMana', paymentSourceId: decay.id, choices: sources.map((card) =>
      manaObject(card, card === mutavault ? mutavaultAbilities(round) : wastesAbilities(round))) });
    const spell = { ...decay, id: 'decay-spell' };
    const { result, applied } = await run(t, {
      observe: [{ decision: observed }],
      initial: { ownHand: [decay], players: [{ id: 'me', yourSeat: true, battlefield: lands }, { id: 'rival', battlefield: [] }],
        decision: priority('cast', { id: 'cast-decay', type: 'object', objectId: decay.id, card: decay },
          manaObject(mutavault, mutavaultAbilities(2)), manaObject(wastes, wastesAbilities(2))) },
      actions: [{ kind: 'play', select: { objectId: decay.id, zone: 'hand' }, payWith }],
      respond: ({ id, choice, update }) => {
        if (id === 'cast') return update({ ownHand: [], stack: [spell], decision: pay('pay-0', [mutavault, wastes], 3) });
        const [first, second] = payWith.map(({ sourceId }) => lands.find((card) => card.id === sourceId));
        if (id === 'pay-0') return update({ decision: manaPanel('panel-0', first, first === mutavault ? mutavaultAbilities(4) : wastesAbilities(4)) });
        if (id === 'panel-0') return update({ decision: pay('pay-1', [second], 5) });
        if (id === 'pay-1') return update({ decision: manaPanel('panel-1', second, second === mutavault ? mutavaultAbilities(6) : wastesAbilities(6)) });
        if (id === 'panel-1') return update({ decision: priority('resolve') });
        if (id === 'resolve') return update({ stack: [], decision: priority('done'), sequenceEvidence: evidence({ [spell.id]: 1 }, 1) });
        assert.fail(`Unexpected decision ${id} ${choice}`);
      },
    });
    if (variant === 'never observed ID') {
      assert.equal(result.reason, 'illegal_choice');
      assert.deepEqual(applied.map(([id]) => id), ['cast']);
      return;
    }
    assert.equal(result.status, 'completed', JSON.stringify(result.error));
    const panels = Object.fromEntries(applied.filter(([id]) => id.startsWith('panel')));
    if (variant === 'renewed Mutavault black') assert.deepEqual(panels, { 'panel-0': 'ability-1', 'panel-1': 'ability-2' });
    else assert.deepEqual(panels, { 'panel-0': 'ability-3', 'panel-1': 'ability-0' });
  });
}

for (const variant of ['renewed IDs only', 'new option']) {
  test(`[OPUS-BO3-1] a scoped decline ignores renewed mana IDs but stops for a new option: ${variant}`, async (t) => {
    const open = (id, round, ...extra) => priority(id, manaObject(mutavault, mutavaultAbilities(round)), ...extra);
    const { result, applied } = await run(t, {
      initial: { players: [{ id: 'me', yourSeat: true, battlefield: lands }, { id: 'rival', battlefield: [] }], decision: open('main', 1) },
      actions: [{ kind: 'pass_until', destination: 'current_turn', step: 'END_TURN', priority: 'self', policy: 'decline_optional', declineFromDecisionId: 'main' }],
      respond: ({ id, update }) => {
        if (id === 'main') return update({ step: 'BEGIN_COMBAT', decision: variant === 'new option'
          ? priority('combat', { ...manaObject(mutavault, mutavaultAbilities(2)), nonManaAbilities: [{ abilityId: 'animate' }] }) : open('combat', 2) });
        if (id === 'combat') return update({ step: 'END_TURN', decision: open('end', 3) });
        assert.fail(`Unexpected decision ${id}`);
      },
    });
    if (variant === 'new option') {
      assert.equal(result.reason, 'response_available');
      assert.deepEqual(applied.map(([id]) => id), ['main']);
    } else {
      assert.equal(result.status, 'completed', JSON.stringify(result.error));
      assert.deepEqual(applied.map(([id]) => id), ['main', 'combat']);
    }
  });
}

for (const variant of ['decline then land', 'decline not first']) {
  test(`[OPUS-BO3-3] declineFromDecisionId opens a compound line: ${variant}`, async (t) => {
    const plains = { id: 'plains', cardId: 'plains', name: 'Plains', types: ['LAND'] };
    const landChoice = { id: 'object-plains', type: 'object', objectId: plains.id, card: plains, canPlayLand: true };
    const decline = { kind: 'pass_until', destination: 'current_turn', step: 'PRECOMBAT_MAIN', priority: 'self', policy: 'decline_optional', declineFromDecisionId: 'upkeep' };
    const playLand = { kind: 'play', playAs: 'land', select: { objectId: plains.id, zone: 'hand' } };
    const { result, rejected, applied } = await run(t, {
      initial: { step: 'UPKEEP', ownHand: [plains], players: [{ id: 'me', yourSeat: true, battlefield: [] }, { id: 'rival', battlefield: [] }],
        decision: priority('upkeep', manaObject(mutavault, mutavaultAbilities(1))) },
      actions: variant === 'decline then land' ? [decline, playLand] : [playLand, decline],
      respond: ({ id, update }) => {
        if (id === 'upkeep') return update({ step: 'PRECOMBAT_MAIN', decision: priority('main', landChoice) });
        if (id === 'main') return update({ ownHand: [], players: [{ id: 'me', yourSeat: true, battlefield: [plains] }, { id: 'rival', battlefield: [] }], decision: priority('after-land') });
        assert.fail(`Unexpected decision ${id}`);
      },
    });
    if (variant === 'decline not first') {
      assert.equal(rejected?.code, 'bad_sequence');
      assert.match(rejected.message, /first action/);
      assert.deepEqual(applied, []);
    } else {
      assert.equal(result.status, 'completed', JSON.stringify(result.error));
      assert.deepEqual(applied, [['upkeep', 'pass'], ['main', 'object-plains']]);
    }
  });
}

// Emptiness: XMage asks the alternative cost with a plain choice list after the spell moves to the stack.
const marsh = land('marsh', 'Blooming Marsh');
const courtyard = land('courtyard', 'Concealed Courtyard');
const twoLands = [marsh, courtyard];
const paymentFor = (sourceId) => (index) => ({ id: `pay-${index}`, kind: 'payMana', paymentSourceId: sourceId,
  choices: [manaObject(twoLands[index], [[`${twoLands[index].id}-w`, 'W'], [`${twoLands[index].id}-b`, 'B']])] });

for (const variant of ['Evoke', 'label', 'normal cast', 'required alternative without mode', 'Dash on another card']) {
  test(`[OPUS-BO3-2] the alternative cost and payWith stay in one play: ${variant}`, async (t) => {
    const dash = variant === 'Dash on another card';
    const card = dash ? { id: 'raider', cardId: 'raider', name: 'Kolaghan Raider', types: ['CREATURE'], rules: ['Dash {1}{B}'] }
      : { id: 'emptiness', cardId: 'emptiness', name: 'Emptiness', types: ['CREATURE'], rules: ['Evoke {W/B}{W/B}'] };
    const keyword = dash ? 'Dash' : 'Evoke';
    const spell = { ...card, id: `${card.id}-spell`, controllerId: 'me' };
    const options = [
      { id: 'option-0', type: 'option', label: `Cast with ${keyword} alternative cost: {W/B}{W/B} (source: ${card.name} [${card.id.slice(0, 3)}])`, castCost: keyword },
      ...(variant === 'required alternative without mode' ? [] : [{ id: 'option-1', type: 'option', label: 'Cast with no alternative cost: {4}{W/B}{W/B}', castCost: 'none' }]),
    ];
    const mode = { Evoke: { mode: 'Evoke' }, label: { mode: 'Cast with Evoke alternative cost' }, 'Dash on another card': { mode: 'Dash' } }[variant] ?? {};
    const pay = paymentFor(card.id);
    const { result, applied } = await run(t, {
      initial: { ownHand: [card], players: [{ id: 'me', yourSeat: true, battlefield: twoLands }, { id: 'rival', battlefield: [] }],
        decision: priority('cast', { id: 'cast-card', type: 'object', objectId: card.id, card }) },
      actions: [{ kind: 'play', select: { objectId: card.id, zone: 'hand' }, ...mode,
        payWith: [{ sourceId: marsh.id, color: 'B' }, { sourceId: courtyard.id, color: 'B' }] }],
      respond: ({ id, update }) => {
        if (id === 'cast') return update({ ownHand: [], stack: [spell], decision: { id: 'cost', kind: 'panel', instruction: 'Make a choice',
          castCostPicker: true, sourceObjectId: card.id, choices: [...options, { id: 'skip', type: 'button', label: 'Skip' }] } });
        if (id === 'cost') return update({ decision: pay(0) });
        if (id.startsWith('pay-')) {
          const index = Number(id.slice(4));
          return update({ decision: manaPanel(`panel-${index}`, twoLands[index], [[`${twoLands[index].id}-w`, 'W'], [`${twoLands[index].id}-b`, 'B']]) });
        }
        if (id === 'panel-0') return update({ decision: pay(1) });
        if (id === 'panel-1') return update({ decision: priority('resolve') });
        if (id === 'resolve') return update({ stack: [], decision: priority('done'), sequenceEvidence: evidence({ [spell.id]: 1 }, 1) });
        assert.fail(`Unexpected decision ${id}`);
      },
    });
    if (variant === 'required alternative without mode') {
      assert.equal(result.reason, 'response_available');
      assert.deepEqual(applied.map(([id]) => id), ['cast']);
      return;
    }
    assert.equal(result.status, 'completed', JSON.stringify(result.error));
    assert.deepEqual(applied, [['cast', 'cast-card'], ['cost', variant === 'normal cast' ? 'option-1' : 'option-0'],
      ['pay-0', 'object-marsh'], ['panel-0', 'ability-1'], ['pay-1', 'object-courtyard'], ['panel-1', 'ability-1'], ['resolve', 'pass']]);
  });
}

// Thundering Broodwagon: Cycling from hand is an activated ability, not a cast.
for (const variant of ['activated without picker', 'picked over a castable spell', 'Channel on another card']) {
  test(`[OPUS-BO3-2] a hand ability named by mode activates and uses payWith: ${variant}`, async (t) => {
    const channel = variant === 'Channel on another card';
    const keyword = channel ? 'Channel' : 'Cycling';
    const rule = channel ? 'Channel — {1}{G}, Discard this card: Draw a card.' : 'Cycling {2} ({2}, Discard this card: Draw a card.)';
    const card = { id: 'wagon', cardId: 'wagon', name: channel ? 'Channel Land' : 'Thundering Broodwagon', types: ['ARTIFACT'], rules: [rule] };
    const ability = { id: 'hand-ability', sourceId: card.id, controllerId: 'me', abilityType: 'ACTIVATED_NONMANA', abilityText: '{2}, Discard this card: Draw a card.' };
    const pay = paymentFor(card.id);
    const { result, applied } = await run(t, {
      initial: { ownHand: [card], players: [{ id: 'me', yourSeat: true, battlefield: twoLands }, { id: 'rival', battlefield: [] }],
        decision: priority('click', { id: 'click-card', type: 'object', objectId: card.id, card }) },
      actions: [{ kind: 'play', select: { objectId: card.id, zone: 'hand' }, mode: keyword,
        payWith: [{ sourceId: marsh.id, color: 'B' }, { sourceId: courtyard.id, color: 'W' }] }],
      respond: ({ id, choice, update }) => {
        if (id === 'click' && variant === 'picked over a castable spell') return update({ decision: { id: 'picker', kind: 'panel', sourceObjectId: card.id,
          instruction: `Choose spell or ability to play ${card.name}`, choices: [
            { id: 'ability-0', type: 'option', label: `Cast ${card.name}`, abilityType: 'SPELL', spellName: card.name, abilityId: 'cast' },
            { id: 'ability-1', type: 'option', label: rule, abilityType: 'ACTIVATED_NONMANA', abilityId: 'cycle' },
            { id: 'cancel', type: 'button', label: 'Cancel' }] } });
        if (id === 'click' || id === 'picker') {
          if (id === 'picker') assert.equal(choice, 'ability-1', 'The declared hand ability, never the spell');
          return update({ stack: [ability], decision: pay(0) });
        }
        if (id.startsWith('pay-')) {
          const index = Number(id.slice(4));
          return update({ decision: manaPanel(`panel-${index}`, twoLands[index], [[`${twoLands[index].id}-w`, 'W'], [`${twoLands[index].id}-b`, 'B']]) });
        }
        if (id === 'panel-0') return update({ decision: pay(1) });
        if (id === 'panel-1') return update({ decision: priority('resolve') });
        if (id === 'resolve') return update({ stack: [], decision: priority('done'), sequenceEvidence: evidence({ [ability.id]: 1 }, 1) });
        assert.fail(`Unexpected decision ${id}`);
      },
    });
    assert.equal(result.status, 'completed', JSON.stringify(result.error));
    assert.deepEqual(applied.filter(([id]) => id.startsWith('panel')), [['panel-0', 'ability-1'], ['panel-1', 'ability-0']]);
    assert.equal(applied.at(-1)[0], 'resolve');
  });
}
