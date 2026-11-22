import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evidence, execute, pilot, priority, resolved, rival, selection } from './line-fixture.mjs';

const kumano = {
  name: 'Kumano Faces Kakkazan',
  rules: ['I - Kumano Faces Kakkazan deals 1 damage to each opponent and each planeswalker they control.',
    'II - When you next cast a creature spell this turn, that creature enters with an additional +1/+1 counter on it.'],
};
const historyOfBenalia = { name: 'History of Benalia', rules: ['I, II - Create a 2/2 white Knight creature token with vigilance.'] };
const thirdChapter = 'III - Exile this Saga, then return it to the battlefield transformed under your control.';
const fable = {
  name: 'Fable of the Mirror-Breaker',
  rules: ['I - Create a 2/2 red Goblin Shaman creature token with "Whenever this creature attacks, create a Treasure token."',
    'II - You may discard up to two cards. If you do, draw that many cards.'],
};

// XMage's transforming Saga is selected by its main card ID in hand. The
// permanent and the source on the stack both use the front face's object ID.
function sagaEntry(saga = kumano) {
  const opposingPlayer = { ...rival, life: 20 };
  const card = { ...saga, types: ['ENCHANTMENT'], id: 'main-card', cardId: 'main-card', controllerId: pilot.id };
  const permanent = { ...card, id: saga === historyOfBenalia ? card.id : 'front-face', counters: [{ name: 'lore', count: 1 }] };
  const secondCopy = { ...permanent, id: 'another-front-face', cardId: 'another-main-card' };
  const spell = { ...card, id: 'spell' };
  const trigger = { id: 'chapter', name: 'Ability', sourceId: permanent.id, abilityType: 'TRIGGERED_NONMANA',
    controllerId: pilot.id, abilityText: card.rules[0] };
  const withPermanent = { ...pilot, battlefield: [secondCopy, permanent] };
  const initial = { ownHand: [card], players: [{ ...pilot, battlefield: [secondCopy] }, opposingPlayer],
    decision: priority('cast', selection('cast-saga', card)) };
  const enter = { stack: [trigger], sequenceEvidence: resolved(spell.id), players: [withPermanent, opposingPlayer], decision: priority('chapter') };
  const token = { id: 'token', name: saga === historyOfBenalia ? 'Knight' : 'Goblin Shaman', types: ['CREATURE'], isToken: true };
  const afterPlayers = saga === kumano ? [withPermanent, { ...rival, life: 19 }]
    : [{ ...withPermanent, battlefield: [...withPermanent.battlefield, token] }, opposingPlayer];
  const finished = { ...evidence, resolutions: { [spell.id]: 1, [trigger.id]: 2 }, resolutionRevision: 2 };
  const chapter = { stack: [], sequenceEvidence: finished, players: afterPlayers, decision: priority('after') };
  const transitions = {
    cast: { ownHand: [], stack: [spell], decision: priority('resolve') },
    resolve: enter,
    chapter,
    after: { step: 'END_TURN', decision: priority('end') },
  };
  const actions = [{ kind: 'play', select: { objectId: card.id }, expectTriggers: [{ sourceId: card.id, abilityText: card.rules[0] }] },
    { kind: 'pass_until', destination: 'end_step', policy: 'if_no_play' }];
  return { card, permanent, secondCopy, spell, trigger, enter, chapter, initial, transitions, actions,
    run: (t) => execute(t, initial, transitions, actions) };
}

const throughCast = [['cast', 'cast-saga'], ['resolve', 'pass']];
const throughChapter = [...throughCast, ['chapter', 'pass']];
const completeLine = [...throughChapter, ['after', 'pass']];

for (const saga of [kumano, fable, historyOfBenalia]) test('announced chapter I follows the cast to the public permanent: ' + saga.name, async (t) => {
  const { receipt, applied } = await sagaEntry(saga).run(t);
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt.error));
  assert.deepEqual(applied, completeLine);
});

