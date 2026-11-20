import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GameSeat } from '../src/game-seat.mjs';
import { playLine } from '../src/line-runtime.mjs';
import { describeAgentDecision, projectedChoices, visibleAgentGame } from '../dist/engine-core.mjs';

const pilot = { id: 'pilot', yourSeat: true, battlefield: [], life: 20 };
const opponent = { id: 'opponent', battlefield: [], life: 20 };
const pass = { id: 'pass', type: 'pass' };
const priority = (id, ...choices) => ({ id, kind: 'priority', choices: [pass, ...choices] });
const object = (id, card) => ({ id, objectId: card.id, card, label: card.name, type: 'object' });
const evidence = { epoch: 'pioneer-fixture', publicActions: {}, resolutions: {}, resolutionRevision: 0,
  informationRevision: 0, combatRevision: 0, combatDamage: [] };

function fixture(t, initial, respond) {
  let state = { gameId: 'pioneer-fixture', cursor: 1, epoch: 1, status: 'active', turn: 3,
    activePlayer: 'Pilot', activePlayerId: pilot.id, step: 'PRECOMBAT_MAIN', priority: 'self',
    ownHand: [], stack: [], players: [pilot, opponent], sequenceEvidence: evidence, ...initial };
  let command = 0;
  const applied = [];
  const listeners = new Set();
  const update = (change) => {
    state = { ...state, ...change, cursor: state.cursor + 1 };
    for (const listener of [...listeners]) listener();
  };
  const seat = new GameSeat({
    snapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    respond: async (decisionId, choiceId) => {
      applied.push([decisionId, choiceId]);
      respond(decisionId, choiceId, update);
      return { submitted: true };
    },
  });
  t.after(() => seat.invalidate());
  const run = async (actions) => playLine(seat, { gameId: state.gameId, cursor: state.cursor,
    commandId: `line-${++command}`, actions, waitMs: 500 }, async () => true);
  return { run, applied };
}

const swamp = { id: 'swamp', cardId: 'swamp', name: 'Swamp', types: ['LAND'] };
const discardSpells = [
  { id: 'thoughtseize', cardId: 'thoughtseize', name: 'Thoughtseize', types: ['SORCERY'],
    rules: ['Target player reveals their hand. You choose a nonland card from it. That player discards that card. You lose 2 life.'],
    targetInstruction: 'Select a player', canTargetSelf: true },
  { id: 'duress', cardId: 'duress', name: 'Duress', types: ['SORCERY'],
    rules: ['Target opponent reveals their hand. You choose a noncreature, nonland card from it. That player discards that card.'],
    targetInstruction: 'Select an opponent' },
];

test('[PM-AC-09-RESPONSES] only a public unpaid instant or sorcery on the stack exposes casting state', () => {
  const thoughtseize = { name: 'Thoughtseize', cardTypes: ['SORCERY'], paid: false };
  const state = visibleAgentGame({ view: {
    myHand: { inHand: thoughtseize },
    stack: {
      casting: thoughtseize,
      cast: { ...thoughtseize, paid: true },
      hidden: { ...thoughtseize, faceDown: true },
      other: { ...thoughtseize, cardTypes: ['CREATURE'] },
    },
  } });
  assert.deepEqual(state.stack.map(({ id, unpaid }) => [id, unpaid]), [
    ['casting', true], ['cast', undefined], ['hidden', undefined], ['other', undefined],
  ]);
  assert.equal(state.ownHand[0].unpaid, undefined);
});

