// The opt-in sequence runner provides the isolated XMage bridge and both synthetic seats.
import assert from 'node:assert/strict'
import { setup } from './casting-and-order.local.mjs'

const nullSummoner = 'Null Summoner'
const extrapolate = 'Extrapolate the Impossible'
const sideboardNames = ['Duress', 'Negate', 'Fatal Push']
const rivalDeck = {
  name: 'Isolated opponent reveal fixture',
  cards: [
    { cardName: 'Mountain', amount: 32 },
    ...['Shock', 'Play with Fire', 'Burst Lightning', 'Rending Volley', 'Lava Coil', 'Abrade',
      'Scorching Dragonfire'].map(cardName => ({ cardName, amount: 4 })),
  ],
  sideboard: [],
}
const cardChoice = (state, name) => state.decision.choices.find(choice => choice.card?.name === name)
const objectChoice = (state, id) => state.decision.choices.find(choice => (choice.objectId ?? choice.card?.id) === id)
const pickNames = state => state.decision.choices.flatMap(choice => choice.card ? [choice.card.name] : []).sort()

async function exercise(fixture, spellName) {
  const { startFixture, ownPlayer, rivalPlayer, answer, waitNextOwn, gameClock, call, setRivalSetup } = fixture
  const summoner = spellName === nullSummoner
  const playerDeck = {
    name: 'Isolated FRA cross-seat choices',
    cards: [
      { cardName: spellName, setCode: 'FRA', cardNumber: summoner ? '142' : '55', amount: 4 },
      { cardName: 'Swamp', amount: summoner ? 28 : 56 },
      ...(summoner ? [{ cardName: 'Island', amount: 28 }] : []),
    ],
    sideboard: summoner ? [] : sideboardNames.map(cardName => ({ cardName, amount: 1 })),
  }

  let rivalChose = false
  if (!summoner) {
    setRivalSetup(view => {
      if (view.decision.kind !== 'pickCards') return undefined
      assert.deepEqual(pickNames(view), ['Duress', 'Negate'], 'The opponent sees exactly the two revealed cards')
      rivalChose = true
      return cardChoice(view, 'Negate')
    })
  }

  let state = await startFixture('Isolated ' + spellName, playerDeck, 77, rivalDeck, 'Pioneer', 1)
  const untapped = view => ownPlayer(view).battlefield.filter(card => card.types.includes('LAND') && !card.tapped)
  const ownMain = view => view.step === 'PRECOMBAT_MAIN' && view.activePlayerId === ownPlayer(view).id
    && view.decision.kind === 'priority' && !view.stack.length
  const castChoice = view => view.decision.choices.find(choice => choice.card?.name === spellName
    && view.ownHand.some(card => card.id === (choice.objectId ?? choice.card?.id)))
  const move = async choice => {
    assert.ok(choice, 'Expected offered action for ' + spellName + ' at ' + state.decision.kind)
    const previous = state.decision.id
    await answer(state, choice)
    state = await waitNextOwn(previous)
  }

  try {
    state = await setup(fixture, state, {
      basic: 'Swamp',
      landLimit: summoner ? 4 : 2,
      ready: view => ownMain(view) && castChoice(view),
      choose: view => {
        if (!summoner || !ownMain(view)) return undefined
        const lands = untapped(view)
        if (!lands.some(card => card.name === 'Island')) {
          return view.decision.choices.find(choice => choice.canPlayLand && choice.card?.name === 'Island')
        }
        if (lands.length < 4) return view.decision.choices.find(choice => choice.canPlayLand)
      },
    })
    await move(castChoice(state))
    let paidBlue = false
    while (gameClock.hasTime() && ['payMana', 'priority', 'target'].includes(state.decision.kind)) {
      if (state.decision.kind === 'payMana') {
        const blue = summoner && !paidBlue && cardChoice(state, 'Island')
        if (blue) paidBlue = true
        await move(blue || cardChoice(state, 'Swamp') || cardChoice(state, 'Island'))
      } else if (state.decision.kind === 'target') {
        assert.ok(summoner, 'Only Null Summoner targets the opponent')
        await move(objectChoice(state, rivalPlayer(state).id))
      } else {
        assert.ok(state.stack.length > 0, 'The resolving spell or trigger is waiting for priority')
        await move(state.decision.choices.find(choice => choice.type === 'pass'))
      }
    }

    if (summoner) {
      assert.equal(state.decision.kind, 'pickCards')
      const candidates = state.decision.choices.filter(choice => choice.card)
      assert.ok(candidates.length >= 2, 'The pilot receives multiple nonland options from the opponent’s hand')
      assert.ok(candidates.every(choice => choice.card.name !== 'Mountain'
        && !state.ownHand.some(card => card.id === choice.card.id)))
      const chosen = candidates[0]
      await move(chosen)
      assert.ok(rivalPlayer(state).exile.some(card => card.name === chosen.card.name && card.id === chosen.card.id))
    } else {
      assert.equal(state.decision.kind, 'question')
      await move(state.decision.choices.find(choice => /^Yes$/i.test(choice.label)))
      assert.equal(state.decision.kind, 'pickCards')
      assert.deepEqual(pickNames(state), ['Duress', 'Fatal Push', 'Negate'])
      await move(cardChoice(state, 'Duress'))
      assert.equal(state.decision.kind, 'pickCards')
      assert.deepEqual(pickNames(state), ['Fatal Push', 'Negate'])
      await move(cardChoice(state, 'Negate'))
      assert.ok(rivalChose, 'The opponent submitted the choice through their own bridge session')
      assert.ok(state.ownHand.some(card => card.name === 'Negate'))
      assert.ok(!state.ownHand.some(card => card.name === 'Duress' || card.name === 'Fatal Push'))
    }
    console.log('[PM-CATALOG-AC-02] Verified the live cross-seat choices for ' + spellName)
  } finally {
    setRivalSetup(undefined)
    await call('concede', { gameId: state.gameId, entireMatch: true })
  }
}

export async function verifyFraCrossSeat(fixture) {
  await exercise(fixture, nullSummoner)
  await exercise(fixture, extrapolate)
}
