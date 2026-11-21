import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evidence, execute, pilot, priority, resolved, rival, selection } from './line-fixture.mjs';

const attack = { kind: 'attack', attackers: 'all' };
const declaration = { id: 'attack', kind: 'declareAttackers', choices: [{ id: 'all', intent: 'attack_all' }] };
const confirmation = { id: 'confirm', kind: 'declareAttackers', choices: [{ id: 'yes', intent: 'confirm_attack' }] };
const attackerSteps = {
  after: { step: 'DECLARE_ATTACKERS', decision: declaration },
  attack: { decision: confirmation },
  confirm: { step: 'DECLARE_BLOCKERS', decision: priority('done') },
};

const modal = { id: 'hangout', cardId: 'cast-hangout', controllerId: pilot.id, name: "Heroes' Hangout", types: ['SORCERY'],
  rules: ['Choose one —', 'Date Night — Exile the top two cards of your library.',
    'Patrol Night — One or two target creatures each get +1/+0 and gain first strike until end of turn.'] };

test('[PM-LINE-FLOW-1] the exact selected Patrol text permits targeting, paying and attacking in one line', async (t) => {
  const mountain = { id: 'mountain', cardId: 'mountain', name: 'Mountain', types: ['LAND'] };
  const battlemage = { id: 'battlemage', cardId: 'battlemage', name: 'Pompous Battlemage', types: ['CREATURE'] };
  const stack = [{ ...modal, unpaid: true, selectedModeRules: [modal.rules[2]] }];
  const target = { id: 'target', kind: 'target', choices: [selection('target-battlemage', battlemage)] };
  const result = await execute(t, { stack, players: [{ ...pilot, battlefield: [battlemage, mountain] }, rival], decision: target }, {
    target: { decision: { id: 'pay', kind: 'payMana', choices: [selection('tap', mountain)] } },
    pay: { stack: [{ ...stack[0], unpaid: false }], decision: priority('resolve') },
    resolve: { stack: [], sequenceEvidence: resolved(modal.id), decision: priority('after') },
    ...attackerSteps,
  }, [
    { kind: 'choose', decisionId: target.id, choiceId: 'target-battlemage' },
    { kind: 'choose', guard: { kind: 'payMana' }, select: { objectId: mountain.id } },
    attack,
  ]);
  assert.equal(result.receipt.status, 'completed', JSON.stringify(result.receipt));
  assert.deepEqual(result.applied.map(([id]) => id), ['target', 'pay', 'resolve', 'after', 'attack', 'confirm']);
});

test('[PM-LINE-FLOW-1] the exact selected Date text pauses a pass that actually reveals cards', async (t) => {
  const date = { ...modal, selectedModeRules: [modal.rules[1]] };
  const revealed = { id: 'not-known', name: 'Forest' };
  const result = await execute(t, { stack: [date], decision: priority('resolve') }, {
    resolve: { stack: [], sequenceEvidence: resolved(date.id, 1), revealed: [{ cards: [revealed] }], decision: priority('after') },
  }, [{ kind: 'pass_until', destination: 'end_step', policy: 'decline_optional' }]);
  assert.equal(result.receipt.reason, 'new_information');
  assert.deepEqual(result.applied, [['resolve', 'pass']]);
});

const act = { id: 'act', cardId: 'prepared-act', controllerId: pilot.id, name: 'Improvised Act', types: ['SORCERY'],
  rules: ['You may discard a card. If you do, draw a card.'] };
const question = { id: 'discard-question', kind: 'question', instruction: 'Discard a card and draw a card?',
  choices: [{ id: 'yes', type: 'button', label: 'Yes', answer: true }, { id: 'no', type: 'button', label: 'No', answer: false }] };

for (const fresh of [false, true]) test('[PM-LINE-FLOW-2] exact No carries a deterministic attack ' + (fresh ? 'from a future guarded prompt' : 'from the observed prompt'), async (t) => {
  const initial = fresh ? { stack: [act], decision: priority('resolve') }
    : { stack: [act], sequenceEvidence: resolved(act.id), decision: question };
  const decline = fresh ? { kind: 'choose', guard: { kind: 'question', instruction: question.instruction }, choiceId: 'no' }
    : { kind: 'choose', decisionId: question.id, choiceId: 'no' };
  const result = await execute(t, initial, {
    resolve: { sequenceEvidence: resolved(act.id), decision: question },
    [question.id]: { stack: [], sequenceEvidence: resolved(act.id), decision: priority('after') },
    ...attackerSteps,
  }, [decline, attack]);
  assert.equal(result.receipt.status, 'completed', JSON.stringify(result.receipt));
  assert.deepEqual(result.applied.map(([id]) => id), [...(fresh ? ['resolve'] : []), question.id, 'after', 'attack', 'confirm']);
});