function discardFixture(t, spell, { unpaid = true, castingEvidence = evidence, chooseManaColor = false } = {}) {
  const stack = [{ ...spell, id: 'discard-stack', controllerId: pilot.id, unpaid }];
  const target = { id: 'select-player', kind: 'target', instruction: spell.targetInstruction,
    choices: [{ id: 'target-opponent', objectId: opponent.id, type: 'object' },
      ...(spell.canTargetSelf ? [{ id: 'target-self', objectId: pilot.id, type: 'object' }] : [])] };
  const revealedCard = { id: 'fixture-revealed-card', name: 'Negate' };
  const manaSource = chooseManaColor ? { ...swamp, id: 'marsh', name: 'Blooming Marsh' } : swamp;
  return fixture(t, { ownHand: [spell], players: [{ ...pilot, battlefield: [manaSource] }, opponent],
    decision: priority('cast', object('cast-discard', spell)) }, (decisionId, _choiceId, update) => {
    switch (decisionId) {
      case 'cast':
        update({ stack, ownHand: [], decision: target, sequenceEvidence: castingEvidence });
        break;
      case 'select-player':
        update({ stack: [{ ...stack[0], targets: [opponent.id] }],
          decision: { id: 'pay', kind: 'payMana', choices: [object(`tap-${manaSource.id}`, manaSource)] } });
        break;
      case 'pay':
        if (chooseManaColor) {
          update({ decision: { id: 'mana-picker', kind: 'panel', sourceObjectId: manaSource.id,
            choices: ['B', 'G'].map((color) => ({ id: `make-${color}`, abilityType: 'ACTIVATED_MANA', manaColors: [color] })) } });
          break;
        }
        update({ stack: [{ ...stack[0], unpaid: false, targets: [opponent.id] }], decision: priority('resolve') });
        break;
      case 'mana-picker':
        assert.equal(_choiceId, 'make-B');
        update({ stack: [{ ...stack[0], unpaid: false, targets: [opponent.id] }], decision: priority('resolve') });
        break;
      case 'resolve':
        update({ sequenceEvidence: { ...evidence, resolutions: { 'discard-stack': 1 }, resolutionRevision: 1,
          informationRevision: 1 }, revealed: [{ cards: [revealedCard] }],
          decision: { id: 'pick-revealed', kind: 'pickCards', instruction: 'Select a card to discard',
            choices: [object('discard-negate', revealedCard)] } });
        break;
      default:
        assert.fail('The line must stop before selecting a revealed card');
    }
  });
}

for (const spell of discardSpells) {
  test(`[PM-AC-09-RESPONSES] ${spell.name} groups its exact player target and mana, then stops at reveal`, async (t) => {
    const { run, applied } = discardFixture(t, spell);
    const result = await run([{ kind: 'play', select: { cardId: spell.id },
      targets: [{ select: { objectId: opponent.id }, instruction: spell.targetInstruction }], payWith: [swamp.id] }]);
    assert.equal(result.reason, 'new_information');
    assert.equal(result.state.decision.id, 'pick-revealed');
    assert.deepEqual(applied, [['cast', 'cast-discard'], ['select-player', 'target-opponent'],
      ['pay', 'tap-swamp'], ['resolve', 'pass']]);
  });
}

test('[PM-LINE-SEM-2] Thoughtseize with its declared black mana crosses a dual-land picker before reveal', async (t) => {
  const [spell] = discardSpells;
  const { run, applied } = discardFixture(t, spell, { chooseManaColor: true });
  const result = await run([{ kind: 'play', select: { cardId: spell.id },
    targets: [{ select: { objectId: opponent.id }, instruction: spell.targetInstruction }],
    payWith: [{ sourceId: 'marsh', color: 'B' }] }]);
  assert.equal(result.reason, 'new_information');
  assert.equal(result.state.decision.id, 'pick-revealed');
  assert.deepEqual(applied, [['cast', 'cast-discard'], ['select-player', 'target-opponent'],
    ['pay', 'tap-marsh'], ['mana-picker', 'make-B'], ['resolve', 'pass']]);
});