const unexpectedEntries = [
  ['same-name copy', ({ trigger, secondCopy }) => { trigger.sourceId = secondCopy.id; }],
  ['different chapter', ({ trigger }) => { trigger.abilityText = kumano.rules[1]; }],
  ['wrong zone', ({ enter, secondCopy, card }) => {
    enter.players[0] = { ...pilot, battlefield: [secondCopy], graveyard: [card] };
  }],
  ['undeclared trigger', ({ actions }) => { actions[0].expectTriggers = []; }],
  ['wrong face', ({ permanent, trigger, enter, secondCopy }) => {
    const back = { ...permanent, id: 'back-face', name: 'Etching of Kumano', rules: ['Haste'] };
    enter.players[0] = { ...pilot, battlefield: [secondCopy, back] };
    trigger.sourceId = back.id;
  }],
  ['uncast source', ({ card, initial, transitions, actions }) => {
    const other = { ...card, id: 'uncast', cardId: 'uncast' };
    initial.ownHand.push(other);
    transitions.cast.ownHand.push(other);
    actions[0].expectTriggers[0].sourceId = other.id;
  }],
  ['reentry before the trigger', ({ enter, transitions, initial, card }) => {
    const exile = { ...initial.players[0], exile: [card] };
    transitions.resolve = [{ ...enter, stack: [], decision: null }, { players: [exile, enter.players[1]] }, enter];
  }],
  ['duplicate chapter', ({ enter, trigger }) => { enter.stack.push({ ...trigger, id: 'duplicate' }); }],
  ['unwitnessed resolution', ({ enter }) => { enter.sequenceEvidence = evidence; }],
  ['extra optional trigger', ({ enter, trigger }) => {
    enter.stack.push({ ...trigger, id: 'unknown', abilityText: 'Whenever an enchantment enters, you may gain 1 life.' });
  }],
  ['rival trigger', ({ trigger }) => { trigger.controllerId = rival.id; }],
  ['rival action', ({ enter }) => { enter.sequenceEvidence.publicActions = { [rival.id]: 1 }; }, 'opponent_action'],
  ['new decision', ({ chapter }) => {
    chapter.decision = { id: 'replacement', kind: 'question', instruction: 'Apply replacement effect?', choices: [{ id: 'yes' }, { id: 'no' }] };
  }, 'response_available', throughChapter],
  ['new information', ({ chapter }) => { chapter.ownHand = [{ id: 'new-draw', name: 'Mountain' }]; }, 'new_information', throughChapter],
];
for (const [name, change, reason = 'state_changed', accepted = throughCast] of unexpectedEntries) {
  test('announced chapter I leaves the queued tail untouched on ' + name, async (t) => {
    const fixture = sagaEntry();
    change(fixture);
    const { receipt, applied } = await fixture.run(t);
    assert.equal(receipt.reason, reason, JSON.stringify(receipt.error));
    assert.deepEqual(applied, accepted);
  });
}

test('an adopted spell can declare chapter I during payment', async (t) => {
  const { initial, transitions, actions, spell, run } = sagaEntry();
  Object.assign(initial, { ownHand: [], stack: [spell], decision: { id: 'payment', kind: 'payMana', choices: [{ id: 'pay' }] } });
  actions[0] = { kind: 'choose', decisionId: 'payment', choiceId: 'pay', expectTriggers: actions[0].expectTriggers };
  transitions.payment = { decision: priority('resolve') };
  const { receipt, applied } = await run(t);
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt.error));
  assert.deepEqual(applied, [['payment', 'pay'], ...completeLine.slice(1)]);
});

test('the witness survives separate permanent-entry and chapter-stack frames', async (t) => {
  const { transitions, enter, run } = sagaEntry();
  transitions.resolve = [{ ...enter, stack: [], decision: null }, enter];
  const { receipt, applied } = await run(t);
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt.error));
  assert.deepEqual(applied, completeLine);
});

for (const saga of [kumano, historyOfBenalia]) {
  test('an observed blink cannot spend the original entry budget with the same source object ID: ' + saga.name, async (t) => {
    const { card, trigger, initial, chapter, transitions, actions, run } = sagaEntry(saga);
    actions[0].expectTriggers[0].count = 2;
    const exile = { ...initial.players[0], exile: [card] };
    transitions.chapter = [{ ...chapter, decision: null }, { players: [exile, chapter.players[1]] },
      { players: chapter.players, stack: [{ ...trigger, id: 'later-entry-trigger' }], decision: priority('later-entry') }];
    const { receipt, applied } = await run(t);
    assert.equal(receipt.reason, 'state_changed', JSON.stringify(receipt.error));
    assert.deepEqual(applied, throughChapter);
  });
}

for (const chapterText of [kumano.rules[1], thirdChapter]) {
  test('an existing Saga can forecast its later chapter when passing observed draw-step priority: ' + chapterText.split(' - ')[0], async (t) => {
    const permanent = { id: 'front-face', cardId: 'main-card', ...kumano, controllerId: pilot.id,
      types: ['ENCHANTMENT'], rules: [...kumano.rules, thirdChapter] };
    const trigger = { id: 'later-chapter', sourceId: permanent.id, abilityType: 'TRIGGERED_NONMANA',
      controllerId: pilot.id, abilityText: chapterText };
    const after = chapterText === thirdChapter
      ? { ...permanent, id: 'back-face', name: 'Etching of Kumano', types: ['CREATURE', 'ENCHANTMENT'], rules: ['Haste'] }
      : permanent;
    const { receipt, applied } = await execute(t, { step: 'DRAW', decision: priority('draw-step'),
      players: [{ ...pilot, battlefield: [permanent] }, rival] }, {
      'draw-step': { step: 'PRECOMBAT_MAIN', stack: [trigger], decision: priority('chapter') },
      chapter: { stack: [], sequenceEvidence: resolved(trigger.id), decision: priority('after'),
        players: [{ ...pilot, battlefield: [after] }, rival] },
      after: { step: 'END_TURN', decision: priority('end') },
    }, [{ kind: 'choose', decisionId: 'draw-step', choiceId: 'pass',
      expectTriggers: [{ sourceId: permanent.id, abilityText: chapterText }] },
    { kind: 'pass_until', destination: 'end_step', policy: 'if_no_play' }]);
    assert.equal(receipt.status, 'completed', JSON.stringify(receipt.error));
    assert.deepEqual(applied, [['draw-step', 'pass'], ['chapter', 'pass'], ['after', 'pass']]);
  });
}

