// Native MCP and XMage acceptance from public fixture state.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const printings = {
  Mountain: ['DMU', '271'],
  Swamp: ['DMU', '268'],
  'Fatal Push': ['AER', '57'],
  Island: ['DMU', '265'],
  'Burst Lightning': ['FDN', '192'],
  'Mystic Speculation': ['FUT', '41'],
  'Monastery Swiftspear': ['KTK', '118'],
  Guttersnipe: ['M19', '145'],
  Shock: ['M19', '156'],
  'Kumano Faces Kakkazan': ['NEO', '152'],
  "Urza's Saga": ['MH2', '259'],
}

const deck = (name, cards) => ({
  name, cards: cards.map(([cardName, amount]) => {
    const [setCode, cardNumber] = printings[cardName]
    return { cardName, amount, setCode, cardNumber }
  }), sideboard: [],
})
const actionForCard = (card) => ({ kind: 'play', select: { objectId: card.id, zone: 'hand' } })
const endStep = { kind: 'pass_until', destination: 'end_step', policy: 'decline_optional' }
const bound = (state) => ({ gameId: state.gameId, turn: state.turn, activePlayerId: state.activePlayerId })
const ownMain = (state, ownPlayer) => state.decision.kind === 'priority'
  && state.step === 'PRECOMBAT_MAIN' && ownPlayer(state)?.id === state.activePlayerId

async function setup(fixture, state, config) {
  const { ownPlayer, answer, waitNextOwn, gameClock } = fixture
  while (gameClock.hasTime()) {
    const decision = state.decision
    if (config.ready(state)) return state
    const lands = ownPlayer(state)?.battlefield.filter(card => card.types.includes('LAND')) ?? []
    const onMain = ownMain(state, ownPlayer)
    const choice = config.choose?.(state)
      ?? (onMain && lands.length < config.landLimit
        ? decision.choices.find(item => item.canPlayLand && item.card?.name === config.basic) : null)
      ?? decision.choices.find(item => /^Keep\b|^Play first\b/.test(item.label))
      ?? (state.step === 'CLEANUP' ? decision.choices.find(item => item.card?.name === config.basic) : null)
      ?? (decision.kind === 'payMana' ? decision.choices.find(item => item.card?.name === config.basic) : null)
      ?? decision.choices.find(item => item.intent === 'confirm_attack' || item.intent === 'confirm_block')
      ?? (decision.kind === 'priority' ? decision.choices.find(item => item.type === 'pass') : null)
    if (!choice) throw Error('Unexpected casting/order setup prompt: ' + decision.kind + ' ' + decision.instruction)
    try { await answer(state, choice) }
    catch (error) {
      if (!['not_actionable', 'stale_decision'].includes(error.code)) throw error
    }
    state = await waitNextOwn(decision.id)
  }
  assert.fail('Casting/order fixture reached its deadline')
}

function orderAction(state, sourceId) {
  const { decision } = state
  assert.equal(decision.triggerOrder, true, decision.instruction)
  assert.equal(decision.choices.filter(item => item.triggerSourceId).length, 2)
  const choice = decision.choices.find(item => item.triggerSourceId === sourceId)
  assert.ok(choice, 'The selected trigger must identify the public source')
  return { kind: 'choose', decisionId: decision.id, choiceId: choice.id, adoptTriggerOrder: true }
}

function runLine(fixture, state, actions) {
  return fixture.playLineWithPeer({ gameId: state.gameId, cursor: state.cursor,
    commandId: randomUUID(), waitMs: 15_000, actions }, bound(state))
}