test('[PM-AC-09-RESPONSES] Thoughtseize recovery groups the observed cast target and payment before reveal', async (t) => {
  const [thoughtseize] = discardSpells;
  const { run, applied } = discardFixture(t, thoughtseize);
  const cast = await run([{ kind: 'play', select: { cardId: thoughtseize.id },
    targets: [{ select: { objectId: opponent.id } }], payWith: [swamp.id] }]);
  assert.equal(cast.reason, 'response_available');
  assert.equal(cast.state.decision.instruction, 'Select a player');
  const target = { kind: 'choose', guard: { kind: 'target', instruction: 'Select a player' },
    select: { objectId: opponent.id } };
  const pay = { kind: 'choose', guard: { kind: 'payMana' }, select: { objectId: swamp.id, zone: 'battlefield' } };
  await assert.rejects(run([{ ...target, guard: { ...target.guard, instruction: 'Select an opponent' } }, pay]), { code: 'reevaluation_required' });
  await assert.rejects(run([target, pay, { kind: 'pass_priority' }]), { code: 'reevaluation_required' });
  assert.deepEqual(applied, [['cast', 'cast-discard']]);
  const result = await run([target, pay]);
  assert.equal(result.reason, 'new_information');
  assert.equal(result.state.decision.id, 'pick-revealed');
  assert.deepEqual(applied, [['cast', 'cast-discard'], ['select-player', 'target-opponent'],
    ['pay', 'tap-swamp'], ['resolve', 'pass']]);
});

for (const [stateName, unpaid, beganResolution] of [
  ['a paid spell', false, false], ['a resolving spell', true, true],
]) test(`[PM-AC-09-RESPONSES] ${stateName} cannot run bundled recovery choices`, async (t) => {
  const [spell] = discardSpells;
  const { run, applied } = fixture(t, {
    stack: [{ ...spell, id: 'discard-stack', controllerId: pilot.id, unpaid }],
    sequenceEvidence: beganResolution ? { ...evidence, resolutions: { 'discard-stack': 1 }, resolutionRevision: 1 } : evidence,
    decision: { id: 'wrong-stage', kind: 'target', instruction: spell.targetInstruction,
      choices: [{ id: 'target-opponent', objectId: opponent.id, type: 'object' }] },
  }, () => assert.fail('The line must not execute a cost tail after resolution starts'));
  await assert.rejects(run([
    { kind: 'choose', guard: { kind: 'target', instruction: spell.targetInstruction }, select: { objectId: opponent.id } },
    { kind: 'choose', guard: { kind: 'payMana' }, select: { objectId: swamp.id } },
  ]), { code: 'reevaluation_required' });
  assert.deepEqual(applied, []);
});

test('[PM-AC-09-RESPONSES] a resumed cast stops if its next exact cost prompt is skipped', async (t) => {
  const [spell] = discardSpells;
  const pending = { ...spell, id: 'discard-stack', controllerId: pilot.id, unpaid: true };
  const { run, applied } = fixture(t, {
    stack: [pending], decision: { id: 'target', kind: 'target', instruction: spell.targetInstruction,
      choices: [{ id: 'target-opponent', objectId: opponent.id, type: 'object' }] },
  }, (_id, _choice, update) => update({ stack: [{ ...pending, unpaid: false }], decision: priority('after-target') }));
  const result = await run([
    { kind: 'choose', guard: { kind: 'target', instruction: spell.targetInstruction }, select: { objectId: opponent.id } },
    { kind: 'choose', guard: { kind: 'payMana' }, select: { objectId: swamp.id } },
  ]);
  assert.equal(result.reason, 'response_available');
  assert.equal(result.state.decision.id, 'after-target');
  assert.deepEqual(applied, [['target', 'target-opponent']]);
});

for (const [effect, expectDraw] of [
  ['Whenever an opponent draws a card, they lose 2 life.', false],
  ['Whenever you draw a card, you gain 2 life.', false],
  ['Whenever an opponent draws a card, draw a card.', true],
]) test(`[PM-AC-09-RESPONSES] a draw condition classifies only the triggered effect: ${effect}`, async (t) => {
  const trigger = { id: 'sheoldred-trigger', sourceId: 'sheoldred', controllerId: pilot.id,
    abilityType: 'TRIGGERED_NONMANA', abilityText: effect };
  const refreshed = { id: 'fixture-draw', cardId: 'fixture-draw', name: 'Island', types: ['LAND'] };
  const resolutions = { 'sheoldred-trigger': 1 };
  const { run, applied } = fixture(t, { stack: [trigger], ownHand: [swamp], decision: priority('resolve-trigger') },
    (id, _choice, update) => {
      if (id === 'resolve-trigger') {
        update({ stack: [], sequenceEvidence: { ...evidence, resolutions, resolutionRevision: 1,
          informationRevision: expectDraw ? 1 : 0 },
        ownHand: expectDraw ? [swamp, refreshed] : [swamp],
        players: effect.includes('lose') ? [pilot, { ...opponent, life: 18 }] : [{ ...pilot, life: expectDraw ? 20 : 22 }, opponent],
        decision: priority('after-trigger', object('play-swamp', swamp)) });
      } else if (id === 'after-trigger' && !expectDraw) {
        update({ ownHand: [], decision: priority('after-land') });
      } else {
        assert.fail('A line must replan before playing a land after a real draw');
      }
    });
  const land = { kind: 'play', select: { cardId: swamp.id } };
  if (expectDraw) {
    await assert.rejects(run([land]), { code: 'reevaluation_required' });
    const result = await run([{ kind: 'pass_priority' }]);
    assert.equal(result.reason, 'new_information');
    assert.deepEqual(applied, [['resolve-trigger', 'pass']]);
  } else {
    const result = await run([land]);
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.deepEqual(applied, [['resolve-trigger', 'pass'], ['after-trigger', 'play-swamp']]);
  }
});

