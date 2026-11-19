import { assignMana, manaColors, validManaCost } from './theory-mana.mjs'
import { compileTheoryPredicate } from './theory-predicates.mjs'

export const theoryModelVersion = 'magic-mana-study-v1'
const name = value => typeof value === 'string' && /^[a-z0-9][a-z0-9 _.-]{0,79}$/i.test(value)
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max

function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ state >>> 15, 1 | state)
    value = (value + Math.imul(value ^ value >>> 7, 61 | value)) ^ value
    return ((value ^ value >>> 14) >>> 0) / 2 ** 32
  }
}

function shuffle(cards, start, count, next) {
  for (let index = start + count - 1; index > start; index--) {
    const other = start + Math.floor(next() * (index - start + 1))
    ;[cards[index], cards[other]] = [cards[other], cards[index]]
  }
}

/** Sample unknown slots, then apply only the declared shuffle ranges. */
export function sampleLibrary(cards, seed, known = [], ranges = []) {
  const next = random(seed)
  const rest = [...cards]
  const fixed = new Map()
  for (const { index, id } of known) {
    const copy = rest.indexOf(id)
    if (!integer(index, 0, cards.length - 1) || fixed.has(index) || copy < 0) throw new Error('Invalid fixed library card or slot')
    fixed.set(index, id)
    rest.splice(copy, 1)
  }
  shuffle(rest, 0, rest.length, next)
  let offset = 0
  const sampled = cards.map((_, index) => fixed.get(index) ?? rest[offset++])
  for (const { start, count } of ranges) {
    if (!integer(start, 0, cards.length) || !integer(count, 0, cards.length - start)) throw new Error('Invalid shuffle range')
    shuffle(sampled, start, count, next)
  }
  return sampled
}

function studyCards(input) {
  if (!Array.isArray(input) || !input.length || input.length > 180) throw new Error('Supply 1–180 card entries')
  const result = new Map()
  for (const { id, count, tags = [], land, cost } of input) {
    if (!name(id) || result.has(id) || !integer(count, 0, 250) || !Array.isArray(tags) || tags.length > 16 || !tags.every(name)
      || land && (!Array.isArray(land.colors) || !land.colors.length || land.colors.length > 6
        || !land.colors.every(color => typeof color === 'string' && color.length === 1 && manaColors.includes(color))
        || land.entersTapped !== undefined && typeof land.entersTapped !== 'boolean')
      || cost && !validManaCost(cost) || land && cost) throw new Error('Invalid card, land, or mana cost declaration')
    result.set(id, { id, count, tags, land, cost })
  }
  return result
}

function normalizedPosition(position, cards, library, horizon) {
  if (position === undefined) return null
  if (!position || !integer(position.turn, 1, horizon) || !Array.isArray(position.hand) || position.hand.length > 30
    || position.hand.some(id => !cards.has(id)) || !Array.isArray(position.lands) || position.lands.length > 20
    || position.lands.some(source => !source || !cards.get(source.id)?.land || typeof source.tapped !== 'boolean')
    || position.canPlayLand !== undefined && typeof position.canPlayLand !== 'boolean') throw new Error('Invalid seat-known starting position')
  const known = position.knownPositions ?? []
  const shuffled = position.shuffleRanges ?? []
  if (!Array.isArray(known) || known.length > 250 || !Array.isArray(shuffled) || shuffled.length > 8) throw new Error('Invalid conditional library declaration')
  sampleLibrary(library, 0, known, shuffled)
  return { ...position, knownPositions: known, shuffleRanges: shuffled }
}

