import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveHistoricalDeck } from './public-deck-identity.mjs'

const deck = {
  name: 'Private Izzet Prowess',
  cards: [
    { cardName: 'Fixture Spell', amount: 56 },
    { cardName: 'Mountain', amount: 4 },
  ],
  sideboard: [{ cardName: 'Fixture Green', amount: 2 }],
}
const lookup = (name) =>
  ({ 'fixture spell': 3, 'fixture green': 16, 'fixture artifact': 0, 'fixture fetch': 0 })[name] ?? null

test('a composition has canonical colors, ignores sideboard colors, and never promotes a private title', () => {
  const result = resolveHistoricalDeck({ format: 'Constructed - Pioneer', snapshot: deck }, lookup)
  assert.equal(result.format, 'Pioneer')
  assert.equal(result.archetype, null)
  assert.equal(result.publicName, null)
  assert.deepEqual(result.colors, ['W', 'U', 'R'])
  const other = resolveHistoricalDeck({ format: 'Pioneer', snapshot: { ...deck, sideboard: [] } }, lookup)
  assert.notEqual(other.signature, result.signature)
  assert.deepEqual(
    resolveHistoricalDeck(
      {
        format: 'Pioneer',
        snapshot: {
          cards: [
            { cardName: 'Fixture Artifact', amount: 56 },
            { cardName: 'Fixture Fetch', amount: 4 },
          ],
        },
      },
      lookup
    ).colors,
    []
  )
})

test('confirmed revisions take priority and conflicts stay unknown; unknown colors differ from colorless', () => {
  const snapshot = { name: 'Boros Hammer', cards: [{ cardName: 'Uncatalogued', amount: 60 }] }
  assert.equal(resolveHistoricalDeck({ format: 'Pioneer', snapshot }, lookup).colors, null)
  assert.deepEqual(
    resolveHistoricalDeck({ format: 'Pioneer', snapshot, registeredArchetypes: ['Boros Aggro'] }, lookup).colors,
    ['W', 'R']
  )
  const claimed = resolveHistoricalDeck(
    { format: 'Pioneer', snapshot, registeredArchetypes: ['Boros Aggro', 'Boros Aggro'], declaredColors: ['R', 'W'] },
    lookup
  )
  assert.equal(claimed.archetype, 'Boros Aggro')
  assert.deepEqual(claimed.colors, ['W', 'R'])
  assert.equal(
    resolveHistoricalDeck(
      { format: 'Pioneer', snapshot, registeredArchetypes: ['Boros Aggro', 'Izzet Prowess'] },
      lookup
    ).archetype,
    null
  )
  assert.equal(
    resolveHistoricalDeck({ format: 'Pioneer', snapshot, registeredArchetypes: ['Secret deck name'] }, lookup)
      .archetype,
    null
  )
})