const triggerInstruction = 'Pick triggered ability (goes to the stack first)';
const targetsInstruction = 'Select a card in a graveyard';
const trespasserRule = 'Whenever Graveyard Trespasser enters the battlefield or attacks, exile up to one target card from a graveyard.';
const cottageRule = 'Whenever Restless Cottage attacks, create a Food token and exile up to one target card from a graveyard.';
const trespasser = { id: 'trespasser', name: 'Graveyard Trespasser', controllerId: pilot.id, rules: [trespasserRule] };
const restlessCottage = { id: 'restless-cottage', name: 'Restless Cottage', controllerId: pilot.id, rules: [cottageRule] };

function triggerOrderDecision(entries) {
  const ids = entries.map(([id]) => id);
  const wiring = entries.map(([id, source]) => [id, { name: 'Ability', id, rules: source.rules, sourceCard: source, controllerId: pilot.id, abilityType: 'TRIGGERED_NONMANA' }]);
  const prompt = { kind: 'target', text: triggerInstruction, options: {},
    cards: Object.fromEntries(wiring), targets: ids, chosen: [], required: true };
  const battlefield = Object.fromEntries(entries.map(([, source]) => [source.id, source]));
  return describeAgentDecision(projectedChoices({ playerId: pilot.id, view: { step: 'DECLARE_ATTACKERS',
    players: [{ playerId: pilot.id, battlefield }] }, prompt,
  interaction: { mode: 'pickCards', prompt, headline: triggerInstruction, mainButton: null, secondaryButtons: [],
    clickable: new Map(ids.map((id) => [id, { type: 'uuid', id }])) } }, 'trigger-order'));
}

test('[PM-LINE-01] trigger order shows exact rules and a face-up source without exposing a hidden source', () => {
  const hidden = { id: 'hidden', name: 'Unrevealed Identity', faceDown: true, rules: ['A known triggered ability'] };
  const decision = triggerOrderDecision([['order-a', restlessCottage], ['order-b', trespasser], ['order-c', hidden]]);
  assert.equal(decision.triggerOrder, true);
  assert.deepEqual(decision.choices.map(({ objectId, triggerSourceId, label }) => [objectId, triggerSourceId, label]), [
    ['order-a', restlessCottage.id, `${restlessCottage.name} — ${cottageRule}`],
    ['order-b', trespasser.id, `${trespasser.name} — ${trespasserRule}`],
    ['order-c', undefined, 'Ability'],
  ]);
  assert.equal(JSON.stringify(decision).includes(hidden.name), false);
});

