import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assignMana } from './theory-mana.mjs'
import { runTheoryStudy, sampleLibrary } from './theory-study.mjs'

const spell = (id, count, pips, generic = 0) => ({ id, count, cost: { pips, generic }, tags: ['payoff'] })
const land = (id, count, colors, entersTapped = false) => ({ id, count, land: { colors, entersTapped } })
const blue = land('island', 4, ['U'])
const study = (cards, extra = {}) => ({ seed: 2718, trials: 1000, horizon: 2, onPlay: true,
  cards, policies: [{ id: 'baseline', minimumHand: 7 }], ...extra })
const query = (key, expression, policy = 'baseline') => ({ key, policy, expression })
const presence = query('presence', { has_card: { id: 'spell', turn: 2 } })
const castable = query('castable', { can_cast_by_turn: { id: 'spell', turn: 2 } })
const stranded = query('stranded', { present_not_castable: { id: 'spell', turn: 2 } })
const stats = (spec, ...queries) => runTheoryStudy({ ...spec, queries }).results

test('[PM-THEORY-1] seed and conditional counts are reproducible and agree with a hypergeometric case', () => {
  const spec = study([spell('spell', 4, ['U']), land('island', 56, ['U'])], { trials: 5000 })
  const first = runTheoryStudy({ ...spec, queries: [presence, castable, stranded] })
  const second = runTheoryStudy({ ...spec, queries: [presence, castable, stranded] })
  assert.deepEqual(second, first)
  const without = Array.from({ length: 8 }, (_, i) => (56 - i) / (60 - i)).reduce((product, item) => product * item, 1)
  const expected = 1 - without
  const probability = first.results.presence
  assert.equal(probability.denominator, 5000)
  assert.ok(Math.abs(probability.estimate - expected) < 0.025)
  assert.ok(probability.interval.lower <= expected && probability.interval.upper >= expected)
  assert.equal(first.results.castable.matches, probability.matches)
  assert.equal(first.results.stranded.matches, 0)
})

test('[PM-THEORY-3] distinct usable sources pay repeated colors jointly with colorless and generic', () => {
  const dual = { colors: ['U', 'R'] }, mountain = { colors: ['R'] }, island = { colors: ['U'] }
  const waste = { colors: ['C'] }
  assert.equal(assignMana([dual, mountain], { pips: ['U', 'U'], generic: 0 }), null)
  assert.equal(assignMana([dual, island], { pips: ['U', 'U'], generic: 1 }), null)
  assert.equal(assignMana([dual, mountain], { pips: ['U', 'C'], generic: 0 }), null)
  assert.deepEqual([...assignMana([dual, island, waste, mountain], { pips: ['U', 'U', 'C'], generic: 1 })].sort(),
    [0, 1, 2, 3])
  assert.equal(assignMana([dual, { ...island, tapped: true }], { pips: ['U', 'U'], generic: 0 }), null)
})

test('[PM-THEORY-2/3] the on-play rule and land timing change counted cast opportunities', () => {
  const cards = [spell('spell', 1, ['U', 'U']), land('cove', 1, ['U'], true), blue]
  const offTurn = study(cards, { trials: 32, position: { turn: 1, hand: ['spell', 'cove'], lands: [],
    knownPositions: [{ index: 0, id: 'island' }] } })
  assert.equal(stats(offTurn, castable).castable.matches, 32, 'Tapped on the first turn, ready on the second')
  const position = { ...offTurn.position, hand: ['spell', 'island'] }
  const cards2 = [spell('spell', 0, ['U', 'U']), land('cove', 1, ['U'], true), land('island', 0, ['U'])]
  const delayed = study(cards2, { trials: 32, position: { ...position, knownPositions: [{ index: 0, id: 'cove' }] } })
  assert.equal(stats(delayed, stranded).stranded.matches, 32, 'The second land entered tapped')
  const opening = [spell('spell', 1, ['U']), land('island', 11, ['U'])]
  const turn1 = query('byOne', { can_cast_by_turn: { id: 'spell', turn: 1 } })
  const play = stats(study(opening), turn1).byOne.matches
  const draw = stats(study(opening, { onPlay: false }), turn1).byOne.matches
  assert.ok(draw > play, 'The extra known first-turn draw can find the spell')
})

test('[PM-THEORY-2] a London policy sees only its current hand and records the number bottomed', () => {
  const card = spell('spell', 1, ['U'])
  const policies = [{ id: 'keep-seven', minimumHand: 7 },
    { id: 'to-five', minimumHand: 5, keep: { not: { has_card: { id: 'island' } } } }]
  const result = runTheoryStudy(study([card, land('island', 20, ['U'])], { trials: 120, policies }))
  assert.deepEqual(result.openings['keep-seven'], { 7: 120, 6: 0, 5: 0 })
  assert.deepEqual(result.openings['to-five'], { 7: 0, 6: 0, 5: 120 })
  assert.throws(() => runTheoryStudy(study([card, land('island', 20, ['U'])], {
    policies: [{ id: 'clairvoyant', minimumHand: 5, keep: { draws_contain_card: { id: 'spell', turn: 2 } } }],
  })), /opening hand/)
  const cards = [card, land('island', 20, ['U'])]
  const opening = query('seen', { has_card: { id: 'spell' } }, 'keep-seven')
  const baseline = stats(study(cards, { policies: [policies[0]] }), opening)
  const paired = stats(study(cards, { policies }), opening)
  assert.deepEqual(paired, baseline, 'Adding a second policy does not replace the first policy’s common sample')
})

