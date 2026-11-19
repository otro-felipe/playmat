import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createPostMatchReview } from './review.mjs'

function fixture(makeRows, { typed = true, fullAvailable = true } = {}) {
  const gameId = randomUUID()
  const players = ['Alice', 'Bob'].map(name => ({ name, seatId: name.toLowerCase(), playerId: randomUUID() }))
  const [alice, bob] = players
  const game = {
    id: gameId, match_status: 'completed', status: 'completed',
    object_key: 'replay', checksum: 'checksum', review_version: typed ? 2 : null, players,
  }
  const { rows, ...expected } = makeRows({
    alice, bob, frame: (view = {}) => ({ view: { turn: 2, players, ...view } }),
    log: message => ({ log: { messageType: 'GAME', message } }),
  })
  const archive = { reviewGame: async () => game, readReviewArchive: async () => rows }
  const permissions = {
    reviewAccess: async () => ({ viewerSeatId: alice.seatId, perspectives: [{ seatId: alice.seatId, owned: true }], fullAvailable }),
  }
  const review = createPostMatchReview({ query: async () => ({ rows: [] }) }, archive, permissions)
  const read = query => review.evidence({}, gameId, query)
  return { ...expected, alice, bob, read }
}

const asCard = (id, name) => ({ id, name, expansionSetCode: 'FDN', cardNumber: '192' })
const link = (id, name) => `<font color='#FFF' object_id='${id}'>${name}</font> [${id.slice(0, 3)}]`
const analysisList = { purpose: 'analysis', scope: 'public', includeBefore: 'false' }

test('[PM-REVIEW-CAPTURE-2] typed spell exposes recorded choices and jumps to a witnessed stack position', async () => {
  const source = randomUUID()
  const spell = randomUUID()
  const creature = randomUUID()
  const unseen = randomUUID()
  const concealed = randomUUID()
  const { read, bob } = fixture(({ alice, bob, frame, log }) => ({
    rows: [
      { ...frame({ players: [alice, { ...bob, battlefield: {
        [creature]: asCard(creature, 'Monastery Swiftspear'),
        [concealed]: { id: concealed, hideInfo: true, sourceCard: asCard(concealed, 'Concealed sentinel') },
      } }] }),
        hands: { Bob: { [unseen]: asCard(unseen, 'Private sentinel') } } },
      { kind: 'action', action: 'cast', turn: 2, actorPlayerId: alice.playerId, objectId: spell, sourceId: source,
        card: { id: source, name: 'Fiery Confluence', setCode: 'C15', cardNumber: '26' },
        targetIds: [creature, bob.playerId, unseen, concealed], modes: ['Choose a mode'], paidMana: { R: 2 }, fromZone: 'HAND',
        castMode: 'Flashback' },
      log(`Alice casts ${link(source, 'Fiery Confluence')} targeting ${link(creature, 'Monastery Swiftspear')} from hand`),
      frame({ stack: { [spell]: { ...asCard(spell, 'Fiery Confluence'), cardId: source, targets: [creature, bob.playerId] } } }),
    ],
  }))

  const page = await read(analysisList)
  assert.equal(page.events.length, 1)
  const [event] = page.events
  assert.equal(event.actor, 'Alice')
  assert.equal(event.frameCursor, 0)
  assert.equal(event.actionFrameCursor, 3)
  assert.equal(event.before, undefined)
  assert.deepEqual(event.actual.cardRef, { id: source, name: 'Fiery Confluence', setCode: 'C15', cardNumber: '26' })
  assert.deepEqual(event.actual.targets, [
    { id: creature, name: 'Monastery Swiftspear', setCode: 'FDN', cardNumber: '192', kind: 'card' },
    { id: bob.playerId, name: 'Bob', kind: 'player' },
  ])
  assert.deepEqual(event.actual.modes, ['Choose a mode'])
  assert.equal(event.actual.castMode, 'Flashback')
  assert.deepEqual(event.actual.paidMana, { R: 2 })
  assert.doesNotMatch(JSON.stringify(page), /Private sentinel|Concealed sentinel/)
  const replay = await read({ purpose: 'replay', scope: 'public' })
  assert.equal(replay.events.find(entry => entry.cursor === 1).actionFrameCursor, 3)
  assert.equal(replay.events.find(entry => entry.cursor === 3).view.stack[spell].name, 'Fiery Confluence')
})