test('[PM-LINE-01] confirmed attacks order exact public triggers and choose public graveyard targets in one line', async (t) => {
  const order = triggerOrderDecision([['order-a', restlessCottage], ['order-b', trespasser]]);
  const graveA = { id: 'grave-a', name: 'Mountain' };
  const graveB = { id: 'grave-b', name: 'Swamp' };
  const yours = { ...pilot, battlefield: [restlessCottage, trespasser], graveyard: [graveA] };
  const rival = { ...opponent, graveyard: [graveB] };
  const attacks = (id) => ({ id, kind: 'declareAttackers', choices: [
    object('attack-cottage', restlessCottage), object('attack-trespasser', trespasser), { id: 'confirm', intent: 'confirm_attack' },
  ] });
  const graveyard = (id, card) => ({ id, kind: 'pickCards', instruction: targetsInstruction, choices: [object(`pick-${card.id}`, card)] });
  const trigger = (id, source, abilityText) => ({ id, sourceId: source.id, controllerId: pilot.id, abilityType: 'TRIGGERED_NONMANA', abilityText });
  const cottage = trigger('trigger-cottage', restlessCottage, cottageRule);
  const trespasserStack = trigger('trigger-trespasser', trespasser, trespasserRule);
  const { run, applied } = fixture(t, { players: [yours, rival], step: 'DECLARE_ATTACKERS', decision: attacks('start-attack') },
    (id, _choice, update) => {
      switch (id) {
        case 'start-attack': update({ decision: attacks('second-attacker') }); break;
        case 'second-attacker': update({ decision: attacks('confirm-attack') }); break;
        case 'confirm-attack': update({ decision: order }); break;
        case 'trigger-order': update({ decision: graveyard('target-cottage', graveA) }); break;
        case 'target-cottage': update({ stack: [cottage], decision: graveyard('target-trespasser', graveB) }); break;
        case 'target-trespasser': update({ stack: [trespasserStack, cottage], decision: priority('first-resolution') }); break;
        case 'first-resolution': update({ stack: [cottage], decision: priority('second-resolution'),
          sequenceEvidence: { ...evidence, resolutions: { [trespasserStack.id]: 1 }, resolutionRevision: 1 } }); break;
        case 'second-resolution': update({ stack: [], decision: priority('after-triggers'),
          sequenceEvidence: { ...evidence, resolutions: { [trespasserStack.id]: 1, [cottage.id]: 2 }, resolutionRevision: 2 } }); break;
        default: assert.fail('The line must stop when its exact forecasted triggers settle');
      }
    });
  const result = await run([
    { kind: 'attack', attackers: [restlessCottage.id, trespasser.id], expectTriggers: [
      { sourceId: restlessCottage.id, abilityText: cottageRule }, { sourceId: trespasser.id, abilityText: trespasserRule },
    ] },
    { kind: 'choose', guard: { kind: 'pickCards', instruction: triggerInstruction },
      select: { objectId: restlessCottage.id, label: `${restlessCottage.name} — ${cottageRule}` } },
    ...[graveA, graveB].map((card) => ({ kind: 'choose', guard: { kind: 'pickCards', instruction: targetsInstruction }, select: { objectId: card.id } })),
  ]);
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(result.state.decision.id, 'after-triggers');
  assert.deepEqual(applied, [
    ['start-attack', 'attack-cottage'], ['second-attacker', 'attack-trespasser'], ['confirm-attack', 'confirm'],
    ['trigger-order', 'object-order-a'], ['target-cottage', 'pick-grave-a'], ['target-trespasser', 'pick-grave-b'],
    ['first-resolution', 'pass'], ['second-resolution', 'pass'],
  ]);
});

test('[PM-LINE-01] two triggers from one visible source require a more exact selector', async (t) => {
  const order = triggerOrderDecision([['first', restlessCottage], ['second', restlessCottage]]);
  const { run, applied } = fixture(t, { players: [{ ...pilot, battlefield: [restlessCottage] }, opponent], decision: order },
    () => assert.fail('An ambiguous source must never submit an order choice'));
  const result = await run([{ kind: 'choose', guard: { kind: 'pickCards', instruction: triggerInstruction },
    select: { objectId: restlessCottage.id } }]);
  assert.equal(result.reason, 'ambiguous_choice');
  assert.deepEqual(applied, []);
});

