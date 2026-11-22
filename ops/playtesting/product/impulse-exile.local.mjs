// Isolated XMage acceptance. Both players and all cards belong to this fixture.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setup } from './casting-and-order.local.mjs'

const challenger = 'Emberheart Challenger'
const rage = 'Monstrous Rage'
const pathmaker = "Alania's Pathmaker"
const mountain = 'Mountain'
const printing = name => ({ [challenger]: ['BLB', '133'], [rage]: ['WOE', '142'],
  [pathmaker]: ['BLB', '123'], [mountain]: ['DMU', '271'] })[name]
const endStep = { kind: 'pass_until', destination: 'end_step', policy: 'decline_optional' }

function openingChoice(view, desired) {
  const { decision, ownHand } = view
  if (decision.kind === 'mulligan' && ownHand.length > 5 && !desired.every(name => ownHand.some(card => card.name === name))) {
    return decision.choices.find(choice => /^Mulligan\b/.test(choice.label))
  }
  if (decision.kind === 'mulliganBottom') return decision.choices.find(choice =>
    ownHand.some(card => card.id === (choice.objectId ?? choice.card?.id) && card.name === mountain))
}

async function exercise(fixture, name, fromHand = false, waiver) {
  const { startFixture, ownPlayer, playLineWithPeer, call } = fixture
  const valiant = name === challenger
  const slots = valiant ? [[challenger, 4], [rage, 4], [mountain, 52]] : [[name, 4], [mountain, 56]]
  const cards = slots.map(([cardName, amount]) => {
    const [setCode, cardNumber] = printing(cardName)
    return { cardName, amount, setCode, cardNumber }
  })
  const mirror = { name: 'Isolated visible duplicate', cards: [
    { cardName: challenger, amount: 4 }, { cardName: mountain, amount: 56 },
  ], sideboard: [] }
  if (fromHand && !waiver) fixture.setRivalSetup(view => {
    const opening = openingChoice(view, [challenger])
    if (opening) return opening
    if (view.decision.kind === 'declareAttackers') return view.decision.choices.find(choice => choice.intent === 'confirm_attack')
    if (view.decision.kind === 'payMana') return view.decision.choices.find(choice => choice.card?.name === mountain)
    if (view.decision.kind !== 'priority' || view.activePlayerId !== ownPlayer(view).id || view.step !== 'PRECOMBAT_MAIN') return
    const board = ownPlayer(view).battlefield
    if (!board.some(card => card.name === challenger)) {
      const creature = view.decision.choices.find(choice => choice.card?.name === challenger
        && view.ownHand.some(card => card.id === choice.objectId))
      if (creature) return creature
    }
    if (board.filter(card => card.name === mountain).length < 2) return view.decision.choices.find(choice => choice.canPlayLand)
  })
  let state = await startFixture('Isolated impulse exile ' + name, { name: 'Synthetic exile', cards, sideboard: [] }, 77,
    fromHand && !waiver ? mirror : undefined, 'Modern', 1)
  try {
    const ownMain = view => view.step === 'PRECOMBAT_MAIN' && view.activePlayerId === ownPlayer(view).id
      && view.decision.kind === 'priority' && !view.stack.length
    const board = view => ownPlayer(view).battlefield
    const mountains = view => board(view).filter(card => card.name === mountain && !card.tapped)
    const source = view => (valiant && !fromHand ? board(view) : view.ownHand).find(card => card.name === name)
    const castChoice = (view, spell) => view.decision.choices.find(choice => choice.card?.name === spell
      && view.ownHand.some(card => card.id === choice.objectId))
    state = await setup(fixture, state, { basic: mountain, landLimit: waiver ? 2 : valiant ? 3 : 5,
      ready: view => ownMain(view) && source(view) && mountains(view).length >= (waiver ? 2 : fromHand ? 3 : valiant ? 1 : 4)
        && (!waiver || view.decision.choices.some(choice => choice.canPlayLand && choice.card?.name === mountain))
        && (waiver || !fromHand || fixture.rivalPlayer(view).battlefield.some(card => card.name === challenger))
        && (waiver ? view.ownHand.some(c => c.name === rage) : castChoice(view, valiant ? rage : name))
        && (valiant || view.decision.choices.some(choice => choice.canPlayLand)),
      choose: view => openingChoice(view, valiant ? [challenger, rage] : [name])
        ?? (ownMain(view) && valiant && !fromHand && !source(view) ? castChoice(view, challenger) : undefined),
    })
    const card = source(state)
    const exileRule = card.rules.find(rule => /exile the top card/i.test(rule))
    assert.ok(exileRule, 'The visible source carries its full exile rule')
    const spell = waiver ? state.ownHand.find(c => c.name === rage) : castChoice(state, valiant ? rage : name).card
    const action = { kind: 'play', select: { objectId: spell.id, zone: 'hand' },
      payWith: mountains(state).slice(0, valiant ? 1 : 4).map(land => land.id),
      expectTriggers: [{ sourceId: card.id, abilityText: exileRule }] }
    const actions = []
    if (waiver) {
      const thirdMountain = state.decision.choices.find(choice => choice.canPlayLand && choice.card?.name === mountain)
      actions.push({ kind: 'play', playAs: 'land', select: { objectId: thirdMountain.objectId, zone: 'hand' } })
      action.payWith = [thirdMountain.objectId]
    }
    if (fromHand) {
      actions.push({ kind: 'play', select: { objectId: card.id, zone: 'hand' },
        payWith: mountains(state).slice(waiver ? 0 : 1, waiver ? 2 : 3).map(land => land.id) })
    }
    actions.push(action)
    if (valiant) {
      const prowess = card.rules.find(rule => /^prowess\b/i.test(rule))
      assert.ok(prowess, 'The forecast names each of the two rules of this Challenger')
      if (!waiver) action.reevaluateAfter = true
      action.targets = [{ role: 0, select: { objectId: card.id, zone: 'battlefield' } }]
      action.expectTriggers.push({ sourceId: card.id, abilityText: prowess })
      actions.push({ kind: 'choose', adoptTriggerOrder: true,
        guard: { kind: 'pickCards', instruction: 'Pick triggered ability (goes to the stack first)' },
        select: { objectId: card.id, label: card.name + ' — ' + prowess } })
    }
    if (waiver) actions.push({ kind: 'attack', attackers: [card.id] }, { ...endStep, policy: 'if_no_play' })
    const request = { gameId: state.gameId, cursor: state.cursor, waitMs: 15000 }
    const rejected = await call('play_line', { ...request, commandId: randomUUID(), actions: [action, endStep] })
    assert.deepEqual([rejected.code, rejected.stage, rejected.appliedDecisions], ['reevaluation_required', 'preflight', 0])
    const floatingMana = view => {
      const pool = ownPlayer(view).manaPool
      assert.ok(pool, 'The owner sees its own mana pool')
      return ['red', 'green', 'blue', 'white', 'black', 'colorless'].reduce((n, color) => n + (pool[color] ?? 0), 0)
    }
    if (waiver) assert.equal(floatingMana(state), 0)
    const before = new Set(ownPlayer(state).exile.map(card => card.id))
    const commandId = randomUUID()
    const rivalBefore = fixture.rivalPlayer(state)
    let postcombatPriorityObserved = false
    if (waiver) fixture.setRivalSetup(view => {
      if (view.step === 'POSTCOMBAT_MAIN' && view.decision.kind === 'priority' && ownPlayer(view).life < rivalBefore.life) {
        postcombatPriorityObserved = true
      }
      const opponent = fixture.rivalPlayer(view)
      if (waiver === 'intervention' && opponent.exile.some(c => !c.faceDown && c.name) && view.decision.kind === 'priority' && view.stack.length) {
        return view.decision.choices.find(option => option.card?.name === mountain && option.type === 'manaAbility')
      }
    })
    const receipt = await playLineWithPeer({ ...request, commandId, actions,
      ...(waiver ? { declineExiledCard: { sourceId: card.id, abilityText: exileRule } } : {}) },
      { gameId: state.gameId, turn: state.turn, activePlayerId: state.activePlayerId })
    const revealed = ownPlayer(receipt.state).exile.filter(card => !before.has(card.id) && !card.faceDown && card.name)
    const entered = ownPlayer(receipt.state).battlefield.find(permanent => permanent.cardId === card.cardId)
    const observed = { name, fromHand, waiver, handIdMatchesPermanent: entered?.id === card.id, castWitness: !!entered?.enteringSpellId, status: receipt.status, reason: receipt.reason, code: receipt.code,
      error: receipt.error?.code, applied: receipt.appliedDecisions, step: receipt.state.step, prompt: receipt.state.decision?.kind,
      stackTypes: receipt.state.stack.map(card => card.abilityType), revealed: revealed.length,
      revealedLand: revealed[0]?.types.includes('LAND') === true,
      offeredLand: receipt.state.decision?.choices.some(choice => choice.canPlayLand && choice.objectId === revealed[0]?.id) === true,
      informationChange: receipt.state.sequenceEvidence.informationRevision - state.sequenceEvidence.informationRevision }
    console.log(JSON.stringify({ phase: 'Isolated impulse reveal', ...observed }))
    assert.equal(receipt.commandId, commandId)
    assert.equal(observed.revealed, 1, JSON.stringify(observed))
    assert.equal(receipt.state.turn, state.turn)
    if (waiver) {
      const witness = receipt.state.sequenceEvidence.ownImpulseExile
      const outcome = { status: receipt.status, reason: receipt.reason, error: receipt.error, step: receipt.state.step,
        prompt: receipt.state.decision?.kind, witness: !!witness, actions: receipt.appliedDecisions,
        sourceMatches: witness?.sourceId === card.id, revealedMatches: witness?.cardId === revealed[0].id, postcombatPriorityObserved,
        lastSubmissionAction: receipt.lastSubmission?.actionIndex, lastSubmissionAcknowledged: receipt.lastSubmission?.acknowledged,
        opponentLifeLoss: rivalBefore.life - fixture.rivalPlayer(receipt.state).life,
        untappedMountains: mountains(receipt.state).length, floatingMana: floatingMana(receipt.state) }
      console.log(JSON.stringify({ phase: 'Isolated impulse waiver', variant: waiver, ...outcome }))
      assert.equal(outcome.sourceMatches && outcome.revealedMatches, true, JSON.stringify(outcome))
      assert.equal(outcome.untappedMountains, 0, 'The fixture spent all three available Mountains')
      assert.equal(outcome.floatingMana, 0)
      assert.equal(ownPlayer(receipt.state).battlefield.filter(c => c.name === mountain).length, 3)
      if (waiver === 'intervention') {
        assert.equal(receipt.reason, 'opponent_action', JSON.stringify(outcome))
        assert.equal(receipt.state.step, 'PRECOMBAT_MAIN')
        assert.equal(fixture.rivalPlayer(receipt.state).life, rivalBefore.life)
      } else {
        assert.equal(receipt.status, 'completed', JSON.stringify(outcome))
        assert.equal(receipt.lastDestination.step, 'END_TURN')
        assert.equal(postcombatPriorityObserved, true, 'Both seats handed off priority after the attacker dealt damage')
        assert.equal(receipt.lastSubmission?.actionIndex, actions.length - 1)
        assert.equal(receipt.lastSubmission.acknowledged, true)
        assert.ok(entered?.tapped, 'The previously cast Challenger attacked')
        assert.equal(fixture.rivalPlayer(receipt.state).life, rivalBefore.life - 6, 'Prowess, Rage and the Monster Role applied before combat')
      }
      return
    }
    assert.equal(receipt.state.step, 'PRECOMBAT_MAIN')
    assert.equal(receipt.status, 'interrupted')
    assert.equal(receipt.reason, 'new_information')
    if (!valiant && observed.revealedLand && receipt.state.decision?.kind === 'priority') {
      assert.equal(observed.offeredLand, true, 'An unused land drop can now use the exiled land')
    }
    if (fromHand) {
      assert.ok(entered && entered.id === card.id && entered.cardId === card.cardId && entered.enteringSpellId)
      const other = fixture.rivalPlayer(receipt.state).battlefield.find(permanent => permanent.name === challenger)
      assert.ok(other && other.id !== entered.id && !other.enteringSpellId)
      const pendingRage = receipt.state.stack.find(object => object.cardId === spell.cardId)
      assert.deepEqual(pendingRage.targets, [entered.id], 'Rage targeted the copy cast by this command')
    }
    if (valiant) assert.ok(receipt.state.stack.some(card => card.cardId === spell.cardId && card.name === rage),
      'Monstrous Rage below Valiant remains on stack when the new card becomes visible')
  } finally {
    if (fromHand && !waiver) fixture.setRivalSetup(undefined)
    const current = await call('get_game_state')
    if (current.status === 'active' && current.gameId === state.gameId) {
      await call('concede', { gameId: state.gameId, entireMatch: true })
    }
  }
}

export async function verifyImpulseExile(fixture) {
  const errors = []
  for (const [name, fromHand, waiver] of [[challenger, true, 'attack and pass'], [challenger, true, 'intervention'], [challenger, true], [challenger, false], [pathmaker, false]]) {
    try { await exercise(fixture, name, fromHand, waiver) } catch (error) {
      console.error(JSON.stringify({ phase: 'Impulse fixture failed', name, fromHand, code: error.code, diagnostic: error.message }))
      errors.push(name + ': ' + error.message)
    }
  }
  assert.deepEqual(errors, [])
}
