import assert from 'node:assert/strict'
import { test } from 'node:test'
import { archetypesFor, classifyArchetype, verifiedListArchetype } from './deck-performance-identity.mjs'

test('Pioneer library imports resolve tournament nicknames and color abbreviations before generic strategies', () => {
  const names = {
    'Jund Aggro': 'Jund Aggro',
    'Devotion to Green': 'Mono-Green Devotion',
    'RDW': 'Mono-Red Aggro',
    'UR Aggro': 'Izzet Aggro',
    'Lotus Field': 'Lotus Field Combo',
    'UW Control': 'Azorius Control',
    'Golgari MIDRANGE': 'Golgari Midrange',
    'Izzet Control': 'Izzet Control',
    'Selesnya Aggro': 'Selesnya Aggro',
    'Boros Aggro': 'Boros Aggro',
    'Greasefang Parhelion': 'Greasefang Parhelion',
    Creativity: 'Creativity',
    'Jeskai Control': 'Jeskai Control',
  }
  for (const [name, expected] of Object.entries(names)) {
    assert.equal(classifyArchetype('Constructed - Pioneer', name), expected, name)
    assert.ok(archetypesFor('Pioneer').includes(expected))
  }
  assert.equal(classifyArchetype('Pioneer', 'Pilot · UR Aggro v2'), 'Izzet Aggro')
  assert.equal(classifyArchetype('Constructed - Freeform', 'Lotus Field'), 'Other')
  assert.equal(classifyArchetype('Pioneer', 'words with infield endpoints'), 'Other')
})


test('only complete all-basic practice lists and corroborated starter names can refine ambiguous legacy labels', () => {
  const land = amount => [{ name: 'Snow-Covered Forest', amount }]
  const face = { name: 'Ajani, Valiant Protector', amount: 1 }
  assert.equal(verifiedListArchetype('Pioneer', 'Test', land(60)), 'Basic Lands Practice')
  assert.equal(verifiedListArchetype('Pioneer', 'Test', land(59)), null)
  assert.equal(verifiedListArchetype('Limited', 'Practice', land(40)), 'Basic Lands Practice')
  assert.equal(verifiedListArchetype('Variant Magic - Momir Basic', 'Test', land(60)), null)
  assert.equal(verifiedListArchetype('Pioneer', 'Test', land(60), [face]), null)
  assert.equal(verifiedListArchetype('Freeform', face.name, [face]), null)
  assert.equal(verifiedListArchetype('Freeform', face.name, [...land(59), face]), 'Selesnya Counters')
  assert.equal(verifiedListArchetype('Pioneer', face.name, [...land(59), face]), null)
})
