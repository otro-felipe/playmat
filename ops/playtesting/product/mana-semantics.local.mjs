import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

const deck = { name: 'Isolated colored mana fixture', cards: [
  { cardName: 'Island', amount: 52 }, { cardName: 'Shivan Reef', amount: 4 }, { cardName: "Stormchaser's Talent", amount: 4 },
], sideboard: [] }

export async function verifyTypedManaTalent({ startFixture, ownPlayer, answer, waitNextOwn, playLineWithPeer, call, totalDeadline }) {
  let state = await startFixture('Isolated typed colored payment and Class trigger', deck, 77)
  const cardInHand = (name) => state.ownHand.find((card) => card.name === name)
  let reef, talent
  while (Date.now() < totalDeadline) {
    const decision = state.decision
    const ownMain = state.step === 'PRECOMBAT_MAIN' && state.activePlayerId === ownPlayer(state).id && decision.kind === 'priority'
    reef = cardInHand('Shivan Reef')
    talent = cardInHand("Stormchaser's Talent")
    if (ownMain && reef && talent && !state.stack.length) break

    // Keep the two named pieces in hand. Only discard surplus basic lands if cleanup asks.
    const cleanup = state.step === 'CLEANUP' && decision.kind === 'target'
      && /^Select .*discard/i.test(decision.instruction ?? '')
      && decision.choices.find((choice) => state.ownHand.some((card) => card.name === 'Island'
        && card.id === (choice.objectId ?? choice.card?.id)))
    const choice = cleanup || decision.choices.find(({ label }) => /^Keep\b|^Play first\b/.test(label))
      || decision.choices.find(({ type }) => type === 'pass')
    assert.ok(choice, `Unexpected colored mana setup decision ${decision.kind}`)
    await answer(state, choice)
    state = await waitNextOwn(decision.id)
  }
  assert.ok(reef && talent && Date.now() < totalDeadline, 'The seeded fixture offers Reef and Talent in the same own main phase')
  const life = ownPlayer(state).life
  const etb = talent.rules.find((rule) => /^When .+ enters\b.*\bcreate\b.*\bOtter\b/i.test(rule))
  assert.ok(etb, 'The visible Talent card publishes the exact entry trigger')

  const started = performance.now()
  const receipt = await playLineWithPeer({ gameId: state.gameId, cursor: state.cursor, commandId: randomUUID(),
    view: 'compact', waitMs: 15_000, actions: [
      { kind: 'play', playAs: 'land', select: { objectId: reef.id, zone: 'hand' } },
      { kind: 'play', select: { objectId: talent.id, zone: 'hand' },
        payWith: [{ sourceId: reef.id, color: 'U' }], expectTriggers: [{ sourceId: talent.id, abilityText: etb }] },
      { kind: 'pass_until', destination: 'end_step', policy: 'decline_optional' },
    ] }, { gameId: state.gameId, turn: state.turn, activePlayerId: state.activePlayerId })
  const context = JSON.stringify({ status: receipt.status, reason: receipt.reason, error: receipt.error,
    code: receipt.code, actionIndex: receipt.actionIndex, step: receipt.state?.step, prompt: receipt.state?.decision?.kind })
  assert.equal(receipt.status, 'completed', context)
  assert.equal(receipt.lastDestination.step, 'END_TURN')
  assert.equal(receipt.state.stack.length, 0)
  const player = ownPlayer(receipt.state)
  assert.equal(player.life, life - 1, 'The blue mana ability paid its controller-damage effect once')
  assert.equal(player.battlefield.find(({ id }) => id === reef.id)?.tapped, true)
  assert.ok(player.battlefield.some(({ id }) => id === talent.id), 'Talent resolved')
  assert.equal(player.battlefield.filter(({ name }) => /\bOtter\b/.test(name)).length, 1, 'Talent entry created one Otter')
  console.log(JSON.stringify({ phase: 'PM-LINE-SEM-1 real Java colored payment and entry trigger', toolTrips: 1,
    appliedDecisions: receipt.appliedDecisions, elapsedMs: Math.round(performance.now() - started) }))
  await call('concede', { gameId: state.gameId, entireMatch: true })
}