function declarePolicies(input, cards, horizon, position) {
  if (!Array.isArray(input) || !input.length || input.length > 4) throw new Error('Supply 1–4 distinct policies')
  const result = new Map()
  for (const { id, minimumHand = 7, keep, preferKeep = [], landOrder = [], line = [] } of input) {
    if (!name(id) || result.has(id) || !integer(minimumHand, 5, 7)
      || !Array.isArray(preferKeep) || preferKeep.some(key => !cards.has(key))
      || !Array.isArray(landOrder) || landOrder.some(key => !cards.get(key)?.land)
      || !Array.isArray(line) || line.length > 12 || line.some(action => !action || !integer(action.turn, position?.turn ?? 1, horizon)
        || !cards.get(action.cardId)?.cost || action.costOverride && !validManaCost(action.costOverride))) throw new Error('Invalid study policy or line')
    if (position && (minimumHand !== 7 || keep !== undefined)) throw new Error('A started position cannot take a London mulligan')
    const keepHand = keep === undefined ? () => true : compileTheoryPredicate(keep, cards, horizon, { opening: true })
    result.set(id, { minimumHand, keepHand, preferKeep, landOrder, line })
  }
  return result
}

function chooseOpening(decks, policy) {
  for (let count = 7; count >= policy.minimumHand; count--) {
    const deck = decks[7 - count]
    const offered = deck.slice(0, 7)
    if (count !== policy.minimumHand && !policy.keepHand({ opening: offered, frames: [] })) continue
    const bottomed = [...offered].sort((a, b) => Number(policy.preferKeep.includes(a)) - Number(policy.preferKeep.includes(b))
      || a.localeCompare(b)).slice(0, 7 - count)
    const kept = [...offered]
    for (const card of bottomed) kept.splice(kept.indexOf(card), 1)
    return { hand: kept, deck: [...deck.slice(7), ...bottomed] }
  }
  throw new Error('Opening exhausted')
}

function landChoice(hand, cards, policy) {
  const rank = id => {
    const index = policy.landOrder.indexOf(id)
    return index === -1 ? policy.landOrder.length : index
  }
  return hand.filter(id => cards.get(id).land).sort((a, b) => rank(a) - rank(b)
    || Number(!!cards.get(a).land.entersTapped) - Number(!!cards.get(b).land.entersTapped)
    || cards.get(b).land.colors.length - cards.get(a).land.colors.length || a.localeCompare(b))[0]
}

function simulate(policy, cards, horizon, onPlay, position, sampleDecks) {
  const { hand, deck } = position ? { hand: [...position.hand], deck: sampleDecks[0] } : chooseOpening(sampleDecks, policy)
  const opening = [...hand]
  const sources = (position?.lands ?? []).map(({ id, tapped }) => ({ ...cards.get(id).land, tapped }))
  const startTurn = position?.turn ?? 1
  const frames = []
  let lineExecutable = true, nextDraw = 0
  for (let turn = startTurn; turn <= horizon; turn++) {
    const atPosition = !!position && turn === startTurn
    if (!atPosition) for (const source of sources) source.tapped = false
    const drawn = !atPosition && (turn > 1 || !onPlay) ? deck[nextDraw++] : undefined
    if (drawn !== undefined) hand.push(drawn)
    const seen = [...hand]
    const landId = atPosition && position.canPlayLand === false ? undefined : landChoice(hand, cards, policy)
    if (landId !== undefined) {
      hand.splice(hand.indexOf(landId), 1)
      const land = cards.get(landId).land
      sources.push({ ...land, tapped: !!land.entersTapped })
    }
    const castable = [...new Set(hand)].filter(id => {
      const cost = cards.get(id).cost
      return cost && assignMana(sources, cost) !== null
    })
    const visibleSources = sources.map(source => ({ ...source }))
    const actions = policy.line.filter(action => action.turn === turn)
    if (actions.length && lineExecutable) {
      const withPayments = [...hand]
      const pips = []
      let generic = 0
      for (const { cardId, costOverride } of actions) {
        const index = withPayments.indexOf(cardId)
        if (index === -1) {
          lineExecutable = false
          break
        }
        withPayments.splice(index, 1)
        const cost = costOverride ?? cards.get(cardId).cost
        pips.push(...cost.pips)
        generic += cost.generic
      }
      const payment = lineExecutable ? assignMana(sources, { pips, generic }) : null
      lineExecutable = payment !== null
      if (lineExecutable) {
        hand.splice(0, hand.length, ...withPayments)
        for (const index of payment) sources[index].tapped = true
      }
    }
    frames.push({ turn, drawn, hand: seen, castable, sources: visibleSources, lineExecutable })
  }
  return { opening, frames }
}