async function verifyOptionalCost(fixture, { cardName, basic, mana, instruction, accept, damage }) {
  const { startFixture, ownPlayer, rivalPlayer, call } = fixture
  let state = await startFixture('Isolated optional casting cost', deck('Optional cost', [[basic, 56], [cardName, 4]]), 77)
  const lands = (view) => ownPlayer(view).battlefield.filter(card => card.name === basic && !card.tapped)
  const makeLandDrop = damage && !accept
  const legalLand = (view) => view.decision.choices.find(choice => choice.canPlayLand && choice.card?.name === basic)
  state = await setup(fixture, state, { basic, landLimit: mana, ready: (view) => ownMain(view, ownPlayer)
    && lands(view).length === mana && view.ownHand.some(card => card.name === cardName) && (!makeLandDrop || legalLand(view)) })
  const replacementLand = makeLandDrop ? legalLand(state).objectId : null
  const source = state.ownHand.find(card => card.name === cardName)
  const rival = rivalPlayer(state)
  const payment = lands(state).slice(0, damage && !accept ? 1 : mana)
  const costChoice = { kind: 'choose', guard: { kind: 'question', sourceObjectId: source.id, instruction },
    select: { answer: accept } }
  const choices = [
    actionForCard(source), costChoice,
    ...(damage ? [{ kind: 'choose', guard: { kind: 'target', targetRole: 0, targetSourceId: source.id },
      select: { objectId: rival.id } }] : []),
    ...payment.map(card => ({ kind: 'choose', guard: { kind: 'payMana' }, select: { objectId: card.id, zone: 'battlefield' } })),
    ...(replacementLand ? [{ kind: 'play', playAs: 'land', select: { objectId: replacementLand, zone: 'hand' } }, endStep] : []),
  ]
  const receipt = await runLine(fixture, state, choices)
  if (damage) {
    assert.equal(receipt.status, 'completed', JSON.stringify(receipt.error))
    assert.equal(rivalPlayer(receipt.state).life, rival.life - damage)
    if (replacementLand) {
      assert.ok(ownPlayer(receipt.state).battlefield.some(card => card.id === replacementLand))
      assert.equal(receipt.lastDestination.step, 'END_TURN')
    }
  } else {
    assert.equal(receipt.reason, 'new_information', JSON.stringify(receipt.error))
    assert.ok(receipt.appliedDecisions >= 2 + payment.length, 'Buyback was accepted and paid before scry')
  }
  console.log(JSON.stringify({ phase: 'PM-LINE-SEM-6 real Java', cardName, accept, applied: receipt.appliedDecisions }))
  await call('concede', { gameId: state.gameId, entireMatch: true })
}

async function verifyCastOrder(fixture) {
  const { startFixture, ownPlayer, rivalPlayer, answer, waitNextOwn, call } = fixture
  const setupCards = ['Monastery Swiftspear', 'Guttersnipe']
  let state = await startFixture('Isolated cast trigger order', deck('Cast triggers',
    [['Mountain', 48], [setupCards[0], 4], [setupCards[1], 4], ['Shock', 4]]), 77)
  const board = (view) => ownPlayer(view).battlefield
  state = await setup(fixture, state, { basic: 'Mountain', landLimit: 4,
    ready: (view) => ownMain(view, ownPlayer) && setupCards.every(name => board(view).some(card => card.name === name))
      && board(view).some(card => card.name === 'Mountain' && !card.tapped) && view.ownHand.some(card => card.name === 'Shock'),
    choose: (view) => ownMain(view, ownPlayer) ? view.decision.choices.find(item => setupCards.includes(item.card?.name)
      && view.ownHand.some(card => card.id === item.card.id) && !board(view).some(card => card.name === item.card.name)) : undefined,
  })
  const who = rivalPlayer(state)
  const shock = state.decision.choices.find(item => item.card?.name === 'Shock')
  await answer(state, shock)
  state = await waitNextOwn(state.decision.id)
  assert.equal(state.decision.kind, 'target')
  await answer(state, state.decision.choices.find(item => item.objectId === who.id))
  state = await waitNextOwn(state.decision.id)
  assert.equal(state.decision.kind, 'payMana')
  await answer(state, state.decision.choices.find(item => item.card?.name === 'Mountain'))
  state = await waitNextOwn(state.decision.id)
  const snip = board(state).find(card => card.name === 'Guttersnipe')
  const swift = board(state).find(card => card.name === 'Monastery Swiftspear')
  const receipt = await runLine(fixture, state, [orderAction(state, snip.id),
    { kind: 'attack', attackers: [swift.id] }, endStep])
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt.error))
  assert.equal(rivalPlayer(receipt.state).life, who.life - 6, 'Shock, Guttersnipe and the prowess attacker each dealt 2')
  assert.equal(Number(board(receipt.state).find(card => card.id === swift.id).power), 2)
  console.log(JSON.stringify({ phase: 'PM-LINE-FLOW-5 real Java', sources: setupCards }))
  await call('concede', { gameId: state.gameId, entireMatch: true })
}

