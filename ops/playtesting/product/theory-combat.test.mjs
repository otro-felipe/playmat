import assert from 'node:assert/strict'
import test from 'node:test'
import { solveOrdinaryCombat } from './theory-combat.mjs'

const position = changes => ({
  attackers: [{ id: 'a', power: 4 }, { id: 'b', power: 3 }],
  blockers: [{ id: 'wall', canBlock: ['a', 'b'] }],
  defendingLife: 3,
  completeLegalActions: true,
  completeReplies: true,
  budget: 200,
  ...changes,
})

test('PM-THEORY-5 guarantees ordinary damage against all legal blocks, with a distinct best observed line', () => {
  const result = solveOrdinaryCombat(position())
  assert.equal(result.guaranteedDamage, 3)
  assert.equal(result.forcedLethalInModel, true)
  assert.equal(result.optimalInModel, true)
  assert.deepEqual(result.principal, {
    attackers: ['a', 'b'], replyId: 'pass', blocks: [{ blockerId: 'wall', attackerId: 'a' }],
    damage: 3, defendingLife: 3, lethal: true,
  })
  assert.deepEqual(result.bestObserved, {
    attackers: ['a', 'b'], replyId: 'pass', blocks: [],
    damage: 7, defendingLife: 3, lethal: true,
  })
})

test('PM-THEORY-5 explores legal multi-blocks and uses explicit blocker-to-attacker pairs', () => {
  const result = solveOrdinaryCombat(position({ blockers: [
    { id: 'x', canBlock: ['a'] }, { id: 'y', canBlock: ['a'] },
  ] }))
  assert.equal(result.guaranteedDamage, 3)
  // Both block a, each blocks a alone, or neither blocks. The subsets [a], [b], [] add 4 + 1 + 1.
  assert.equal(result.coverage.blockAssignments, 10)
  assert.equal(result.principal.blocks.every(block => block.attackerId === 'a'), true)
  assert.equal(result.coverage.attackConfigurations, 4)
})

test('PM-THEORY-5 accounts for removal and life gain even when the best observed line is lethal', () => {
  const result = solveOrdinaryCombat(position({
    replies: [
      { id: 'save-life', lifeGain: 5 },
      { id: 'remove-a', removeAttackers: ['a'] },
    ],
  }))
  assert.equal(result.guaranteedDamage, 0)
  assert.equal(result.bestObserved.damage, 7)
  assert.equal(result.forcedLethalInModel, false)
  assert.equal(result.principal.replyId, 'remove-a')
  assert.deepEqual(result.principal.blocks, [{ blockerId: 'wall', attackerId: 'b' }])
  assert.equal(result.coverage.replyConfigurations, 12)

  const gainLife = solveOrdinaryCombat(position({ replies: [{ id: 'save-life', lifeGain: 5 }] }))
  assert.equal(gainLife.guaranteedDamage, 3)
  assert.equal(gainLife.forcedLethalInModel, false)
  assert.equal(gainLife.principal.defendingLife, 8)
})

test('PM-THEORY-5 incomplete replies and unfinished budgets cannot certify observed attacks', () => {
  const partialReplies = solveOrdinaryCombat(position({ completeReplies: false }))
  assert.equal(partialReplies.bestObserved.damage, 7)
  assert.equal(partialReplies.guaranteedDamage, null)
  assert.equal(partialReplies.forcedLethalInModel, false)
  assert.equal(partialReplies.optimalInModel, false)

  const limited = solveOrdinaryCombat(position({
    attackers: [{ id: 'a', power: 4 }],
    blockers: [{ id: 'x', canBlock: ['a'] }, { id: 'y', canBlock: ['a'] }],
    budget: 5,
  }))
  assert.equal(limited.bestObserved.damage, 4)
  assert.equal(limited.guaranteedDamage, null)
  assert.equal(limited.forcedLethalInModel, false)
  assert.equal(limited.coverage.visited, 5)
  assert.equal(limited.coverage.budgetExhausted, true)
})

test('PM-THEORY-5 an incomplete attacker list can witness a covered line but cannot prove the global optimum', () => {
  const result = solveOrdinaryCombat(position({ completeLegalActions: false }))
  assert.equal(result.guaranteedDamage, 3)
  assert.equal(result.forcedLethalInModel, true)
  assert.equal(result.optimalInModel, false)
  assert.equal(result.coverage.completeLegalActions, false)
})

test('PM-THEORY-5 a budget cut on other attacks preserves an already verified lethal line', () => {
  const result = solveOrdinaryCombat(position({
    attackers: [{ id: 'a', power: 4 }], blockers: [], budget: 3,
  }))
  assert.equal(result.coverage.budgetExhausted, true)
  assert.equal(result.coverage.certifiedAttacks, 1)
  assert.equal(result.guaranteedDamage, 4)
  assert.equal(result.forcedLethalInModel, true)
  assert.equal(result.optimalInModel, false)

  const exactBudget = solveOrdinaryCombat(position({
    attackers: [{ id: 'a', power: 4 }], blockers: [], budget: 6,
  }))
  assert.equal(exactBudget.coverage.visited, 6)
  assert.equal(exactBudget.coverage.budgetExhausted, false)
  assert.equal(exactBudget.optimalInModel, true)
})

test('PM-THEORY-5 nonpositive power deals zero ordinary combat damage', () => {
  const result = solveOrdinaryCombat(position({
    attackers: [{ id: 'a', power: 4 }, { id: 'b', power: -3 }],
    blockers: [],
  }))
  assert.deepEqual(result.principal.attackers, ['a', 'b'])
  assert.equal(result.guaranteedDamage, 4)
  assert.equal(result.forcedLethalInModel, true)
})

test('PM-THEORY-5 rejects invalid relations, reserved replies and unsupported damage rules', () => {
  assert.throws(() => solveOrdinaryCombat(position({ blockers: [{ id: 'x', canBlock: ['missing'] }] })), /pairs/)
  assert.throws(() => solveOrdinaryCombat(position({ replies: [{ id: 'pass', lifeGain: 1 }] })), /replies/)
  assert.throws(() => solveOrdinaryCombat(position({ attackers: [{ id: 'a', power: 4, trample: true }] })), /attackers/)
})