test('[PM-LINE-FLOW-2] exact Yes followed by a witnessed draw cannot apply a queued attack', async (t) => {
  const result = await execute(t, { stack: [act], sequenceEvidence: resolved(act.id), decision: question }, {
    [question.id]: { stack: [], sequenceEvidence: resolved(act.id, 1), ownHand: [{ id: 'draw', name: 'Forest' }], decision: priority('after') },
  }, [{ kind: 'choose', decisionId: question.id, choiceId: 'yes' }, attack]);
  assert.equal(result.receipt.reason, 'new_information');
  assert.deepEqual(result.applied, [[question.id, 'yes']]);
});

test('[PM-LINE-FLOW-3] adopted opposing Annex resolves its private draw before continuing the terminal pass', async (t) => {
  const annex = { id: 'annex', controllerId: rival.id, abilityType: 'TRIGGERED_NONMANA',
    abilityText: 'At the beginning of your end step, draw a card. You lose 2 life.' };
  const result = await execute(t, { stack: [annex], decision: priority('resolve') }, {
    resolve: { stack: [], sequenceEvidence: resolved(annex.id), players: [pilot, { ...rival, handCount: 3, libraryCount: 39 }],
      decision: priority('after') },
    after: { step: 'END_TURN', decision: priority('end') },
  }, [{ kind: 'pass_until', destination: 'end_step', policy: 'decline_optional' }], [annex.id]);
  assert.equal(result.receipt.status, 'completed', JSON.stringify(result.receipt));
  assert.deepEqual(result.applied, [['resolve', 'pass'], ['after', 'pass']]);
});

test('[PM-LINE-FLOW-4] a prepared spell copy of a previously known own permanent does not interrupt the line', async (t) => {
  const battlemage = { id: 'battlemage', cardId: 'battlemage', name: 'Pompous Battlemage', types: ['CREATURE'] };
  const spell = { ...battlemage, id: 'battlemage-stack', controllerId: pilot.id };
  const prepared = { ...act, preparedFromId: battlemage.id };
  const result = await execute(t, { stack: [spell], decision: priority('resolve') }, {
    resolve: { stack: [], sequenceEvidence: resolved(spell.id), decision: priority('after'),
      players: [{ ...pilot, battlefield: [battlemage], exile: [prepared] }, rival] },
    ...attackerSteps,
  }, [attack]);
  assert.equal(result.receipt.status, 'completed', JSON.stringify(result.receipt));
  assert.deepEqual(result.applied.map(([id]) => id), ['resolve', 'after', 'attack', 'confirm']);
});

test('[PM-LINE-FLOW-4] an adopted own casting source can forecast its exact ETB after paying', async (t) => {
  const rule = "When Stormchaser's Talent enters, create a 1/1 blue and red Otter creature token with prowess.";
  const talent = { id: 'talent', cardId: 'talent', name: "Stormchaser's Talent", types: ['ENCHANTMENT'], rules: [rule] };
  const spell = { ...talent, id: 'talent-stack', controllerId: pilot.id };
  const trigger = { id: 'talent-etb', sourceId: talent.id, controllerId: pilot.id,
    abilityType: 'TRIGGERED_NONMANA', abilityText: rule };
  const payment = { id: 'mana-panel', kind: 'panel', choices: [{ id: 'blue', type: 'option', label: 'Add {U}' }] };
  const result = await execute(t, { stack: [spell], decision: payment }, {
    'mana-panel': { decision: priority('resolve') },
    resolve: { stack: [trigger], sequenceEvidence: resolved(spell.id), decision: priority('resolve-etb'),
      players: [{ ...pilot, battlefield: [talent] }, rival] },
    'resolve-etb': { stack: [], sequenceEvidence: { ...evidence, resolutions: { [spell.id]: 1, [trigger.id]: 2 }, resolutionRevision: 2 },
      decision: priority('after') },
    ...attackerSteps,
  }, [{ kind: 'choose', decisionId: payment.id, choiceId: 'blue', expectTriggers: [{ sourceId: talent.id, abilityText: rule }] },
    attack]);
  assert.equal(result.receipt.status, 'completed', JSON.stringify(result.receipt));
  assert.deepEqual(result.applied.map(([id]) => id), ['mana-panel', 'resolve', 'resolve-etb', 'after', 'attack', 'confirm']);
});

test('[PM-LINE-FLOW-4] an unknown card cannot pass as a prepared copy of an unknown source', async (t) => {
  const unknown = { id: 'other', cardId: 'other', name: 'Unknown Card' };
  const result = await execute(t, { stack: [modal], decision: priority('resolve') }, {
    resolve: { stack: [], sequenceEvidence: resolved(modal.id), decision: priority('after'),
      players: [{ ...pilot, battlefield: [unknown], exile: [{ ...act, preparedFromId: unknown.id }] }, rival] },
  }, [{ kind: 'pass_until', destination: 'end_step', policy: 'decline_optional' }]);
  assert.equal(result.receipt.reason, 'new_information');
  assert.deepEqual(result.applied, [['resolve', 'pass']]);
});

