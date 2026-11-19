import assert from 'node:assert/strict'
import { test } from 'node:test'
import { searchTacticalTree } from './theory-tactics.mjs'

const pivot = (kind, edges, complete = true) => ({ kind, edges, complete })
const edge = (action, to, weight) => ({ action, to, ...(weight === undefined ? {} : { weight }) })
const win = { kind: 'terminal', scored: true }
const miss = { kind: 'terminal', scored: false }
const tree = extra => ({ objective: 'lethal_this_turn', rootId: 'root', maxDepth: 5, budget: 20, ...extra })

test('[PM-THEORY-5] a complete minimizing reply can disprove a line with a favorable branch', () => {
  const nodes = {
    root: pivot('max', [edge('Attack with both', 'rival'), edge('Attack with one', 'other')]),
    rival: pivot('min', [edge('No blocks', 'win'), edge('Block the larger attacker', 'miss')]),
    other: pivot('min', [edge('Use the known response', 'win'), edge('No response', 'win')]),
    win, miss,
  }
  const result = searchTacticalTree(tree({ nodes }))
  assert.equal(result.forcedInModel, true)
  assert.equal(result.line[0].action, 'Attack with one')
  assert.equal(result.coverage.rivalResponses, 4)
  assert.equal(result.verification, 'input_model')
})

test('[PM-THEORY-5] missing responses or a budget stop are not a guaranteed lethal', () => {
  const nodes = {
    root: pivot('max', [edge('Commit', 'rival')]),
    rival: pivot('min', [edge('Pass', 'win')], false),
    win,
  }
  const partial = searchTacticalTree(tree({ nodes }))
  assert.equal(partial.forcedInModel, false)
  assert.equal(partial.lower, 0)
  assert.equal(partial.upper, 1)
  const exhausted = searchTacticalTree(tree({ nodes, budget: 1 }))
  assert.equal(exhausted.coverage.budgetExhausted, true)
  assert.equal(exhausted.forcedInModel, false)
})

test('[PM-THEORY-5] finite chance is weighted and zero-weight branches cannot spoil proof', () => {
  const nodes = {
    root: pivot('chance', [edge('Favorable', 'win', 0.4), edge('Other result', 'miss', 0.6)]),
    win, miss,
  }
  const decision = searchTacticalTree(tree({ nodes }))
  assert.equal(decision.lower, 0.4)
  assert.equal(decision.upper, 0.4)
  assert.equal(decision.forcedInModel, false)
  assert.throws(() => searchTacticalTree(tree({ nodes: { ...nodes, root: pivot('chance', [edge('Unspecified', 'win', 0.5)]) } })),
    /sum to one/)
  const certain = searchTacticalTree(tree({ nodes: { ...nodes, root: pivot('chance', [
    edge('Certain', 'win', 1), edge('Impossible', 'miss', 0),
  ]) } }))
  assert.equal(certain.forcedInModel, true)
  assert.equal(certain.coverage.chanceOutcomes, 1)
  const tinyUnknown = searchTacticalTree(tree({ nodes: { ...nodes, hidden: { kind: 'unknown' }, root: pivot('chance', [
    edge('Likely', 'win', 1 - 1e-13), edge('Unresolved', 'hidden', 1e-13),
  ]) } }))
  assert.equal(tinyUnknown.classification, 'inconclusive')
  assert.ok(tinyUnknown.lower < tinyUnknown.upper)
})

test('[PM-THEORY-5] bounded cycles and branches beyond the horizon stay unresolved', () => {
  const nodes = { root: pivot('max', [edge('Repeat', 'root')]) }
  const result = searchTacticalTree(tree({ nodes, maxDepth: 2 }))
  assert.equal(result.forcedInModel, false)
  assert.equal(result.coverage.horizonExhausted, true)
  assert.equal(result.classification, 'inconclusive')
})