for (const duplicateSource of [false, true]) {
  test('simultaneous identical chapter II abilities spend only their own source budgets: ' + (duplicateSource ? 'misattributed' : 'both declared'), async (t) => {
    const sagas = ['first', 'second'].map((id) => ({ ...kumano, id: id + '-front', cardId: id,
      types: ['ENCHANTMENT'], controllerId: pilot.id }));
    const triggers = sagas.map((saga, index) => ({ id: 'chapter-' + index, sourceId: duplicateSource ? sagas[0].id : saga.id,
      abilityType: 'TRIGGERED_NONMANA', controllerId: pilot.id, abilityText: kumano.rules[1] }));
    const { receipt, applied } = await execute(t, { step: 'DRAW', decision: priority('draw-step'),
      players: [{ ...pilot, battlefield: sagas }, rival] }, {
      'draw-step': { step: 'PRECOMBAT_MAIN', stack: triggers, decision: priority('first-chapter') },
      'first-chapter': { stack: [triggers[1]], sequenceEvidence: resolved(triggers[0].id), decision: priority('second-chapter') },
      'second-chapter': { stack: [], sequenceEvidence: { ...evidence, resolutionRevision: 2, resolutions: { [triggers[0].id]: 1, [triggers[1].id]: 2 } }, decision: priority('after') },
      after: { step: 'END_TURN', decision: priority('end') },
    }, [{ kind: 'choose', decisionId: 'draw-step', choiceId: 'pass',
      expectTriggers: sagas.map((saga) => ({ sourceId: saga.id, abilityText: kumano.rules[1] })) },
    { kind: 'pass_until', destination: 'end_step', policy: 'if_no_play' }]);
    if (duplicateSource) {
      assert.equal(receipt.reason, 'state_changed');
      assert.deepEqual(applied, [['draw-step', 'pass']]);
    } else {
      assert.equal(receipt.status, 'completed', JSON.stringify(receipt.error));
      assert.deepEqual(applied.map(([id]) => id), ['draw-step', 'first-chapter', 'second-chapter', 'after']);
    }
  });
}

test('an own spell still triggers on cast before its permanent exists', async (t) => {
  const rule = 'When you cast this spell, create a 10/10 colorless Eldrazi creature token.';
  const twin = { id: 'twin-card', cardId: 'twin-card', controllerId: pilot.id, name: 'Desolation Twin',
    types: ['CREATURE'], rules: [rule] };
  const spell = { ...twin, id: 'twin-spell' };
  const trigger = { id: 'twin-ability', sourceId: twin.id, abilityType: 'TRIGGERED_NONMANA', controllerId: pilot.id, abilityText: rule };
  const token = { id: 'eldrazi-token', name: 'Eldrazi', types: ['CREATURE'], isToken: true };
  const { receipt, applied } = await execute(t, { ownHand: [twin], decision: priority('cast', selection('cast-twin', twin)) }, {
    cast: { ownHand: [], stack: [trigger, spell], decision: priority('trigger') },
    trigger: { stack: [spell], sequenceEvidence: resolved(trigger.id), players: [{ ...pilot, battlefield: [token] }, rival], decision: priority('spell') },
    spell: { stack: [], sequenceEvidence: { ...evidence, resolutionRevision: 2, resolutions: { [trigger.id]: 1, [spell.id]: 2 } },
      players: [{ ...pilot, battlefield: [token, twin] }, rival], decision: priority('after') },
    after: { step: 'END_TURN', decision: priority('end') },
  }, [{ kind: 'play', select: { objectId: twin.id }, expectTriggers: [{ sourceId: twin.id, abilityText: rule }] },
    { kind: 'pass_until', destination: 'end_step', policy: 'if_no_play' }]);
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt.error));
  assert.deepEqual(applied.map(([id]) => id), ['cast', 'trigger', 'spell', 'after']);
});

