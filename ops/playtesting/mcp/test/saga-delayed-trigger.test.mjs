import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evidence, execute, pilot, priority, rival, selection } from './line-fixture.mjs';

// XMage's Kumano chapter prints the entire rule of the ability it creates.
// The later stack object keeps the Saga as its source but has no chapter prefix.
const delayedRule = 'When you next cast a creature spell this turn, that creature enters with an additional +1/+1 counter on it.';
const chapterRule = `II - ${delayedRule}`;
const saga = { id: 'kumano-front', cardId: 'kumano-main', name: 'Kumano Faces Kakkazan',
  controllerId: 'pilot', types: ['ENCHANTMENT'], rules: [chapterRule] };
const creatures = ['Ornithopter', 'Memnite'].map((name) => ({ id: name, cardId: name, name, types: ['ARTIFACT', 'CREATURE'] }));
const land = { id: 'land', cardId: 'land', name: 'Mountain', types: ['LAND'] };
const playable = (card) => selection(`play-${card.id}`, card);
const trigger = (id, abilityText) => ({ id, name: 'Ability', controllerId: 'pilot',
  abilityType: 'TRIGGERED_NONMANA', sourceId: saga.id, abilityText });
const resolutions = (...ids) => ({ ...evidence, resolutionRevision: ids.length,
  resolutions: Object.fromEntries(ids.map((id, index) => [id, index + 1])) });

async function playNextCreature(t, creature, { forecast, opponentResponds = false }) {
  const spell = { ...creature, id: 'creature-spell', controllerId: pilot.id };
  const response = { id: 'rival-counterspell', cardId: 'counterspell-card', name: 'Essence Scatter',
    controllerId: rival.id, types: ['INSTANT'], targets: [spell.id] };
  const chapter = trigger('chapter-II', chapterRule);
  const delayed = trigger('next-creature', delayedRule);
  const creatureInPlay = { ...creature, counters: [{ name: '+1/+1', count: 1 }] };
  const handAfterCast = [land, ...creatures.filter((card) => card.id !== creature.id)];
  return execute(t, { step: 'DRAW', ownHand: [land, ...creatures],
    players: [{ ...pilot, battlefield: [saga] }, rival], decision: priority('draw') }, {
    draw: { step: 'PRECOMBAT_MAIN', stack: [chapter], decision: priority('resolve-chapter') },
    'resolve-chapter': { stack: [], sequenceEvidence: resolutions(chapter.id), decision: priority('cast', ...creatures.map(playable)) },
    cast: { ownHand: handAfterCast, stack: [delayed, spell], decision: priority('resolve-delayed') },
    'resolve-delayed': { stack: opponentResponds ? [response, spell] : [spell], sequenceEvidence: { ...resolutions(chapter.id, delayed.id),
      publicActions: opponentResponds ? { rival: 1 } : {} }, decision: priority('resolve-spell') },
    'resolve-spell': { stack: [], sequenceEvidence: resolutions(chapter.id, delayed.id, spell.id),
      players: [{ ...pilot, battlefield: [saga, creatureInPlay] }, rival], decision: priority('land-drop', playable(land)) },
    'land-drop': { ownHand: handAfterCast.filter((card) => card.id !== land.id),
      players: [{ ...pilot, battlefield: [saga, creatureInPlay, land] }, rival], decision: priority('done') },
  }, [
    { kind: 'choose', decisionId: 'draw', choiceId: 'pass', expectTriggers: [{ sourceId: saga.id, abilityText: chapterRule }] },
    { kind: 'play', select: { objectId: creature.id, zone: 'hand' }, expectTriggers: forecast ? [forecast] : [] },
    { kind: 'play', select: { objectId: land.id, zone: 'hand' } },
  ]);
}

const announced = { sourceId: saga.id, abilityText: delayedRule };
for (const creature of creatures) {
  test(`Kumano's resolved chapter and its next-creature trigger have independent budgets for ${creature.name}`, async (t) => {
    const { receipt, applied } = await playNextCreature(t, creature, { forecast: announced });
    assert.equal(receipt.status, 'completed', JSON.stringify(receipt.error));
    assert.deepEqual(applied, [['draw', 'pass'], ['resolve-chapter', 'pass'], ['cast', `play-${creature.id}`],
      ['resolve-delayed', 'pass'], ['resolve-spell', 'pass'], ['land-drop', 'play-land']]);
  });
}

for (const [caseName, forecast] of [
  ['no forecast', undefined],
  ['repeated chapter text', { sourceId: saga.id, abilityText: chapterRule }],
  ['creature as source', { sourceId: creatures[0].id, abilityText: delayedRule }],
]) {
  test(`the next-creature ability interrupts the queued land on ${caseName}`, async (t) => {
    const { receipt, applied } = await playNextCreature(t, creatures[0], { forecast });
    assert.equal(receipt.reason, 'state_changed');
    assert.deepEqual(applied, [['draw', 'pass'], ['resolve-chapter', 'pass'], ['cast', 'play-Ornithopter']]);
  });
}

test('a public opponent action after the expected delayed trigger interrupts the remaining line', async (t) => {
  const { receipt, applied, state } = await playNextCreature(t, creatures[0], { forecast: announced, opponentResponds: true });
  assert.equal(receipt.reason, 'opponent_action');
  assert.equal(state.stack[0].name, 'Essence Scatter');
  assert.deepEqual(applied.at(-1), ['resolve-delayed', 'pass']);
});