test('[PM-THEORY-4] known slots outside an explicit shuffle range keep their exact card', () => {
  const cards = ['top', 'a', 'b', 'c', 'bottom']
  const known = [{ index: 0, id: 'top' }, { index: 1, id: 'a' }, { index: 4, id: 'bottom' }]
  const distributions = new Set()
  for (let seed = 0; seed < 24; seed++) {
    const sample = sampleLibrary(cards, seed, known, [{ start: 1, count: 3 }])
    assert.equal(sample[0], 'top')
    assert.equal(sample[4], 'bottom')
    assert.deepEqual([...sample].sort(), [...cards].sort())
    distributions.add(sample.indexOf('a'))
  }
  assert.deepEqual([...distributions].sort(), [1, 2, 3])
})

test('[PM-THEORY-1/2/3] line execution spends resources and supplies paired outcomes', () => {
  const start = { turn: 2, hand: ['spell', 'spell'], lands: [{ id: 'island', tapped: false }],
    canPlayLand: false, knownPositions: [] }
  const policies = [{ id: 'one', line: [{ turn: 2, cardId: 'spell' }] },
    { id: 'two', line: [{ turn: 2, cardId: 'spell' }, { turn: 2, cardId: 'spell' }] }]
  const spec = study([spell('spell', 0, ['U']), land('island', 0, ['U'])],
    { position: start, policies, trials: 24 })
  const output = runTheoryStudy({ ...spec, queries: [
    query('single', { line_executable: { turn: 2 } }, 'one'),
    query('double', { line_executable: { turn: 2 } }, 'two'),
  ], compare: [{ left: 'single', right: 'double' }] })
  assert.equal(output.results.single.matches, 24)
  assert.equal(output.results.double.matches, 0)
  assert.deepEqual(output.comparisons[0].pairs, { both: 0, leftOnly: 24, rightOnly: 0, neither: 0 })
  assert.equal(output.comparisons[0].difference, 1)
})

test('[PM-THEORY-4] paired hypotheses change execution estimates without changing the actor’s policy or draws', () => {
  const position = { turn: 2, hand: ['spell'], lands: [{ id: 'island', tapped: false }], canPlayLand: false }
  const policies = [{ id: 'baseline', line: [{ turn: 2, cardId: 'spell' }] }]
  const spec = study([spell('spell', 0, ['U']), land('island', 0, ['U'])], { position, policies, trials: 48 })
  const metric = query('execution', { line_executable: { turn: 2 } })
  const response = { has_card: { id: 'interaction' } }
  const output = runTheoryStudy({ ...spec, queries: [metric], hypotheses: [
    { id: 'no reply', assumption: 'Public hypothesis has zero copies', response, disrupts: ['execution'],
      cards: [spell('interaction', 0, ['U']), land('island', 8, ['U'])] },
    { id: 'ready reply', assumption: 'Toy hypothesis has a guaranteed response', response, disrupts: ['execution'],
      cards: [spell('interaction', 8, ['U'])] },
  ] })
  assert.equal(output.results.execution.matches, 48)
  assert.equal(output.hypotheses[0].unanswered.execution.matches, 48)
  assert.equal(output.hypotheses[1].unanswered.execution.matches, 0)
  assert.equal(output.hypotheses[1].responseAvailable.matches, 48)
})

test('[PM-THEORY-3] two Burst Lightning payments need six resources even when either spell is legal with five', () => {
  const cards = [spell('burst', 0, ['R']), land('mountain', 0, ['R'])]
  const kicked = { turn: 13, cardId: 'burst', costOverride: { pips: ['R'], generic: 4 } }
  const ordinary = { turn: 13, cardId: 'burst' }
  const outcome = (sources, line) => {
    const position = { turn: 13, hand: ['burst', 'burst'], canPlayLand: false,
      lands: Array.from({ length: sources }, () => ({ id: 'mountain', tapped: false })) }
    const policies = [{ id: 'baseline', line }]
    const spec = study(cards, { position, policies, horizon: 13, trials: 24 })
    return stats(spec, query('line', { line_executable: { turn: 13 } })).line.matches
  }
  assert.equal(outcome(5, [kicked]), 24)
  assert.equal(outcome(5, [ordinary, kicked]), 0)
  assert.equal(outcome(6, [ordinary, kicked]), 24)
})