function mutavaultFixture(t, fromPanel = false) {
  const abilityText = "{1}: Mutavault becomes a 2/2 creature with all creature types until end of turn. It's still a land.";
  const mutavault = { id: 'mutavault', cardId: 'mutavault', name: 'Mutavault', types: ['LAND'], rules: [abilityText] };
  const cottage = { id: 'cottage', cardId: 'cottage', name: 'Restless Cottage', types: ['LAND'] };
  const push = { id: 'push', cardId: 'push', name: 'Fatal Push', types: ['INSTANT'] };
  const annex = { id: 'annex-trigger', sourceId: 'annex', controllerId: pilot.id, abilityType: 'TRIGGERED_NONMANA',
    abilityText: 'At the beginning of your end step, draw a card. If you control a Demon, each opponent loses 2 life and you gain 2 life. Otherwise, you lose 2 life.' };
  const activation = { id: 'animate-stack', sourceId: mutavault.id, controllerId: pilot.id,
    abilityType: 'ACTIVATED_NONMANA', abilityText };
  const instruction = 'Choose spell or ability to play Mutavault';
  const panel = { id: 'panel', kind: 'panel', instruction, sourceObjectId: mutavault.id,
    choices: [{ id: 'ability-0', label: '{T}: Add {C}.', type: 'option', abilityType: 'ACTIVATED_MANA' },
      { id: 'ability-1', label: abilityText, type: 'option', abilityType: 'ACTIVATED_NONMANA' }] };
  const animatedMutavault = { ...mutavault, types: ['LAND', 'CREATURE'], power: '2', toughness: '2' };
  const animatedPilot = { ...pilot, battlefield: [animatedMutavault, { ...cottage, tapped: true }] };
  const decision = fromPanel ? panel : priority('respond', object('open-mutavault', mutavault));
  const engine = fixture(t, { step: 'END_TURN', ownHand: [push], stack: [annex],
    players: [{ ...pilot, battlefield: [mutavault, cottage] }, opponent], decision }, (decisionId, _choiceId, update) => {
    switch (decisionId) {
      case 'respond':
        update({ decision: panel });
        break;
      case 'panel':
        update({ decision: { id: 'pay', kind: 'payMana', instruction: 'Pay {1}',
          choices: [object('select-push', push), object('tap-cottage', cottage)] } });
        break;
      case 'pay':
        update({ stack: [annex, activation], decision: priority('resolve-activation') });
        break;
      case 'resolve-activation':
        update({ stack: [annex], players: [animatedPilot, opponent],
          sequenceEvidence: { ...evidence, resolutions: { [activation.id]: 1 },
          resolutionRevision: 1 }, decision: priority('resolve-annex') });
        break;
      case 'resolve-annex':
        update({ stack: [], ownHand: [push, swamp], players: [{ ...animatedPilot, life: 22 }, { ...opponent, life: 18 }],
          sequenceEvidence: { ...evidence,
          resolutions: { [activation.id]: 1, [annex.id]: 2 }, resolutionRevision: 2, informationRevision: 1 },
          decision: priority('after-draw') });
        break;
      default:
        assert.fail('Annex draw requires a fresh decision');
    }
  });
  return { ...engine, mutavault, cottage, push, panel, abilityText };
}

test('[PM-AC-09-RESPONSES] projected Mutavault panel settles the activation and stops at the Annex draw', async (t) => {
  const { run, applied, mutavault, cottage, push, panel, abilityText } = mutavaultFixture(t);
  const open = { kind: 'play', when: 'priority', expectCast: false, select: { cardId: mutavault.id, zone: 'battlefield' } };
  const result = await run([
    open,
    { kind: 'choose', select: { label: abilityText }, guard: { kind: panel.kind, instruction: panel.instruction },
      expectAbility: { sourceId: mutavault.id, abilityText } },
    { kind: 'choose', select: { objectId: cottage.id, zone: 'battlefield' }, guard: { kind: 'payMana' } },
  ]);
  assert.equal(result.reason, 'new_information');
  assert.equal(result.state.decision.id, 'after-draw');
  assert.deepEqual(result.state.ownHand.map(({ id }) => id), [push.id, swamp.id]);
  assert.deepEqual(applied, [['respond', 'open-mutavault'], ['panel', 'ability-1'], ['pay', 'tap-cottage'],
    ['resolve-activation', 'pass'], ['resolve-annex', 'pass']]);
});

