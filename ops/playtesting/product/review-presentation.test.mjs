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

test('[PM-REVIEW-CAPTURE-5] generic choices retain opaque options and selections in authorized views only', async () => {
  const source = randomUUID()
  const target = randomUUID()
  const option = { id: 'option-0', label: 'Private option description', card: { id: target, name: 'Private option card' } }
  const { read, alice, bob } = fixture(({ alice, bob, frame }) => ({
    rows: [frame(),
      { kind: 'action', action: 'select', actorPlayerId: bob.playerId, decisionPlayerId: alice.playerId, affectedPlayerId: bob.playerId,
        sourceId: source, decision: { choiceKind: 'search', prompt: 'Choose one', optionDetails: [option], selectedOptionIds: ['option-0'],
          selectedText: 'Private chosen name', optionCount: 1, declined: false, arbitraryHiddenKey: 'unprojected sentinel' } }],
  }))
  const own = (await read({ purpose: 'analysis', seatId: 'alice' })).events[0]
  const complete = (await read({ purpose: 'replay', scope: 'full' })).events.find(event => event.type === 'action')
  const publicEvent = (await read(analysisList)).events[0]
  const affected = (await read({ purpose: 'replay', scope: 'seat', seatId: 'bob' })).events.find(event => event.type === 'action')
  assert.equal(own.decisionActorPlayerId, alice.playerId)
  assert.equal(own.affectedPlayerId, bob.playerId)
  assert.equal(own.decision.choiceKind, 'search')
  assert.equal(own.decision.sourceId, source)
  assert.equal(own.decision.id, complete.decision.id)
  assert.deepEqual(own.decision.optionDetails, [option])
  assert.deepEqual(own.decision.selectedOptionIds, ['option-0'])
  assert.equal(own.decision.selectedText, 'Private chosen name')
  assert.equal(own.decision.declined, false)
  assert.equal(own.decision.optionCount, 1)
  assert.equal(publicEvent.hasDecisionContext, true)
  for (const event of [publicEvent, affected]) {
    assert.equal(event.decision, undefined)
    assert.equal(event.decisions, undefined)
    assert.doesNotMatch(JSON.stringify(event), /Private|unprojected sentinel/)
    assert.equal(JSON.stringify(event).includes(source), false)
  }
  assert.doesNotMatch(JSON.stringify(own), /unprojected sentinel/)
})

test('[PM-REVIEW-CAPTURE-5] an archived public stack source enriches a resolution choice before the answer', async () => {
  const spell = randomUUID()
  const source = randomUUID()
  const { read } = fixture(({ alice, frame }) => ({
    rows: [
      frame({ stack: { [spell]: { ...asCard(spell, 'Source spell'), cardId: source } } }),
      { kind: 'action', action: 'select', actorPlayerId: alice.playerId, sourceId: source, preActionCursor: 0,
        decision: { choiceKind: 'use', options: ['Yes', 'No'], selectedText: 'No' } },
    ],
  }))
  const { events } = await read({ purpose: 'analysis', seatId: 'alice' })
  assert.deepEqual(events[0].decision.sourceCard, { id: source, name: 'Source spell', setCode: 'FDN', cardNumber: '192' })
  assert.equal(events[0].actual.sourceId, undefined)
})

