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

test('the catalog uses both printed face colors while ignoring commander mana identity', async () => {
  const { loadCatalogColors } = await import('./public-deck-identity.mjs')
  const { DatabaseSync } = await import('node:sqlite')
  const { deflateRawSync } = await import('node:zlib')
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(
      'CREATE TABLE cards(name,colors,identity,double_faced,modal_double_faced,printing); CREATE TABLE printings(id,view); CREATE TABLE meta(key,value)'
    )
    const dictionary = Buffer.from('secondCardFace.white.blue.black.red.green')
    db.prepare('INSERT INTO meta VALUES(?,?)').run('viewDictionary', dictionary)
    const colors = (mask) =>
      Object.fromEntries(['white', 'blue', 'black', 'red', 'green'].map((key, i) => [key, !!(mask & (1 << i))]))
    const add = (id, name, front, identity, back, backName) => {
      db.prepare('INSERT INTO cards VALUES(?,?,?,?,?,?)').run(name, front, identity, 0, backName ? 1 : 0, id)
      const view = {
        name,
        color: colors(front),
        ...(backName && { secondCardFace: { name: backName, color: back === null ? {} : colors(back) } }),
      }
      db.prepare('INSERT INTO printings VALUES(?,?)').run(id, deflateRawSync(JSON.stringify(view), { dictionary }))
    }
    add(1, 'Brightclimb Pathway', 0, 5, 0, 'Grimclimb Pathway')
    add(2, 'Jennifer Walters', 1, 17, 17, 'The Sensational She-Hulk')
    add(3, 'Kiora, Behemoth Beckoner', 18, 18, null, null)
    add(4, 'Unverified', 1, 3, null, 'Missing face data')
    add(5, 'Off-color activation', 1, 5, 1, 'White reverse')
    const catalog = loadCatalogColors(db)
    const palette = (...cards) =>
      resolveHistoricalDeck({ format: 'Pioneer', snapshot: { cards } }, (name) => catalog.get(name)).colors
    assert.deepEqual(palette('Brightclimb Pathway'), [])
    assert.deepEqual(palette('Jennifer Walters'), ['W', 'G'])
    assert.deepEqual(palette('Jennifer Walters', 'Brightclimb Pathway', 'Swamp'), ['W', 'B', 'G'])
    assert.deepEqual(palette('Kiora, Behemoth Beckoner'), ['U', 'G'])
    assert.deepEqual(palette('Off-color activation'), ['W'])
    assert.equal(palette('Unverified'), null)
  } finally {
    db.close()
  }
})