test('[PM-REVIEW-CAPTURE-2] legacy play list recovers linkable spell and target names without using later decisions', async () => {
  const spell = randomUUID()
  const creature = randomUUID()
  const { read } = fixture(({ alice, bob, frame, log }) => ({
    rows: [
      frame({ players: [alice, { ...bob, battlefield: { [creature]: asCard(creature, 'Sheoldred, the Apocalypse') } }] }),
      log(`Alice casts ${link(spell, 'Burst Lightning')} with Kicker targeting ${link(creature, 'Sheoldred, the Apocalypse')} from hand`),
      log('Bob decides to take mulligan'),
      log('Bob mulligans down to 6 cards'),
      frame({ stack: { [spell]: asCard(spell, 'Burst Lightning') } }),
      log(`Bob activates: Deal 1 damage from ${link(creature, 'Sheoldred, the Apocalypse')}`),
    ],
  }), { typed: false, fullAvailable: false })

  const { events } = await read(analysisList)
  assert.deepEqual(events.map(({ actual }) => actual.kind), ['cast', 'mulligan', 'activate'])
  assert.equal(events[1].cursor, 3, 'the committed legacy mulligan keeps its existing cursor')
  assert.equal(events[0].actual.cardRef.name, 'Burst Lightning')
  assert.equal(events[0].actual.targets[0].name, 'Sheoldred, the Apocalypse')
  assert.equal(events[0].actionFrameCursor, undefined)
  assert.equal(events[0].actual.fromZone, 'HAND')
  assert.equal(events[0].actual.castMode, 'Kicker')
  assert.equal(events[2].actual.cardRef.name, 'Sheoldred, the Apocalypse')
  assert.deepEqual(events[2].actual.modes, ['Deal 1 damage'])
})

test('[PM-REVIEW-CAPTURE-2] legacy nonmodal activations show the logged effect and linked source', async () => {
  const talent = randomUUID()
  const den = randomUUID()
  const { read } = fixture(({ frame, log }) => ({
    rows: [
      frame(),
      log(`Alice activates: level up to 2. from Stormchaser's Talent [${talent.slice(0, 3)}]`),
      log(`Bob activates: Become a 3/2 Goblin creature until end of turn from ${link(den, 'Den of the Bugbear')}`),
    ],
  }), { typed: false })
  const { events: [levelUp, animate] } = await read(analysisList)
  assert.equal(levelUp.actual.cardRef.name, "Stormchaser's Talent")
  assert.deepEqual(levelUp.actual.modes, ['level up to 2.'])
  assert.equal(animate.actual.cardRef.name, 'Den of the Bugbear')
  assert.deepEqual(animate.actual.modes, ['Become a 3/2 Goblin creature until end of turn'])
})

test('[PM-REVIEW-CAPTURE-2] legacy text-only engine logs recover card and target names from the visible board', async () => {
  const creature = randomUUID()
  const spell = randomUUID()
  const { read } = fixture(({ alice, bob, frame, log }) => ({
    rows: [
      frame({ players: [alice, { ...bob, battlefield: { [creature]: asCard(creature, 'Sheoldred, the Apocalypse') } }] }),
      log(`Alice casts Burst Lightning [${spell.slice(0, 3)}] targeting Sheoldred, the Apocalypse [${creature.slice(0, 3)}] from hand`),
      frame({ stack: { [spell]: asCard(spell, 'Burst Lightning') } }),
    ],
  }), { typed: false, fullAvailable: false })

  const [event] = (await read(analysisList)).events
  assert.equal(event.actual.cardRef.name, 'Burst Lightning')
  assert.equal(event.actual.cardRef.id, spell)
  assert.equal(event.actual.targets[0].id, creature)
  assert.equal(event.actionFrameCursor, 2)
})

test('[PM-REVIEW-CAPTURE-2] legacy notes name a logged target even if its stack frame did not survive', async () => {
  const [event] = (await fixture(({ frame, log }) => ({
    rows: [frame(), log('Alice casts Negate [35a] targeting Sheoldred, the Apocalypse [b4d] from hand'), frame()],
  }), { typed: false }).read(analysisList)).events
  assert.deepEqual(event.actual.targets, [{ name: 'Sheoldred, the Apocalypse', kind: 'card' }])
  assert.equal(event.actionFrameCursor, undefined)
})

test('[PM-REVIEW-CAPTURE-2] a forced discard links the discarded card and its cause separately', async () => {
  const spell = randomUUID()
  const discarded = randomUUID()
  const { alice, read } = fixture(({ alice, frame, log }) => ({
    rows: [frame({ stack: { [spell]: { ...asCard(spell, 'Thoughtseize'), controllerId: alice.playerId } } }),
      log(`Bob discards ${link(discarded, 'Go for the Throat')} (source: ${link(spell, 'Thoughtseize')})`)],
  }), { typed: false })
  const [event] = (await read({ purpose: 'analysis', seatId: alice.seatId })).events
  assert.equal(event.seatId, 'bob', 'keep the archived annotation key')
  assert.equal(event.decisionSeatId, 'alice')
  assert.equal(event.decisionActor, 'Alice')
  assert.equal(event.actual.cardRef.name, 'Go for the Throat')
  assert.deepEqual(event.actual.sourceCardRef, { id: spell, name: 'Thoughtseize', setCode: 'FDN', cardNumber: '192' })
})