function proportion(matches, denominator) {
  const estimate = matches / denominator
  const z = 1.96
  const scale = 1 + z ** 2 / denominator
  const center = (estimate + z ** 2 / (2 * denominator)) / scale
  const radius = z * Math.sqrt((estimate * (1 - estimate) + z ** 2 / (4 * denominator)) / denominator) / scale
  return { matches, denominator, estimate, interval: { confidence: 0.95, method: 'wilson',
    lower: Math.max(0, center - radius), upper: Math.min(1, center + radius) } }
}

function declareHypotheses(input, queries, horizon, onPlay) {
  if (!Array.isArray(input) || input.length > 4) throw new Error('Supply at most four response hypotheses')
  const names = new Set()
  return input.map(({ id, assumption, cards: opponentCards, response, disrupts, policy = {} }) => {
    if (!name(id) || names.has(id) || typeof assumption !== 'string' || !assumption.trim() || assumption.length > 280
      || !Array.isArray(disrupts) || !disrupts.length || new Set(disrupts).size !== disrupts.length
      || disrupts.some(key => !queries.has(key))) throw new Error('Declare a named response hypothesis and the queries it interrupts')
    names.add(id)
    const cards = studyCards(opponentCards)
    const library = [...cards.values()].flatMap(({ id: key, count }) => Array(count).fill(key))
    if (library.length < 7 || library.length > 250) throw new Error('Invalid response hypothesis library size')
    const declared = declarePolicies([{ ...policy, id }], cards, horizon, null).get(id)
    return { id, assumption, cards, library, policy: declared, check: compileTheoryPredicate(response, cards, horizon),
      opponentOnPlay: !onPlay, matches: 0, unanswered: new Map(disrupts.map(key => [key, 0])) }
  })
}