// Both scripted seats use the same isolated match runner and only their own projected choices.
export async function verifyVisibleResponse(fixture) {
  const { startFixture, ownPlayer, rivalPlayer, answer, waitNextOwn, call, setRivalSetup, playLineWithPeer } = fixture
  const oneLand = (state, name) => state.decision.choices.find(choice => choice.canPlayLand && choice.card?.name === name)
  const swift = 'Monastery Swiftspear', burn = 'Burst Lightning', removal = 'Fatal Push'
  let responseReady = false
  let targetId
  setRivalSetup(peer => {
    const { decision } = peer
    const swamps = ownPlayer(peer).battlefield.filter(card => card.name === 'Swamp' && !card.tapped)
    responseReady = swamps.length > 0 && peer.ownHand.some(card => card.name === removal)
    if (decision.kind === 'payMana') return decision.choices.find(choice => swamps.some(card => card.id === choice.objectId))
    if (decision.kind === 'target' && peer.step !== 'CLEANUP') return decision.choices.find(choice => choice.objectId === targetId)
    if (decision.kind === 'priority') {
      if (targetId && peer.stack.length === 2 && peer.stack.some(card => card.name === burn)
        && peer.stack.some(card => card.sourceId === targetId)) {
        return decision.choices.find(choice => choice.card?.name === removal)
      }
      return oneLand(peer, 'Swamp')
    }
    if (peer.step === 'CLEANUP') return decision.choices.find(choice => choice.card?.name === 'Swamp')
  })
  try {
    let state = await startFixture('Isolated observed response', deck('Red prowess',
      [['Mountain', 52], [swift, 4], [burn, 4]]), 77, deck('Black removal', [['Swamp', 56], [removal, 4]]), 'Pioneer', 1)
    const swiftInPlay = view => ownPlayer(view).battlefield.find(card => card.name === swift)
    state = await setup(fixture, state, { basic: 'Mountain', landLimit: 1,
      choose: view => ownMain(view, ownPlayer) && !swiftInPlay(view)
        ? view.decision.choices.find(choice => choice.card?.name === swift) : undefined,
      ready: view => responseReady && ownMain(view, ownPlayer) && !view.stack.length && swiftInPlay(view)
        && view.ownHand.some(card => card.name === burn) && view.ownHand.filter(card => card.name === 'Mountain').length >= 2
        && oneLand(view, 'Mountain'),
    })
    await answer(state, oneLand(state, 'Mountain'))
    state = await waitNextOwn(state.decision.id)
    const extra = state.ownHand.find(card => card.name === 'Mountain')
    assert.ok(extra && !oneLand(state, 'Mountain'), 'The second Mountain remains in hand after the land drop')
    const unavailable = await runLine(fixture, state, [{ ...actionForCard(extra), playAs: 'land' }, endStep])
    assert.equal(unavailable.reason, 'land_play_unavailable')
    assert.equal(unavailable.appliedDecisions, 0)
    state = unavailable.state
    const badPass = await runLine(fixture, state, [{ kind: 'pass_priority' }, endStep])
    assert.equal(badPass.code, 'bad_sequence')
    assert.equal(badPass.appliedDecisions, 0)
    const creature = swiftInPlay(state)
    targetId = creature.id
    const spell = state.ownHand.find(card => card.name === burn)
    const source = ownPlayer(state).battlefield.find(card => card.name === 'Mountain' && !card.tapped)
    const rival = rivalPlayer(state)
    const cast = await runLine(fixture, state, [
      { ...actionForCard(spell), expectTriggers: [{ sourceId: creature.id, abilityText: creature.rules.find(rule => /^Prowess\b/i.test(rule)) }] },
      { kind: 'choose', guard: { kind: 'question', sourceObjectId: spell.id, instruction: 'Pay Kicker {4} ?' }, select: { answer: false } },
      { kind: 'choose', guard: { kind: 'target', targetRole: 0, targetSourceId: spell.id }, select: { objectId: rival.id } },
      { kind: 'choose', guard: { kind: 'payMana' }, select: { objectId: source.id, zone: 'battlefield' } },
      endStep,
    ])
    // XMage may publish the changed hand or mana source before its spell-cast event.
    assert.equal(cast.status, 'interrupted')
    assert.ok(['opponent_action', 'opponent_state_changed'].includes(cast.reason), cast.reason)
    assert.ok(cast.appliedDecisions >= 4, 'The pilot announced Burst, declined kicker, targeted and paid')
    state = await waitNextOwn()
    assert.equal(state.stack.length, 3, 'Observe the complete announced spell, own trigger and opposing response')
    assert.ok(state.stack.some(card => card.name === removal && card.controllerId === rival.id))
    assert.ok(state.stack.some(card => card.name === burn && card.controllerId === ownPlayer(state).id))
    assert.ok(state.stack.some(card => card.sourceId === creature.id && card.abilityType?.startsWith('TRIGGERED')))
    const adopted = await playLineWithPeer({ gameId: state.gameId, cursor: state.cursor, commandId: randomUUID(),
      expectedStackIds: state.stack.map(card => card.id), actions: [endStep] }, bound(state))
    assert.equal(adopted.status, 'completed', adopted.reason)
    assert.equal(adopted.lastDestination.step, 'END_TURN')
    assert.equal(adopted.state.stack.length, 0)
    assert.equal(rivalPlayer(adopted.state).life, rival.life - 2)
    assert.ok(ownPlayer(adopted.state).graveyard.some(card => card.name === swift))
    assert.ok(adopted.state.sequenceEvidence.publicActions[rival.id] > (unavailable.state.sequenceEvidence.publicActions[rival.id] ?? 0))
    console.log('Real XMage verified the second land, double pass, rival response and three adopted resolutions.')
    await call('concede', { gameId: state.gameId, entireMatch: true })
  } finally {
    setRivalSetup(undefined)
  }
}

