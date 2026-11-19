const validId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value)
const integerBetween = (value, low, high) => Number.isInteger(value) && value >= low && value <= high
const hasOnly = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key))
const distinct = items => new Set(items).size === items.length
const validIdList = (values, legal) => Array.isArray(values) && values.length <= legal.size
  && distinct(values) && values.every(value => legal.has(value))

function validateCombat(input) {
  if (!hasOnly(input, ['attackers', 'blockers', 'defendingLife', 'replies', 'completeLegalActions', 'completeReplies', 'budget'])
    || !integerBetween(input.defendingLife, 1, 1_000_000) || !integerBetween(input.budget, 1, 10_000)
    || typeof input.completeLegalActions !== 'boolean' || typeof input.completeReplies !== 'boolean') {
    throw new Error('Supply ordinary combat, defending life, action and reply coverage, and a bounded budget')
  }
  const { attackers, blockers, replies = [] } = input
  if (!Array.isArray(attackers) || attackers.length > 20
    || !attackers.every(item => hasOnly(item, ['id', 'power']) && validId(item.id) && integerBetween(item.power, -100_000, 100_000))
    || !distinct(attackers.map(item => item.id))) {
    throw new Error('Supply up to 20 distinct attackers with ordinary power')
  }
  const attackerIds = new Set(attackers.map(item => item.id))
  if (!Array.isArray(blockers) || blockers.length > 20
    || !blockers.every(item => hasOnly(item, ['id', 'canBlock']) && validId(item.id)
      && !attackerIds.has(item.id) && validIdList(item.canBlock, attackerIds))
    || !distinct(blockers.map(item => item.id))) {
    throw new Error('Supply up to 20 distinct blockers and legal blocker-to-attacker pairs')
  }
  if (!Array.isArray(replies) || replies.length > 20 || !replies.every(item =>
    hasOnly(item, ['id', 'removeAttackers', 'lifeGain']) && validId(item.id) && item.id !== 'pass'
      && validIdList(item.removeAttackers ?? [], attackerIds) && integerBetween(item.lifeGain ?? 0, 0, 1_000_000))
    || !distinct(replies.map(item => item.id))) {
    throw new Error('Supply up to 20 distinct public replies with known attackers to remove or life gain')
  }
  return [{ id: 'pass' }, ...replies]
}

// completeLegalActions covers attack options. completeReplies covers both public replies and legal blocks.
export function solveOrdinaryCombat(input) {
  const replies = validateCombat(input)
  const { attackers, blockers, defendingLife, completeLegalActions, completeReplies, budget } = input
  const coverage = { completeLegalActions, completeReplies, budget, budgetExhausted: false,
    visited: 0, attackConfigurations: 0, replyConfigurations: 0, blockAssignments: 0, certifiedAttacks: 0 }
  let bestObserved = null
  let bestCertified = null
  const declareAttack = []

  function visit() {
    if (coverage.visited >= budget) {
      coverage.budgetExhausted = true
      return false
    }
    coverage.visited++
    return true
  }

  function analyzeAttack() {
    if (!visit()) return
    coverage.attackConfigurations++
    const declaredIds = declareAttack.map(attacker => attacker.id)
    let minDamage = Infinity
    let minMargin = Infinity
    let worstLine = null

    for (const reply of replies) {
      if (!visit()) break
      coverage.replyConfigurations++
      const life = defendingLife + (reply.lifeGain ?? 0)
      const surviving = declareAttack.filter(attacker => !reply.removeAttackers?.includes(attacker.id))
      const survivingIds = new Set(surviving.map(attacker => attacker.id))
      const assignments = blockers.map(blocker => ({
        id: blocker.id, targets: blocker.canBlock.filter(id => survivingIds.has(id)),
      })).filter(blocker => blocker.targets.length)
      const blocks = []

      function enumerateBlocks(index) {
        if (!visit()) return
        if (index < assignments.length) {
          const { id: blockerId, targets } = assignments[index]
          enumerateBlocks(index + 1)
          for (const attackerId of targets) {
            if (coverage.budgetExhausted) return
            blocks.push({ blockerId, attackerId })
            enumerateBlocks(index + 1)
            blocks.pop()
          }
          return
        }
        coverage.blockAssignments++
        const blocked = new Set(blocks.map(block => block.attackerId))
        const damage = surviving.reduce((sum, attacker) =>
          sum + (blocked.has(attacker.id) ? 0 : Math.max(0, attacker.power)), 0)
        const line = { attackers: declaredIds, replyId: reply.id, blocks: [...blocks],
          damage, defendingLife: life, lethal: damage >= life }
        minDamage = Math.min(minDamage, damage)
        minMargin = Math.min(minMargin, damage - life)
        if (!worstLine || Number(line.lethal) < Number(worstLine.lethal)
          || (line.lethal === worstLine.lethal && (damage < worstLine.damage
            || (damage === worstLine.damage && life > worstLine.defendingLife)))) worstLine = line
        if (!bestObserved || damage > bestObserved.damage
          || (damage === bestObserved.damage && life < bestObserved.defendingLife)) bestObserved = line
      }

      enumerateBlocks(0)
      if (coverage.budgetExhausted) break
    }

    if (completeReplies && !coverage.budgetExhausted) {
      coverage.certifiedAttacks++
      const lethal = minMargin >= 0
      if (!bestCertified || Number(lethal) > Number(bestCertified.lethal)
        || (lethal === bestCertified.lethal && (minDamage > bestCertified.minDamage
          || (minDamage === bestCertified.minDamage && minMargin > bestCertified.minMargin)))) {
        bestCertified = { minDamage, minMargin, lethal, line: worstLine }
      }
    }
  }

  function enumerateAttacks(index) {
    if (coverage.budgetExhausted) return
    if (index === attackers.length) {
      analyzeAttack()
      return
    }
    declareAttack.push(attackers[index])
    enumerateAttacks(index + 1)
    declareAttack.pop()
    enumerateAttacks(index + 1)
  }

  enumerateAttacks(0)
  return {
    verification: 'ordinary_combat_model',
    principal: bestCertified?.line ?? bestObserved,
    guaranteedDamage: bestCertified?.minDamage ?? null,
    bestObserved,
    forcedLethalInModel: bestCertified?.lethal ?? false,
    optimalInModel: completeLegalActions && completeReplies && !coverage.budgetExhausted,
    coverage,
    limits: [
      'Only unblocked attackers damage the defender. Combines freely selectable attackers and legal single-attacker blocks.',
      'No trample, first strike, double strike, block requirements, other rule-changing effects or engine verification.',
      'Public replies are alternative post-attack outcomes. Supply combined effects as one reply when needed.',
      'A guarantee assumes the submitted blockers, legal pairs, and public replies cover every defense for that attack.',
    ],
  }
}