/** Compare fixed public policies on common samples and return aggregate evidence only. */
export function runTheoryStudy({ seed, trials = 2000, horizon, onPlay, cards: inputCards, position: inputPosition,
  policies: inputPolicies, queries: inputQueries = [], compare = [], hypotheses: inputHypotheses = [] }) {
  if (!integer(seed, 0, 2 ** 32 - 1) || !integer(trials, 1, 5000) || !integer(horizon, 1, inputPosition ? 200 : 8)
    || typeof onPlay !== 'boolean') throw new Error('Supply a uint32 seed, 1–5000 trials, and a bounded turn horizon')
  const cards = studyCards(inputCards)
  const library = [...cards.values()].flatMap(({ id, count }) => Array(count).fill(id))
  if (library.length > 250 || !inputPosition && library.length < 7) throw new Error('Invalid library size for the study')
  const position = normalizedPosition(inputPosition, cards, library, horizon)
  if (position && horizon - position.turn >= 8) throw new Error('A starting position studies at most eight consecutive turns')
  const policies = declarePolicies(inputPolicies, cards, horizon, position)
  if (!Array.isArray(inputQueries) || inputQueries.length > 20 || !Array.isArray(compare) || compare.length > 10) throw new Error('Too many study queries')
  const compiled = new Map()
  for (const { key, policy, expression } of inputQueries) {
    if (!name(key) || compiled.has(key) || !policies.has(policy)) throw new Error('Use a unique query and a declared policy')
    compiled.set(key, { policy, check: compileTheoryPredicate(expression, cards, horizon), matches: 0 })
  }
  const hypotheses = declareHypotheses(inputHypotheses, compiled, horizon, onPlay)
  const framesPerTrial = policies.size * (horizon - (position?.turn ?? 1) + 1) + hypotheses.length * horizon
  if (trials * framesPerTrial > 160_000) throw new Error('Reduce the trial or policy count for this study horizon')
  const pairs = compare.map(({ left, right }) => {
    if (!compiled.has(left) || !compiled.has(right) || left === right) throw new Error('Compare two distinct named queries')
    return { left, right, counts: { both: 0, leftOnly: 0, rightOnly: 0, neither: 0 } }
  })
  const openings = new Map([...policies.keys()].map(key => [key, { 7: 0, 6: 0, 5: 0 }]))
  const seedStream = random(seed)
  const maxPools = position ? 1 : 8 - Math.min(...[...policies.values()].map(policy => policy.minimumHand))
  for (let trial = 0; trial < trials; trial++) {
    const trialSeed = Math.floor(seedStream() * 2 ** 32)
    const pooling = random(trialSeed)
    const pools = Array.from({ length: maxPools }, () => sampleLibrary(library, Math.floor(pooling() * 2 ** 32),
      position?.knownPositions, position?.shuffleRanges))
    const outcomes = new Map()
    for (const [key, policy] of policies) {
      const path = simulate(policy, cards, horizon, onPlay, position, pools)
      if (!position) openings.get(key)[path.opening.length]++
      outcomes.set(key, path)
    }
    const matches = new Map([...compiled].map(([key, query]) => {
      const found = query.check(outcomes.get(query.policy))
      if (found) query.matches++
      return [key, found]
    }))
    for (const { left, right, counts } of pairs) {
      const l = matches.get(left), r = matches.get(right)
      counts[l ? (r ? 'both' : 'leftOnly') : (r ? 'rightOnly' : 'neither')]++
    }
    for (const hypothesis of hypotheses) {
      const responsePool = random((trialSeed ^ 0x9e3779b9) >>> 0)
      const opponentDecks = Array.from({ length: 8 - hypothesis.policy.minimumHand },
        () => sampleLibrary(hypothesis.library, Math.floor(responsePool() * 2 ** 32)))
      const opponent = simulate(hypothesis.policy, hypothesis.cards, horizon, hypothesis.opponentOnPlay, null, opponentDecks)
      if (hypothesis.check(opponent)) {
        hypothesis.matches++
      } else {
        for (const [key, total] of hypothesis.unanswered) if (matches.get(key)) hypothesis.unanswered.set(key, total + 1)
      }
    }
  }
  return { model: theoryModelVersion, metric: 'line_execution_and_card_access', seed, trials, horizon, onPlay,
    assumptions: position ? ['Declared starting seat knowledge and remaining library', 'Unknown slots sampled without replacement']
      : ['London opening pools and one land per turn', 'Players on the play skip their first draw'],
    limits: ['One mana per land, with declared colors and tapped entry', 'No inferred win rate',
      'Response hypotheses assume the named response interrupts the listed lines when available',
      'No unmodeled spells, combat, multimana abilities or cost-changing effects'],
    openings: position ? null : Object.fromEntries(openings),
    results: Object.fromEntries([...compiled].map(([key, query]) => [key, proportion(query.matches, trials)])),
    hypotheses: hypotheses.map(({ id, assumption, matches, unanswered }) => ({ id, assumption,
      responseAvailable: proportion(matches, trials), unanswered: Object.fromEntries(
        [...unanswered].map(([key, count]) => [key, proportion(count, trials)])) })),
    comparisons: pairs.map(({ left, right, counts }) => {
      const difference = (counts.leftOnly - counts.rightOnly) / trials
      const variance = trials === 1 ? 0 : ((counts.leftOnly + counts.rightOnly) / trials - difference ** 2) / (trials - 1)
      const radius = 1.96 * Math.sqrt(Math.max(0, variance))
      return { left, right, difference, pairs: counts, denominator: trials,
        interval: { confidence: 0.95, method: 'paired_normal', lower: Math.max(-1, difference - radius), upper: Math.min(1, difference + radius) } }
    }),
  }
}
