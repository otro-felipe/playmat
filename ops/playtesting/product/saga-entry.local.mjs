// Opt-in, isolated public-play reconstruction. Both seats use synthetic decks.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const mountain = 'Mountain'
const kumano = 'Kumano Faces Kakkazan'
const fable = 'Fable of the Mirror-Breaker'
const fixtureDeck = name => ({ name: 'Isolated Saga ' + name, cards: [
  { cardName: mountain, amount: 56, setCode: 'DMU', cardNumber: '271' },
  { cardName: name, amount: 4, setCode: 'NEO', cardNumber: name === kumano ? '152' : '141' },
], sideboard: [] })

async function verifyLaterChapters(fixture, initial, permanent) {
  const { ownPlayer, answer, waitNextOwn, playLineWithPeer, totalDeadline } = fixture
  let state = initial
  for (const chapter of ['II', 'III']) {
    // Start the next plan after the draw. Reaching main phase will put a new chapter on the stack.
    while (Date.now() < totalDeadline && !(state.activePlayerId === ownPlayer(state).id
      && state.step === 'DRAW' && state.decision?.kind === 'priority')) {
      const { decision } = state
      if (decision?.kind && decision.kind !== 'waiting') {
        const discard = state.step === 'CLEANUP' && decision.choices.find(choice => choice.card?.name === mountain)
        const choice = discard || decision.choices.find(item => item.type === 'pass' || item.intent === 'confirm_attack')
        assert.ok(choice, 'Unexpected later chapter setup decision: ' + decision.kind)
        await answer(state, choice)
      }
      state = await waitNextOwn(decision?.id)
    }
    const land = state.ownHand.find(card => card.name === mountain)
    assert.ok(land, 'Queued post-draw land for the chapter boundary')
    const receipt = await playLineWithPeer({ gameId: state.gameId, cursor: state.cursor, commandId: randomUUID(),
      waitMs: 15_000, actions: [{ kind: 'play', playAs: 'land', select: { objectId: land.id, zone: 'hand' } }] },
    { gameId: state.gameId, turn: state.turn, activePlayerId: state.activePlayerId })
    state = receipt.state
    const trigger = state.stack.find(item => item.sourceId === permanent.id && item.abilityType === 'TRIGGERED_NONMANA')
    assert.equal(receipt.reason, 'state_changed', 'An unannounced chapter interrupts the implicit trip to main phase')
    assert.ok(trigger?.abilityText.startsWith(chapter + ' - '), chapter + ' is visible on the stack')
    assert.ok(state.ownHand.some(item => item.id === land.id), 'The queued land is still in hand')
    console.log(JSON.stringify({ phase: 'real XMage later chapter', chapter, reason: receipt.reason, queuedLandHeld: true }))
  }
}