test('[PM-AC-09-RESPONSES] Mutavault recovery uses observed option and source IDs through the Annex draw', async (t) => {
  const { run, applied, mutavault, cottage, push, panel, abilityText } = mutavaultFixture(t, true);
  const activate = { kind: 'choose', decisionId: panel.id, choiceId: 'ability-1' };
  const pay = { kind: 'choose', select: { objectId: cottage.id, zone: 'battlefield' },
    guard: { kind: 'payMana', instruction: 'Pay {1}' } };
  await assert.rejects(run([activate, pay]), { code: 'reevaluation_required' });
  assert.deepEqual(applied, []);
  const forecast = await run([{ ...activate, choiceId: 'ability-0', expectAbility: { sourceId: mutavault.id, abilityText } }]);
  assert.equal(forecast.reason, 'bad_ability_expectation');
  assert.deepEqual(applied, []);
  const next = await run([activate]);
  assert.equal(next.state.decision.kind, 'payMana');
  assert.deepEqual(applied, [['panel', 'ability-1']]);
  const paid = await run([pay]);
  assert.equal(paid.state.decision.id, 'resolve-activation');
  assert.deepEqual(applied.at(-1), ['pay', 'tap-cottage']);
  const animation = await run([{ kind: 'pass_priority' }]);
  assert.equal(animation.state.decision.id, 'resolve-annex');
  const annex = await run([{ kind: 'pass_priority' }]);
  assert.equal(annex.reason, 'new_information');
  assert.deepEqual(annex.state.ownHand.map(({ id }) => id), [push.id, swamp.id]);
  assert.deepEqual(annex.state.players.map(({ life }) => life), [22, 18]);
  assert.deepEqual(applied, [['panel', 'ability-1'], ['pay', 'tap-cottage'], ['resolve-activation', 'pass'], ['resolve-annex', 'pass']]);
});

const boseiju = { id: 'boseiju', cardId: 'boseiju', name: 'Boseiju, Who Endures', types: ['LAND'] };

function boseijuFixture(t) {
  const instruction = `Choose spell or ability to play ${boseiju.name}`;
  return fixture(t, { step: 'DRAW', ownHand: [boseiju], decision: priority('draw', object('open-boseiju', boseiju)) },
    (decisionId, choiceId, update) => {
      if (decisionId === 'draw' && choiceId === 'pass') {
        update({ step: 'PRECOMBAT_MAIN', decision: priority('main', object('open-boseiju', boseiju)) });
      } else if (decisionId === 'draw') {
        update({ decision: { id: 'channel-target', kind: 'target',
          instruction: 'Select target artifact, enchantment, or nonbasic land an opponent controls',
          choices: [{ id: 'cancel', label: 'Cancel' }] } });
      } else if (decisionId === 'main') {
        update({ decision: { id: 'panel', kind: 'panel', instruction,
          choices: [{ id: 'ability-0', label: `Play ${boseiju.name}` }, { id: 'ability-1', label: 'Channel — {1}{G}' }] } });
      } else if (decisionId === 'panel' && choiceId === 'ability-0') {
        update({ ownHand: [], players: [{ ...pilot, battlefield: [boseiju] }, opponent], decision: priority('land-played') });
      } else {
        assert.fail('The land-only line must not submit a Channel option');
      }
    });
}

test('[PM-AC-09-RESPONSES] a Boseiju card ID from draw priority can open Channel despite expectCast false', async (t) => {
  const { run, applied } = boseijuFixture(t);
  const result = await run([{ kind: 'play', expectCast: false, select: { cardId: boseiju.id, zone: 'hand' } }]);
  assert.equal(result.reason, 'response_available');
  assert.equal(result.state.decision.id, 'channel-target');
  assert.deepEqual(applied, [['draw', 'open-boseiju']]);
});