test('read ahead can forecast chapter I while an adopted Saga is already resolving', async (t) => {
  const { spell, initial, actions, transitions, enter, run } = sagaEntry();
  const barbara = { id: 'barbara', cardId: 'barbara', name: 'Barbara Wright', controllerId: pilot.id,
    types: ['CREATURE'], rules: ['History Teacher — Sagas you control have read ahead.'] };
  initial.players[0].battlefield.push(barbara);
  enter.players[0].battlefield.push(barbara);
  Object.assign(initial, { ownHand: [], stack: [spell], sequenceEvidence: resolved(spell.id),
    decision: { id: 'read-ahead', kind: 'amount', instruction: 'Choose the number of lore counters to enter with',
      amount: { min: 1, max: 3 }, choices: [{ id: 'amount', type: 'number' }] } });
  actions[0] = { kind: 'choose', decisionId: 'read-ahead', choiceId: 'amount', value: 1, expectTriggers: actions[0].expectTriggers };
  transitions['read-ahead'] = (_choice, value) => {
    assert.equal(value, 1);
    return enter;
  };
  const { receipt, applied } = await run(t);
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt.error));
  assert.deepEqual(applied, [['read-ahead', 'amount'], ['chapter', 'pass'], ['after', 'pass']]);
});

for (const failure of ['verified entry', 'replacement', 'blink', 'blink in one frame', 'different cast of same card', 'control change', 'counter', 'rival action']) {
  test('[PM-LINE-IMPULSE] protect the next spell when its earlier cast target has a ' + failure, async (t) => {
    const challenger = { id: 'first', cardId: 'first', name: 'Emberheart Challenger', types: ['CREATURE'], controllerId: pilot.id };
    const other = { ...challenger, id: 'second', cardId: 'second' };
    const rage = { id: 'rage', cardId: 'rage', name: 'Monstrous Rage', types: ['INSTANT'], rules: ['Target creature gets +2/+0 until end of turn.'] };
    const spell = { ...challenger, id: 'cast-challenger' };
    const board = { ...pilot, battlefield: [other, { ...challenger, enteringSpellId: spell.id }] };
    const initial = { ownHand: [challenger, rage], players: [{ ...pilot, battlefield: [other] }, rival],
      decision: priority('cast', selection('cast-this-challenger', challenger)) };
    const sequencing = { stack: [], sequenceEvidence: resolved(spell.id), players: [board, rival],
      decision: priority('next', selection('cast-rage', rage)) };
    const absent = { ...sequencing, players: [{ ...pilot, battlefield: [other], exile: [challenger] }, rival] };
    const lost = { ...sequencing, players: [{ ...pilot, battlefield: [other] }, { ...rival, battlefield: [{ ...challenger, controllerId: rival.id }] }] };
    const transitions = {
      cast: { ownHand: [rage], stack: [spell], decision: priority('resolve') },
      resolve: failure === 'blink in one frame' ? [sequencing, { ...sequencing,
        players: [{ ...pilot, battlefield: [other, { ...challenger, enteringSpellId: undefined }] }, rival] }]
        : failure === 'verified entry' ? sequencing : failure === 'different cast of same card' ? { ...sequencing,
          players: [{ ...pilot, battlefield: [other, { ...challenger, enteringSpellId: 'other-spell' }] }, rival] }
        : failure === 'blink' ? [sequencing, absent, sequencing]
        : failure === 'replacement' ? absent : failure === 'control change' ? lost : failure === 'counter'
          ? { ...absent, sequenceEvidence: evidence }
          : { ...sequencing, sequenceEvidence: { ...sequencing.sequenceEvidence, publicActions: { [rival.id]: 1 } } },
      next: { ownHand: [], stack: [{ ...rage, id: 'cast-rage', controllerId: pilot.id }], decision: {
        id: 'target', kind: 'target', targetRole: 0, targetSourceId: rage.id,
        choices: [selection('other-copy', other), selection('first-copy', challenger)] } },
      target: { decision: priority('chosen'), stack: [{ ...rage, id: 'cast-rage', controllerId: pilot.id, targets: [challenger.id] }] },
    };
    const { receipt, applied } = await execute(t, initial, transitions, [
      { kind: 'play', select: { objectId: challenger.id, zone: 'hand' } },
      { kind: 'play', select: { objectId: rage.id, zone: 'hand' },
        targets: [{ role: 0, select: { objectId: challenger.id, zone: 'battlefield' } }] },
    ]);
    const casting = [['cast', 'cast-this-challenger'], ['resolve', 'pass']];
    if (failure === 'verified entry') {
      assert.deepEqual(applied, [...casting, ['next', 'cast-rage'], ['target', 'first-copy']]);
      assert.equal(receipt.status, 'completed');
    } else {
      assert.equal(receipt.status, 'interrupted');
      assert.deepEqual(applied, casting, 'Do not announce Rage or retarget another copy after the dependent permanent was lost');
    }
  });
}
