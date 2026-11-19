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
  const review = createPostMatchReview(null, archive, permissions)
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
      frame({ stack: { [spell]: asCard(spell, 'Burst Lightning') } }),
      log(`Bob activates: Deal 1 damage from ${link(creature, 'Sheoldred, the Apocalypse')}`),
    ],
  }), { typed: false, fullAvailable: false })

  const { events } = await read(analysisList)
  assert.deepEqual(events.map(({ actual }) => actual.kind), ['cast', 'mulligan', 'activate'])
  assert.equal(events[0].actual.cardRef.name, 'Burst Lightning')
  assert.equal(events[0].actual.targets[0].name, 'Sheoldred, the Apocalypse')
  assert.equal(events[0].actionFrameCursor, undefined)
  assert.equal(events[0].actual.fromZone, 'HAND')
  assert.equal(events[0].actual.castMode, 'Kicker')
  assert.equal(events[2].actual.cardRef.name, 'Sheoldred, the Apocalypse')
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
  const [event] = (await fixture(({ frame, log }) => ({
    rows: [frame({ stack: { [spell]: asCard(spell, 'Thoughtseize') } }),
      log(`Bob discards ${link(discarded, 'Go for the Throat')} (source: ${link(spell, 'Thoughtseize')})`)],
  }), { typed: false }).read(analysisList)).events
  assert.equal(event.actual.cardRef.name, 'Go for the Throat')
  assert.deepEqual(event.actual.sourceCardRef, { id: spell, name: 'Thoughtseize', setCode: 'FDN', cardNumber: '192' })
})