test('[PM-REVIEW-CAPTURE-3] mulligan opening hand only appears in the acting seat or finished full replay', async () => {
  const card = { id: randomUUID(), name: 'Private mulligan hand', setCode: 'FDN', cardNumber: '192' }
  const { read } = fixture(({ alice, frame, log }) => ({
    rows: [frame(),
      { kind: 'action', action: 'mulligan', actorPlayerId: alice.playerId, preActionCursor: 0, decision: { cards: [card] } },
      log('Alice mulligans down to 6 cards'),
      frame(),
    ],
  }))
  assert.doesNotMatch(JSON.stringify(await read(analysisList)), /Private mulligan hand/)
  assert.doesNotMatch(JSON.stringify(await read({ purpose: 'replay', seatId: 'bob' })), /Private mulligan hand/)
  for (const query of [{ purpose: 'replay', scope: 'full' }, { purpose: 'analysis', seatId: 'alice' }]) {
    const { events } = await read(query)
    assert.deepEqual(events.filter(event => event.type === 'action').map(event => event.decision), [{ cards: [card], handKind: 'opening_choice' }])
  }
})

test('[PM-REVIEW-CAPTURE-3] legacy kept-hand evidence uses the first upkeep only before recorded hand changes', async () => {
  const id = randomUUID()
  for (const laterDraw of [false, true]) {
    const { read } = fixture(({ frame, log }) => ({
      rows: [frame({ turn: 0 }), log('Alice keeps hand'), log('Bob mulligans down to 6 cards'),
        ...(laterDraw ? [log('Alice draws a card')] : []),
        { ...frame({ turn: 1, step: 'UPKEEP' }), hands: { Alice: { [id]: asCard(id, 'Private kept card') } } }],
    }), { typed: false })
    const { events } = await read({ purpose: 'analysis', seatId: 'alice' })
    assert.equal(events[0].decision?.handKind, laterDraw ? undefined : 'kept_hand')
    assert.equal(events[0].decision?.cards[0].id, laterDraw ? undefined : id)
    assert.doesNotMatch(JSON.stringify(await read(analysisList)), /Private kept card/)
  }
})

test('[PM-REVIEW-CAPTURE-4] only recorded material passes are review candidates and their options are private', async () => {
  const card = { id: randomUUID(), name: 'Private priority option' }
  const { read } = fixture(({ alice, frame }) => ({
    rows: [frame(),
      { kind: 'action', action: 'pass', actorPlayerId: alice.playerId, decision: { playableCount: 0, passKind: 'automatic' } },
      { kind: 'action', action: 'pass', actorPlayerId: alice.playerId, decision: { playableCount: 1, passKind: 'manual', cards: [card] } },
      { kind: 'action', action: 'pass', actorPlayerId: alice.playerId, decision: { playableCount: 0, endsTurn: true, availableManaSources: 1 } }],
  }))
  const publicPage = await read(analysisList)
  assert.deepEqual(publicPage.events.map(event => event.cursor), [2, 3])
  assert.doesNotMatch(JSON.stringify(publicPage), /Private priority option/)
  const acting = await read({ purpose: 'analysis', seatId: 'alice' })
  assert.deepEqual(acting.events[0].decision, { cards: [card], playableCount: 1, passKind: 'manual' })
})

test('[PM-REVIEW-CAPTURE-4] a committed typed discard choice supersedes the single matching victim log', async () => {
  const card = { id: randomUUID(), name: 'Selected secret' }
  const source = randomUUID()
  const { read } = fixture(({ alice, bob, frame, log }) => ({
    rows: [frame(),
      { kind: 'action', action: 'select', actorPlayerId: alice.playerId, decisionPlayerId: alice.playerId,
        affectedPlayerId: bob.playerId, sourceId: source, objectId: card.id,
        decision: { choiceKind: 'discard', selectedIds: [card.id], cards: [card] } },
      frame(), log(`Bob discards ${link(card.id, card.name)} (source: ${link(source, 'Thoughtseize')})`)],
  }))
  const publicPage = await read(analysisList)
  assert.deepEqual(publicPage.events.map(event => event.cursor), [1])
  assert.equal(publicPage.events[0].decisionActor, 'Alice')
  assert.equal(publicPage.events[0].affectedActor, 'Bob')
  assert.equal(publicPage.events[0].actual.objectId, undefined)
  assert.doesNotMatch(JSON.stringify(publicPage), /Selected secret/)
  const acting = await read({ purpose: 'analysis', seatId: 'alice' })
  assert.deepEqual(acting.events[0].decision.selectedIds, [card.id])
})