async function exercise(fixture, name, announce) {
  const { startFixture, ownPlayer, rivalPlayer, answer, waitNextOwn, playLineWithPeer, call, totalDeadline } = fixture
  let state = await startFixture('Isolated chapter entry ' + name, fixtureDeck(name), 77, undefined, 'Modern')
  try {
    const cost = name === kumano ? 1 : 3
    while (Date.now() < totalDeadline) {
      const { decision } = state
      const pilot = ownPlayer(state)
      const main = decision.kind === 'priority' && state.activePlayerId === pilot.id && state.step === 'PRECOMBAT_MAIN' && !state.stack.length
      const mountains = pilot.battlefield.filter(card => card.name === mountain && !card.tapped)
      if (main && mountains.length >= cost && state.ownHand.some(card => card.name === name)) break
      const choices = decision.choices
      const land = main && choices.find(choice => choice.canPlayLand && choice.card?.name === mountain)
      const discard = state.step === 'CLEANUP' && choices.find(choice => choice.card?.name === mountain)
      const choice = land || discard || choices.find(item => /^Keep\b|^Play first\b/.test(item.label) || item.type === 'pass')
      assert.ok(choice, 'Unexpected Saga setup prompt: ' + decision.kind + ' ' + decision.instruction)
      await answer(state, choice)
      state = await waitNextOwn(decision.id)
    }
    const pilot = ownPlayer(state)
    const card = state.ownHand.find(item => item.name === name)
    const lands = pilot.battlefield.filter(item => item.name === mountain && !item.tapped).slice(0, cost)
    assert.ok(card && lands.length === cost, 'Develop lands and hold the Saga')
    const chapter = card.rules.find(rule => /^I\s*[-—]/.test(rule))
    assert.ok(chapter, 'Use the first chapter as published in the hand view: ' + JSON.stringify(card.rules))
    const rivalLife = rivalPlayer(state).life
    const receipt = await playLineWithPeer({ gameId: state.gameId, cursor: state.cursor, commandId: randomUUID(),
      waitMs: 15_000, actions: [
        { kind: 'play', select: { objectId: card.id, zone: 'hand' },
          payWith: lands.map(land => ({ sourceId: land.id, color: 'R' })),
          ...(announce ? { expectTriggers: [{ sourceId: card.id, abilityText: chapter }] } : {}) },
        { kind: 'pass_until', destination: 'end_step', policy: 'decline_optional' },
      ] }, { gameId: state.gameId, turn: state.turn, activePlayerId: state.activePlayerId })
    const after = receipt.state
    const permanent = ownPlayer(after).battlefield.find(item => item.name === name)
    const trigger = after.stack.find(item => item.abilityType === 'TRIGGERED_NONMANA')
    const observation = { name, announce, status: receipt.status, reason: receipt.reason, error: receipt.error,
      sameMainCard: card.cardId === permanent?.cardId, changedObjectId: card.id !== permanent?.id,
      ownPermanent: permanent?.controllerId === pilot.id,
      hand: { id: card.id, cardId: card.cardId, chapter },
      permanent: permanent && { id: permanent.id, cardId: permanent.cardId, counters: permanent.counters },
      trigger: trigger && { sourceId: trigger.sourceId, abilityText: trigger.abilityText, own: trigger.controllerId === pilot.id },
      destination: receipt.lastDestination?.step, step: after.step,
      publicResolutions: after.sequenceEvidence.resolutionRevision - state.sequenceEvidence.resolutionRevision,
      opponentActions: (after.sequenceEvidence.publicActions[rivalPlayer(state).id] ?? 0) - (state.sequenceEvidence.publicActions[rivalPlayer(state).id] ?? 0) }
    console.log(JSON.stringify({ phase: 'real XMage Saga entry', ...observation }))
    assert.ok(permanent?.counters?.some(counter => counter.name.toLowerCase() === 'lore' && counter.count === 1))
    assert.equal(observation.opponentActions, 0)
    assert.ok(observation.sameMainCard && observation.changedObjectId && observation.ownPermanent, 'XMage exposes the same card under its front-face permanent ID')
    if (announce) {
      assert.equal(receipt.status, 'completed')
      assert.equal(receipt.lastDestination.step, 'END_TURN')
      assert.equal(observation.publicResolutions, 2)
      if (name === kumano) {
        assert.equal(rivalPlayer(after).life, rivalLife - 1)
        await verifyLaterChapters(fixture, after, permanent)
      } else {
        assert.ok(ownPlayer(after).battlefield.some(item => item.isToken && item.power === '2' && item.toughness === '2'))
      }
    } else {
      assert.equal(receipt.status, 'interrupted')
      assert.equal(receipt.reason, 'state_changed')
      assert.equal(after.step, 'PRECOMBAT_MAIN')
      assert.equal(trigger?.controllerId, pilot.id)
      assert.equal(trigger?.sourceId, permanent.id)
      assert.equal(trigger.abilityText, chapter)
      assert.equal(rivalPlayer(after).life, rivalLife)
    }
  } finally { await call('concede', { gameId: state.gameId, entireMatch: true }) }
}

export async function verifySagaEntry(fixture) {
  const failures = []
  for (const [name, announce] of [[kumano, false], [kumano, true], [fable, true]]) {
    try { await exercise(fixture, name, announce) }
    catch (error) { failures.push(name + ' announced=' + announce + ': ' + error.message) }
  }
  assert.deepEqual(failures, [])
}
