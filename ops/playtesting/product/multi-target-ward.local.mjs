// Uses only the synthetic seats and decks of the isolated sequence fixture.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const redLand = 'Mountain'
const darkLand = 'Swamp'
const goblin = 'Goblin Motivator'
const trespasser = 'Graveyard Trespasser'
const rat = 'Rat Colony'
const isTrespasser = ({ name }) => name === trespasser || name === 'Graveyard Glutton'
const swiftspear = 'Monastery Swiftspear'
const kumano = 'Kumano Faces Kakkazan'
const nemesis = 'Screaming Nemesis'
const printings = {
  [redLand]: ['DMU', '271'], [darkLand]: ['DMU', '268'],
  [goblin]: ['M19', '143'], [trespasser]: ['MID', '104'], [rat]: ['DOM', '101'],
  [swiftspear]: ['KTK', '118'], [kumano]: ['NEO', '152'], [nemesis]: ['DSK', '157'],
  'Reckless Rage': ['RIX', '110'], 'Pit Fight': ['GTC', '223'],
}
const list = (name, cards) => ({
  name,
  cards: cards.map(([cardName, amount]) => {
    const [setCode, cardNumber] = printings[cardName]
    return { cardName, amount, setCode, cardNumber }
  }),
  sideboard: [],
})
const object = choice => choice.objectId ?? choice.card?.id

function develop(state, player, land, creatureNames, desiredCreatures, landsNeeded) {
  const { decision } = state
  const basic = player.battlefield.filter(card => card.name === land)
  if (decision.kind === 'payMana') {
    return decision.choices.find(choice => basic.some(card => !card.tapped && card.id === object(choice)))
  }
  if (decision.kind === 'declareAttackers') return decision.choices.find(choice => choice.intent === 'confirm_attack')
  if (decision.kind === 'declareBlockers') return decision.choices.find(choice => choice.intent === 'confirm_block')
  const creatureCount = player.battlefield.filter(card => card.types?.includes('CREATURE')).length
  if (state.activePlayerId !== player.id || decision.kind !== 'priority' || state.priority !== 'self'
    || state.step !== 'PRECOMBAT_MAIN' || state.stack.length) return
  const inHand = (choice, predicate) => state.ownHand.some(card => card.id === object(choice) && predicate(card))
  return basic.length < landsNeeded && decision.choices.find(choice => choice.canPlayLand && inHand(choice, card => card.name === land))
    || creatureCount < desiredCreatures && decision.choices.find(choice => inHand(choice, card => creatureNames.includes(card.name)))
}

const inHand = (state, name) => state.ownHand.find(card => card.name === name)
const namedBattlefield = (player, name) => player.battlefield.find(card => card.name === name)
const untappedMountains = player => player.battlefield.filter(card => card.name === redLand && !card.tapped)
const chooseObject = (state, id) => id && state.decision.choices.find(choice => object(choice) === id)
const lineBoundary = state => ({ gameId: state.gameId, turn: state.turn, activePlayerId: state.activePlayerId })
const lineContext = receipt => JSON.stringify({ reason: receipt.reason, error: receipt.error, step: receipt.state?.step,
  prompt: receipt.state?.decision?.kind, instruction: receipt.state?.decision?.instruction,
  targetZone: receipt.state?.decision?.targetZone, targetRole: receipt.state?.decision?.targetRole,
  stack: receipt.state?.stack?.map(({ name, abilityText, spellTargetGroups }) => ({ name, abilityText, targetRoles: spellTargetGroups?.map(ids => ids.length) })) })
function discardForCleanup(state, preferredLand, preserve = {}) {
  const decision = state.decision
  if (decision.kind !== 'target' || !/^Select a card to discard\b/i.test(decision.instruction ?? '')) return
  const choices = decision.choices.filter(item => state.ownHand.some(card => card.id === object(item)))
  const cardName = choice => state.ownHand.find(card => card.id === object(choice)).name
  return choices.find(choice => cardName(choice) === preferredLand)
    || choices.find(choice => {
      const name = cardName(choice)
      return state.ownHand.filter(card => card.name === name).length > (preserve[name] ?? 1)
    })
}
const fallbackSetup = (state, preserve) => discardForCleanup(state, redLand, preserve)
  || state.decision.choices.find(item => /^Keep\b|^Play first\b/.test(item.label) || item.type === 'pass')