test('[PM-AC-09-RESPONSES] Boseiju land-only workflow stops at main before naming the exact picker option', async (t) => {
  const { run, applied } = boseijuFixture(t);
  const destination = { kind: 'pass_until', destination: 'current_turn', step: 'PRECOMBAT_MAIN', priority: 'self' };
  const safeWait = await run([destination]);
  assert.equal(safeWait.reason, 'response_available', 'if_no_play must surface the legal Channel response');
  assert.deepEqual(applied, []);
  const main = await run([{ ...destination, policy: 'decline_optional' }]);
  assert.equal(main.status, 'completed');
  assert.equal(main.lastDestination.step, 'PRECOMBAT_MAIN');
  const land = await run([
    { kind: 'play', select: { cardId: boseiju.id, zone: 'hand' } },
    { kind: 'choose', select: { label: `Play ${boseiju.name}` },
      guard: { kind: 'panel', instruction: `Choose spell or ability to play ${boseiju.name}` } },
  ]);
  assert.equal(land.status, 'completed');
  assert.deepEqual(land.state.players[0].battlefield, [boseiju]);
  assert.deepEqual(applied, [['draw', 'pass'], ['main', 'open-boseiju'], ['panel', 'ability-0']]);
});

for (const variant of ['saga', 'spell', 'reordered', 'wrong-ability', 'extra', 'information']) {
  test(`[PM-LINE-FLOW-5] follows an observed trigger order only on matching evidence: ${variant}`, async (t) => {
    const printed = variant === 'spell' || variant === 'information'
      ? ['Whenever you cast a spell, this creature gets +1/+1 until end of turn.',
        variant === 'information' ? 'Whenever you cast a spell, draw a card.' : 'Whenever you cast a spell, this creature gets +2/+2 until end of turn.']
      : ['I — Create a Food token.', 'II — Gain 2 life.'];
    const sources = printed.map((text, index) => ({ id: `trigger-source-${index}`, name: `Source ${index}`, rules: [text] }));
    const order = triggerOrderDecision(sources.map((source, index) => [`chosen-${index}`, source]));
    const [first, second] = sources.map((source, index) => ({
      id: `chosen-${index}`, name: 'Ability', sourceId: source.id, controllerId: pilot.id,
      abilityType: 'TRIGGERED_NONMANA', abilityText: printed[index],
    }));
    const existing = variant === 'spell' || variant === 'information'
      ? [{ id: 'known-spell-stack', name: 'Shock', types: ['INSTANT'], controllerId: pilot.id, rules: ['Shock deals 2 damage to any target.'] }] : [];
    const resolving = [second, first, ...existing];
    if (variant === 'reordered') resolving.splice(0, 2, first, second);
    if (variant === 'wrong-ability') resolving[0] = { ...second, abilityText: 'Changed text' };
    if (variant === 'extra') resolving.unshift({ ...first, id: 'unplanned' });
    let revision = 0;
    const resolutions = {};
    const { run, applied } = fixture(t, { players: [{ ...pilot, battlefield: sources }, opponent], decision: order, stack: existing, step: 'BEGIN_COMBAT' },
      (id, choice, update) => {
        if (id === order.id) {
          assert.equal(choice, 'object-chosen-0');
          update({ stack: resolving, decision: priority('resolve-0') });
        } else {
          assert.equal(choice, 'pass');
          const top = resolving[revision];
          resolutions[top.id] = ++revision;
          update({ stack: resolving.slice(revision), decision: priority(`resolve-${revision}`),
            step: revision === resolving.length ? 'END_TURN' : 'BEGIN_COMBAT',
            sequenceEvidence: { ...evidence, resolutions: { ...resolutions }, resolutionRevision: revision,
              informationRevision: variant === 'information' ? 1 : 0 } });
        }
      });
    const result = await run([
      { kind: 'choose', decisionId: order.id, choiceId: 'object-chosen-0', adoptTriggerOrder: true },
      { kind: 'pass_until', destination: 'end_step', policy: 'decline_optional' },
    ]);
    if (['saga', 'spell'].includes(variant)) {
      assert.equal(result.status, 'completed', JSON.stringify(result.error));
      assert.deepEqual(result.state.stack, []);
      assert.equal(applied.length, 1 + resolving.length);
    } else {
      assert.equal(result.status, 'interrupted');
      assert.equal(result.reason, variant === 'information' ? 'new_information' : 'state_changed');
      assert.equal(applied.length, variant === 'information' ? 2 : 1);
    }
  });
}