test('[PM-LINE-FLOW-2] a guarded question before Learn keeps the remaining information fence', async (t) => {
  const dispute = { id: 'dispute', cardId: 'dispute', name: 'Academic Dispute', types: ['INSTANT'],
    rules: ['Target creature blocks this turn if able. You may have it gain reach until end of turn.', 'Learn.'] };
  const spell = { ...dispute, id: 'dispute-stack', controllerId: pilot.id };
  const reach = { ...question, id: 'gain-reach', sourceObjectId: dispute.id, instruction: 'Have Goblin gain reach until end of turn?' };
  const learn = { ...question, id: 'learn', instruction: 'Learn?' };
  const result = await execute(t, { ownHand: [dispute], decision: priority('cast', selection('cast-dispute', dispute)) }, {
    cast: { stack: [spell], ownHand: [], decision: priority('resolve') },
    resolve: { sequenceEvidence: resolved(spell.id), decision: reach },
    [reach.id]: { decision: learn },
  }, [
    { kind: 'play', select: { objectId: dispute.id }, reevaluateAfter: true },
    { kind: 'choose', guard: { kind: 'question', sourceObjectId: dispute.id, instruction: reach.instruction }, choiceId: 'no' },
  ]);
  assert.equal(result.receipt.reason, 'response_available');
  assert.deepEqual(result.applied, [['cast', 'cast-dispute'], ['resolve', 'pass'], [reach.id, 'no']]);
});

test('[PM-LINE-FLOW-1] a selected mode refreshes the same stack identity before a pass resolves it', async (t) => {
  const result = await execute(t, { stack: [modal], decision: priority('before-mode-frame') }, {
    'before-mode-frame': { stack: [{ ...modal, selectedModeRules: [modal.rules[2]] }], decision: priority('resolve') },
    resolve: { stack: [], sequenceEvidence: resolved(modal.id), decision: priority('after') },
    after: { step: 'END_TURN', decision: priority('end') },
  }, [{ kind: 'pass_until', destination: 'end_step', policy: 'decline_optional' }]);
  assert.equal(result.receipt.status, 'completed', JSON.stringify(result.receipt));
  assert.deepEqual(result.applied, [['before-mode-frame', 'pass'], ['resolve', 'pass'], ['after', 'pass']]);
});

test('[PM-LINE-FLOW-2] a source-bound No uses the engine question and boolean meaning', async (t) => {
  const sourceQuestion = { ...question, sourceObjectId: act.cardId };
  const result = await execute(t, { stack: [act], decision: priority('resolve') }, {
    resolve: { sequenceEvidence: resolved(act.id), decision: sourceQuestion },
    [sourceQuestion.id]: { stack: [], sequenceEvidence: resolved(act.id), decision: priority('after') },
    ...attackerSteps,
  }, [{ kind: 'choose', guard: { kind: 'question', sourceObjectId: act.cardId }, select: { answer: false } }, attack]);
  assert.equal(result.receipt.status, 'completed', JSON.stringify(result.receipt));
  assert.deepEqual(result.applied.map(([id]) => id), ['resolve', sourceQuestion.id, 'after', 'attack', 'confirm']);
});

test('[PM-LINE-FLOW-2] an exact Yes can pay the declared discard but cannot continue past the resulting draw', async (t) => {
  const discard = { id: 'known-discard', cardId: 'known-discard', name: 'Mountain', types: ['LAND'] };
  const discardPrompt = { id: 'discard', kind: 'target', targetZone: 'HAND', targetSourceId: act.cardId,
    choices: [selection('discard-mountain', discard)] };
  const result = await execute(t, { stack: [act], ownHand: [discard], sequenceEvidence: resolved(act.id), decision: question }, {
    [question.id]: { decision: discardPrompt },
    discard: { stack: [], sequenceEvidence: resolved(act.id, 1), ownHand: [{ id: 'drawn', name: 'Forest' }], decision: priority('after') },
  }, [
    { kind: 'choose', decisionId: question.id, choiceId: 'yes' },
    { kind: 'choose', guard: { kind: 'target', targetZone: 'HAND' }, select: { objectId: discard.id } },
    attack,
  ]);
  assert.equal(result.receipt.reason, 'new_information');
  assert.deepEqual(result.applied, [[question.id, 'yes'], ['discard', 'discard-mountain']]);
});

test('[PM-LINE-FLOW-1] a selected deterministic mode also takes precedence on an adopted ability', async (t) => {
  const ability = { id: 'modal-ability', sourceId: 'visible-source', abilityType: 'ACTIVATED_NONMANA', controllerId: pilot.id,
    abilityText: 'Choose one — draw a card; or create a 1/1 creature token.',
    selectedModeRules: ['Create a 1/1 creature token.'] };
  const result = await execute(t, { stack: [ability], decision: priority('resolve') }, {
    resolve: { stack: [], sequenceEvidence: resolved(ability.id), decision: priority('after') },
    ...attackerSteps,
  }, [attack]);
  assert.equal(result.receipt.status, 'completed', JSON.stringify(result.receipt));
  assert.deepEqual(result.applied.map(([id]) => id), ['resolve', 'after', 'attack', 'confirm']);
});