async function verifySagaOrder(fixture) {
  const { startFixture, ownPlayer, answer, waitNextOwn, call } = fixture
  const sagas = ['Kumano Faces Kakkazan', "Urza's Saga"]
  let state = await startFixture('Isolated saga chapter order', deck('Chapter order',
    [['Mountain', 52], [sagas[0], 4], [sagas[1], 4]]), 77)
  const board = (view) => ownPlayer(view).battlefield
  const started = (view) => board(view).some(card => card.name === sagas[0])
  state = await setup(fixture, state, { basic: 'Mountain', landLimit: 2,
    ready: (view) => view.decision.triggerOrder && started(view) && board(view).some(card => card.name === sagas[1]),
    choose: (view) => {
      if (!ownMain(view, ownPlayer)) return
      const card = (name) => view.decision.choices.find(item => item.card?.name === name
        && view.ownHand.some(entry => entry.id === item.card.id))
      if (started(view)) {
        if (!board(view).some(item => item.name === sagas[1])) return card(sagas[1])
      } else if (card(sagas[1])?.canPlayLand
        && board(view).some(item => item.name === 'Mountain' && !item.tapped)) return card(sagas[0])
    },
  })
  const kumano = board(state).find(card => card.name === sagas[0])
  const receipt = await runLine(fixture, state, [orderAction(state, kumano.id), endStep])
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt.error))
  assert.equal(receipt.state.stack.length, 0)
  console.log(JSON.stringify({ phase: 'PM-LINE-FLOW-5 real Java', sources: sagas }))
  await call('concede', { gameId: state.gameId, entireMatch: true })
}