test('[PM-REVIEW-CAPTURE-5] announcement choices attach to the exact committed action and cancelled attempts stay out', async () => {
  const cast = randomUUID()
  const cancelled = randomUUID()
  const { read } = fixture(({ alice, frame }) => {
    const decision = (choiceKind, parentActionId, label) => ({ kind: 'action', action: 'select',
      actorPlayerId: alice.playerId, decisionPlayerId: alice.playerId, ...(parentActionId ? { parentActionId } : {}),
      decision: { choiceKind, optionDetails: [{ id: 'option-0', label }],
        selectedOptionIds: choiceKind === 'mode' ? ['option-0', 'option-0', 'option-0'] : ['option-0'] } })
    return { rows: [
      frame(),
      decision('mode', cast, 'Choose mode one'),
      decision('target', cast, 'Target a permanent'),
      decision('mode', cancelled, 'Cancelled attempt sentinel'),
      { kind: 'action', action: 'cast', actorPlayerId: alice.playerId, objectId: cast, card: { id: randomUUID(), name: 'Modal spell' } },
      frame(),
      decision('use', undefined, 'Resolution decision'),
    ] }
  })
  const { events } = await read({ purpose: 'analysis', seatId: 'alice' })
  assert.deepEqual(events.map(({ cursor }) => cursor), [4, 6])
  assert.deepEqual(events[0].decisions.map(({ choiceKind }) => choiceKind), ['mode', 'target'])
  assert.deepEqual(events[0].decisions[0].selectedOptionIds, ['option-0', 'option-0', 'option-0'])
  assert.equal(new Set(events[0].decisions.map(({ id }) => id)).size, 2)
  assert.equal(events[1].decision.choiceKind, 'use')
  assert.doesNotMatch(JSON.stringify(events), /Cancelled attempt sentinel/)
  const publicPage = await read(analysisList)
  assert.equal(publicPage.events[0].hasDecisionContext, true)
  assert.equal(publicPage.events[0].decisions, undefined)
})


test('[PM-LINE-REPLAY-1] a frame groups both agents’ explanations according to the authorized perspective', async () => {
  const { read, alice, bob } = fixture(({ alice, bob, frame }) => ({
    rows: [frame(),
      { kind: 'line', commandId: 'a', actorPlayerId: alice.playerId, reasoning: 'Hold removal.' },
      { kind: 'line', commandId: 'a', actorPlayerId: bob.playerId, reasoning: 'Attack before casting.' }, frame(), frame({ turn: 3 })],
  }))
  const notes = async query => (await read({ ...query, purpose: 'replay' })).events[0].lines
  const own = { commandId: 'a', actor: alice.name, seatId: alice.seatId, cursor: 1, reasoning: 'Hold removal.' }
  const rival = { commandId: 'a', actor: bob.name, seatId: bob.seatId, cursor: 2, reasoning: 'Attack before casting.' }
  assert.deepEqual(await notes({ scope: 'seat' }), [own])
  assert.deepEqual(await notes({ scope: 'full' }), [own, rival])
  assert.equal(await notes({ scope: 'public' }), undefined)
  const frames = (await read({ scope: 'full', purpose: 'replay' })).events
  assert.deepEqual(frames[1].lines, [own, rival], 'the follow-up board still shows the last explained line')
  assert.equal(frames[2].lines, undefined, 'an unexplained later turn does not inherit an earlier plan')
})

test('[PM-LINE-PUBLIC] explicit spectator lines survive archival and never publish legacy notes or table talk', async () => {
  const explanation='A'.repeat(4000)
  const {read}=fixture(({alice,bob,frame})=>{
    const entry={kind:'line',actorPlayerId:alice.playerId,commandId:'same',audience:'public',explanation}
    return {rows:[frame(),{kind:'line',actorPlayerId:alice.playerId,commandId:'old',reasoning:'old private note'},
      entry,{...entry},{...entry,actorPlayerId:bob.playerId,explanation:'Block.'},
      {...entry,commandId:'unsigned',audience:undefined},{...entry,commandId:'too-long',explanation:explanation+'!'},
      {kind:'spectatorTalk',chat:{message:'ordinary chat'}},frame(),frame({turn:3})]}
  })
  for(const scope of ['public','seat','full']) {
    const frames=(await read({scope,purpose:'replay'})).events.filter(row=>row.type==='frame')
    assert.deepEqual(frames[0].lines.filter(row=>row.audience==='public').map(row=>row.explanation),[explanation,'Block.'])
    assert.deepEqual(frames[1].lines,frames[0].lines)
    assert.equal(frames[2].lines,undefined)
    assert.equal(JSON.stringify(frames).includes('old private note'),scope!=='public')
    assert.ok(!JSON.stringify(frames).includes('ordinary chat'))
  }
})