async function verifyRageLethal({ startFixture, ownPlayer, rivalPlayer, answer, waitNextOwn, playLineWithPeer, totalDeadline, setRivalSetup }) {
  const rageName = 'Reckless Rage'
  const pilotDeck = list('Isolated red lethal line', [[redLand, 44], [rageName, 4], [nemesis, 4], [swiftspear, 4], [kumano, 4]])
  const rivalDeck = list('Isolated Ward target', [[darkLand, 56], [trespasser, 4]])
  setRivalSetup(state => {
    const pilot = ownPlayer(state)
    return develop(state, pilot, darkLand, [trespasser], pilot.life <= 9 ? 1 : 0, 3)
      || discardForCleanup(state, darkLand)
      || state.decision.choices.find(choice => state.decision.kind === 'target' && /^Done$/i.test(choice.label))
  })

  let state = await startFixture('Isolated Rage and Ward lethal', pilotDeck, 77, rivalDeck, 'Pioneer')
  let ready
  while (Date.now() < totalDeadline) {
    const { decision } = state
    const pilot = ownPlayer(state), rival = rivalPlayer(state)
    const swift = namedBattlefield(pilot, swiftspear), scream = namedBattlefield(pilot, nemesis)
    const opposingCreature = rival.battlefield.find(isTrespasser)
    const rage = inHand(state, rageName), spareSaga = inHand(state, kumano)
    const lands = untappedMountains(pilot)
    const main = state.activePlayerId === pilot.id && state.priority === 'self' && state.step === 'PRECOMBAT_MAIN'
      && decision.kind === 'priority' && !state.stack.length
    if (main && rival.life === 8 && opposingCreature && swift?.power === '1' && swift.toughness === '2'
      && scream?.power === '4' && scream.toughness === '4' && !swift.tapped && !scream.tapped
      && rage && spareSaga && lands.length) {
      ready = { swift, scream, opposingCreature, rage, spareSaga, lands }
      break
    }
    let choice
    const saga = namedBattlefield(pilot, kumano)
    if (main && !saga && rival.life === 9 && opposingCreature && rage && inHand(state, nemesis)
      && state.ownHand.filter(card => card.name === kumano).length >= 2 && lands.length >= 4) {
      choice = chooseObject(state, spareSaga.id)
    }
    if (main && saga && rival.life === 8 && !scream && saga.counters?.some(counter => /^lore$/i.test(counter.name) && counter.count === 2)) {
      choice = chooseObject(state, inHand(state, nemesis)?.id)
    }
    if (decision.kind === 'declareAttackers' && state.activePlayerId === pilot.id && rival.life > 9 && swift) {
      choice = (state.combat?.some(group => group.attackers?.some(card => card.id === swift.id))
        ? decision.choices.find(option => option.intent === 'confirm_attack') : chooseObject(state, swift.id))
    }
    choice ||= develop(state, pilot, redLand, [swiftspear], 1, 5) || fallbackSetup(state, { [kumano]: 2 })
    assert.ok(choice, 'Unexpected red lethal setup decision ' + decision.kind + ' ' + decision.instruction)
    await answer(state, choice)
    state = await waitNextOwn(decision.id)
  }
  assert.ok(ready, 'Seeded public play must reach eight life with exact targets, 4/4 Nemesis and 1/2 Swiftspear')
  setRivalSetup(undefined)

  const { swift, scream, opposingCreature, rage, spareSaga, lands } = ready
  const rival = rivalPlayer(state)
  const wardText = opposingCreature.rules.find(rule => /^ward\b/i.test(rule))
  const prowessText = swift.rules.find(rule => /^prowess\b/i.test(rule))
  const damageText = scream.rules.find(rule => /is dealt damage.*any other target/i.test(rule))
  assert.ok(wardText && prowessText && damageText, 'Use exact rules published by the visible sources')
  const guide = await readFile(new URL('../mcp/guides/turn-planning.md', import.meta.url), 'utf8')
  const values = {
    '<rage-object-id>': rage.id,
    '<rage-card-id>': rage.cardId,
    '<trespasser-id>': opposingCreature.id,
    '<nemesis-id>': scream.id,
    '<swiftspear-id>': swift.id,
    '<red-source-id>': lands[0].id,
    '<ward-ability-text>': wardText,
    '<prowess-ability-text>': prowessText,
    '<nemesis-damage-ability-text>': damageText,
    '<kumano-id>': spareSaga.id,
    '<opponent-id>': rival.id,
  }
  const [example] = guide.matchAll(/```json\n([\s\S]*?)\n```/g)
  assert.ok(example, 'The first guide JSON example is the lethal line')
  const command = JSON.parse(example[1], (_, value) => {
    if (typeof value !== 'string' || !value.startsWith('<')) return value
    assert.ok(Object.hasOwn(values, value), 'Use a documented placeholder with a fixture value: ' + value)
    return values[value]
  })
  assert.equal(command.commandId, 'rage-lethal-001')
  const receipt = await playLineWithPeer({ ...command, gameId: state.gameId, cursor: state.cursor,
    commandId: randomUUID() }, lineBoundary(state))
  assert.equal(receipt.skippedSteps, 1, 'Rage reconciles exactly one auto-selected target role: ' + lineContext(receipt))
  const after = receipt.state
  assert.ok(receipt.status === 'completed' || receipt.reason === 'invalidated', 'Advance through Ward, triggers and combat: ' + lineContext(receipt))
  assert.ok(ownPlayer(after).graveyard.some(card => card.id === spareSaga.id || card.cardId === spareSaga.cardId), 'Paid Ward with the declared Kumano: ' + lineContext(receipt))
  assert.ok(!rivalPlayer(after).battlefield.some(card => card.id === opposingCreature.id), 'Rage killed the only blocker')
  assert.equal(rivalPlayer(after).life, 0, 'Direct trigger and unblocked combat finish from eight life: ' + lineContext(receipt))
  const damage = (after.sequenceEvidence?.combatDamage ?? []).filter(hit => hit.targetId === rival.id
    && hit.revision > state.sequenceEvidence.combatRevision)
  assert.deepEqual(damage.map(hit => hit.amount).sort((a, b) => a - b), [2, 4], 'Both attackers dealt six after the two-point trigger')
  assert.ok(['game_over', 'sideboarding', 'match_over'].includes(after.status), 'The engine reached a real game result')
  console.log(JSON.stringify({ phase: 'PM-LINE-SEM-3 real XMage Rage Ward lethal', skippedSteps: receipt.skippedSteps,
    appliedDecisions: receipt.appliedDecisions, triggeredDamage: 2, combatDamage: 6, terminalStatus: after.status }))
}