// Both parities are represented on the battlefield so picking the wrong legal
// button cannot pass this check. Every setup creature is free or costs one black.
export async function verifyLabeledQuestions(fixture) {
  const { startFixture, ownPlayer, call } = fixture
  const namesByParity = { Even: ['Ornithopter', 'Memnite'], Odd: ['Tormented Soul', 'Diregraf Ghoul'] }
  const deck = { name: 'Isolated labeled parity question', cards: [
    { cardName: 'Swamp', amount: 40 },
    ...['Extinction Event', ...namesByParity.Even, ...namesByParity.Odd].map(cardName => ({ cardName, amount: 4 })),
  ], sideboard: [] }
  for (const label of ['Even', 'Odd']) {
    let state = await startFixture('Isolated Extinction Event ' + label, deck, 77)
    const board = view => ownPlayer(view).battlefield
    const hasParity = (view, names) => board(view).some(card => names.includes(card.name))
    const untapped = view => board(view).filter(card => card.name === 'Swamp' && !card.tapped)
    let castingCreature
    state = await setup(fixture, state, {
      basic: 'Swamp', landLimit: 4,
      ready: view => ownMain(view, ownPlayer) && !view.stack.length && untapped(view).length >= 4
        && view.ownHand.some(card => card.name === 'Extinction Event')
        && Object.values(namesByParity).every(names => hasParity(view, names)),
      choose: view => {
        if (view.decision.kind === 'mulligan' && view.ownHand.length > 5
          && !view.ownHand.some(card => card.name === 'Extinction Event')) {
          return view.decision.choices.find(choice => /^Mulligan\b/.test(choice.label))
        }
        if (view.decision.kind === 'mulliganBottom') {
          // Keep one sweeper, one creature of each parity and as many of the first four lands as possible.
          const hand = view.ownHand
          const bottom = view.decision.choices.filter(choice => choice.card && hand.some(card => card.id === (choice.objectId ?? choice.card.id)))
          const surplus = bottom.find(({ card }) => card.name === 'Extinction Event'
            ? hand.filter(other => other.name === card.name).length > 1
            : Object.values(namesByParity).some(names => names.includes(card.name) && hand.filter(other => names.includes(other.name)).length > 1))
          return surplus ?? bottom.find(({ card }) => card.name === 'Swamp') ?? bottom[0]
        }
        if (view.decision.kind === 'panel' && castingCreature && view.decision.sourceObjectId === castingCreature.objectId) {
          const options = view.decision.choices.filter(choice => choice.abilityType === 'SPELL'
            && choice.spellName === castingCreature.card.name)
          const exact = options.filter(choice => choice.label === 'Cast ' + castingCreature.card.name)
          const legal = exact.length === 1 ? exact : options
          assert.equal(legal.length, 1, 'The fixture creature offers a unique ordinary cast')
          return legal[0]
        }
        if (view.step === 'CLEANUP' && view.decision.kind === 'target') {
          const surplus = view.decision.choices.find(choice => choice.card?.name !== 'Extinction Event'
            && Object.values(namesByParity).some(names => names.includes(choice.card?.name) && hasParity(view, names)))
          if (surplus) return surplus
        }
        if (ownMain(view, ownPlayer) && !view.stack.length) {
          castingCreature = view.decision.choices.find(choice => view.ownHand.some(card => card.id === choice.objectId)
            && Object.values(namesByParity).some(names => names.includes(choice.card?.name) && !hasParity(view, names)))
          return castingCreature
        }
      },
    })
    const source = state.ownHand.find(card => card.name === 'Extinction Event')
    const receipt = await runLine(fixture, state, [
      { ...actionForCard(source), payWith: untapped(state).slice(0, 4).map(card => card.id) },
      { kind: 'choose', guard: { kind: 'question', instruction: 'Odd or even?' }, select: { label } },
    ])
    assert.equal(receipt.status, 'completed', JSON.stringify(receipt.error))
    assert.equal(receipt.state.stack.length, 0)
    const remaining = label === 'Even' ? 'Odd' : 'Even'
    assert.equal(hasParity(receipt.state, namesByParity[label]), false, 'The chosen parity left the battlefield')
    assert.equal(hasParity(receipt.state, namesByParity[remaining]), true, 'The other parity stayed on the battlefield')
    console.log(JSON.stringify({ phase: 'real XMage labeled question', label, appliedDecisions: receipt.appliedDecisions }))
    await call('concede', { gameId: state.gameId, entireMatch: true })
  }
}

export async function verifyCastingCosts(fixture) {
  for (const accept of [false, true]) await verifyOptionalCost(fixture, {
    cardName: 'Burst Lightning', basic: 'Mountain', mana: 5, instruction: 'Pay Kicker {4} ?', accept, damage: accept ? 4 : 2,
  })
  await verifyOptionalCost(fixture, { cardName: 'Mystic Speculation', basic: 'Island', mana: 3,
    instruction: 'Pay Buyback {2} ?', accept: true })
}

export async function verifyTriggerOrder(fixture) {
  await verifyCastOrder(fixture)
  await verifySagaOrder(fixture)
}