async function verifyFight({ startFixture, ownPlayer, rivalPlayer, answer, waitNextOwn, playLineWithPeer, call, totalDeadline, setRivalSetup }) {
  const spell = 'Pit Fight'
  const ownDeck = list('Isolated two-role fight', [[redLand, 52], [spell, 4], [goblin, 4]])
  const rivalDeck = list('Isolated public fight targets', [[darkLand, 44], [rat, 16]])
  setRivalSetup(state => develop(state, ownPlayer(state), darkLand, [rat], 2, 2)
    || discardForCleanup(state, darkLand))
  let state = await startFixture('Isolated public fight targets', ownDeck, 77, rivalDeck, 'Pioneer')
  let ready
  while (Date.now() < totalDeadline) {
    const { decision } = state
    const pilot = ownPlayer(state)
    const first = namedBattlefield(pilot, goblin)
    const theirs = rivalPlayer(state).battlefield.filter(card => card.name === rat)
    const lands = untappedMountains(pilot)
    const casting = inHand(state, spell)
    if (state.activePlayerId === pilot.id && state.priority === 'self' && state.step === 'PRECOMBAT_MAIN'
      && decision.kind === 'priority' && !state.stack.length && casting && first && theirs.length === 2 && lands.length >= 2) {
      ready = { first, second: theirs[0], casting, lands }
      break
    }
    const choice = develop(state, pilot, redLand, [goblin], 1, 3) || fallbackSetup(state)
    assert.ok(choice, 'Unexpected setup decision for target fixture: ' + decision.kind)
    await answer(state, choice)
    state = await waitNextOwn(decision.id)
  }
  assert.ok(ready, 'Seeded board and hand required for ' + spell)
  setRivalSetup(undefined)
  const { first, second, casting, lands } = ready
  const actions = [
    { kind: 'play', select: { objectId: casting.id, zone: 'hand' },
      targets: [first, second].map((card, role) => ({ role, targetZone: 'BATTLEFIELD', select: { objectId: card.id } })),
      payWith: lands.slice(0, 2).map(card => card.id) },
    { kind: 'pass_until', destination: 'end_step', policy: 'decline_optional' },
  ]
  const receipt = await playLineWithPeer({ gameId: state.gameId, cursor: state.cursor, commandId: randomUUID(),
    waitMs: 15_000, actions }, lineBoundary(state))
  assert.equal(receipt.status, 'completed', lineContext(receipt))
  assert.equal(receipt.skippedSteps, 1, 'Exactly one mandatory fight role was automatically chosen')
  assert.equal(receipt.lastDestination.step, 'END_TURN')
  assert.equal(receipt.state.stack.length, 0)
  assert.ok(ownPlayer(receipt.state).graveyard.some(card => card.cardId === casting.cardId), 'Spell reached the graveyard')
  assert.ok(!ownPlayer(receipt.state).battlefield.some(card => card.id === first.id), 'The declared friendly creature fought')
  const rivalAfter = rivalPlayer(receipt.state)
  assert.ok(rivalAfter.graveyard.some(card => card.cardId === second.cardId), 'The declared one-toughness Rat died to fight damage')
  assert.equal(rivalAfter.battlefield.filter(card => card.name === rat).length, 1, 'The other legal target stayed on the battlefield')
  console.log(JSON.stringify({ phase: 'PM-LINE-SEM-3 real XMage target roles', spell, skippedSteps: receipt.skippedSteps,
    appliedDecisions: receipt.appliedDecisions }))
  await call('concede', { gameId: state.gameId, entireMatch: true })
}

export async function verifyMultiTargetWard(fixture) {
  try {
    await verifyRageLethal(fixture)
    await verifyFight(fixture)
  } finally {
    fixture.setRivalSetup(undefined)
  }
}
