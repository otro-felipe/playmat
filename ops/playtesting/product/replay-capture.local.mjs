import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { gunzipSync } from 'node:zlib'

// This runner receives its seats from sequence.local.mjs, which permits only
// the co-located synthetic database, account and bridge.
const spool = '/opt/xmage/saved/replays'
const deck = { name: 'Isolated replay capture fixture', cards: [
  { cardName: 'Mountain', amount: 52 }, { cardName: 'Lightning Bolt', amount: 4 }, { cardName: 'Shock', amount: 4 },
], sideboard: [] }
const byObject = (choice, id) => (choice.objectId ?? choice.card?.id) === id

function fallback(state) {
  return state.decision.choices.find(({ label }) => /^Keep\b|^Play first\b/.test(label))
    ?? state.decision.choices.find(({ type }) => type === 'pass')
    ?? state.decision.choices.find(({ card }) => state.step === 'CLEANUP' && card?.name === 'Mountain'
      && state.ownHand.some(own => own.id === card.id))
}

async function archived(gameId, deadline, whileWaiting) {
  assert.match(gameId, /^[a-f\d-]{36}$/i)
  while (Date.now() < deadline) {
    try {
      const info = JSON.parse(await readFile(join(spool, gameId + '.json'), 'utf8'))
      const bytes = await readFile(join(spool, gameId + '.ndjson.gz'))
      return { info, rows: gunzipSync(bytes).toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await whileWaiting?.()
      await sleep(50)
    }
  }
  assert.fail('Isolated replay capture did not finish writing')
}

function requireIsolatedFixture() {
  if (process.env.PLAYMAT_SEQUENCE_LOCAL_TEST !== 'yes'
    || !process.env.DATABASE_URL?.includes('@playmat-sequence-pg:5432/sequence_fixture')) {
    throw Error('Replay capture fixture requires an isolated engine and synthetic data')
  }
}

export async function verifyReplayCapture({ startFixture, call, ownPlayer, rivalPlayer, answer, waitNextOwn, acknowledgeReview, totalDeadline }) {
  requireIsolatedFixture()
  let state = await startFixture('Isolated actual draws and seat visibility', deck, 77, acknowledgeReview)
  const move = async choice => {
    assert.ok(choice, 'The fixture uses only a current legal engine choice')
    const previous = state.decision.id
    await answer(state, choice)
    state = await waitNextOwn(previous)
    assert.equal(Object.hasOwn(state, 'review'), false, 'Live MCP state carries no replay-only overlay')
  }
  let cast, land
  while (Date.now() < totalDeadline) {
    const player = ownPlayer(state)
    const main = state.step === 'PRECOMBAT_MAIN' && state.activePlayerId === player.id && state.decision.kind === 'priority'
    const untappedLand = player.battlefield.find(card => card.name === 'Mountain' && !card.tapped)
    if (main && untappedLand) {
      cast = state.ownHand.find(card => /^(Lightning Bolt|Shock)$/.test(card.name)
        && state.decision.choices.some(choice => byObject(choice, card.id)))
      if (cast) { land = untappedLand; break }
    }
    const playLand = main && state.decision.choices.find(choice => choice.canPlayLand && choice.card?.name === 'Mountain'
      && state.ownHand.some(card => card.id === choice.card.id))
    await move(playLand || fallback(state))
  }
  assert.ok(cast && land, 'A seeded game draws a real instant and offers a red source')
  const playerId = ownPlayer(state).id
  const rivalId = rivalPlayer(state).id
  await move(state.decision.choices.find(choice => byObject(choice, cast.id)))
  assert.equal(state.decision.kind, 'target')
  await move(state.decision.choices.find(choice => byObject(choice, rivalId)))
  assert.equal(state.decision.kind, 'payMana')
  await move(state.decision.choices.find(choice => byObject(choice, land.id)))
  assert.equal(state.stack[0]?.name, cast.name)
  const spellId = state.stack[0].id
  await call('concede', { gameId: state.gameId, entireMatch: true })
  const { info, rows } = await archived(state.gameId, Math.min(totalDeadline, Date.now() + 10_000))

  assert.equal(info.reviewVersion, 2, '[PM-REV-02] armed replay has real engine revision metadata')
  assert.deepEqual(new Set(info.players.map(row => row.playerId)), new Set([playerId, rivalId]))
  const draws = rows.filter(row => row.kind === 'draw')
  assert.ok(draws.filter(row => row.actorPlayerId === playerId).length >= 7, 'Real opening draws were recorded')
  assert.ok(draws.filter(row => row.actorPlayerId === rivalId).length >= 7, 'Both synthetic seats recorded opening draws')
  const castCursor = rows.findIndex(row => row.kind === 'action' && row.action === 'cast' && row.objectId === spellId)
  assert.ok(castCursor >= 0, 'Committed spell is anchored to an actual event')
  const castEvent = rows[castCursor]
  assert.equal(castEvent.actorPlayerId, playerId)
  assert.equal(castEvent.fromZone, 'HAND')
  assert.deepEqual(castEvent.targetIds, [rivalId])
  assert.deepEqual(castEvent.paidMana, { R: 1 })
  const firstDraw = rows.findIndex(row => row.kind === 'draw' && row.actorPlayerId === playerId && row.card?.id === cast.id)
  assert.ok(firstDraw >= 0 && firstDraw < castCursor, 'Playing an already drawn card has its own event')
  assert.ok(rows.some(row => row.view && row.review?.seatViews?.[playerId]?.myHand?.[cast.id]
    && Object.hasOwn(row.review.seatViews[rivalId] ?? {}, 'myHand')), 'An archived frame has both seat views')
  for (const row of rows.filter(row => row.view)) {
    for (const view of [row.view, ...Object.values(row.review?.seatViews ?? {})]) {
      assert.ok((view.players ?? []).every(player => !Object.hasOwn(player, 'sideboard') && !Object.hasOwn(player, 'userData')),
        'Review frames omit unnecessary private fields, even for the seat authorized to view its hand')
    }
  }
  assert.ok(rows.some(row => row.kind === 'action' && row.action === 'land' && row.objectId === land.id))
  console.log(JSON.stringify({ phase: '[PM-REV-02] real Java protected capture', draws: draws.length, actualCast: true, bothSeats: true }))
  const rivalDrawCursor = rows.findIndex(row => row.kind === 'draw' && row.actorPlayerId === rivalId && row.card)
  assert.ok(rivalDrawCursor >= 0)
  return { gameId: state.gameId, matchId: info.matchId, castCursor, cardName: cast.name, playerId, rivalId, rivalDrawCursor }
}

export async function verifyHumanReplayCapture({ startHumanReviewFixture, totalDeadline }) {
  requireIsolatedFixture()
  const captures = []
  for (const armed of [true, false]) {
    await startHumanReviewFixture(armed, async (seats) => {
      let activeId
      while (Date.now() < totalDeadline) {
        const observations = seats.map(seat => seat.snapshot())
        const [first, second] = observations
        if (observations.every(state => state.status === 'active' && state.step && state.turn >= 1
          && state.ownHand.length > 0) && first.gameId === second.gameId) {
          activeId = first.gameId
          break
        }
        for (const [index, state] of observations.entries()) {
          if (state.status !== 'active' || !state.decision || state.decision.kind === 'waiting') continue
          const choice = fallback(state)
          assert.ok(choice, 'Human fixture replies to observed opening prompts only')
          try {
            await seats[index].respond(state.decision.id, choice.id)
          } catch (error) {
            if (!['stale_decision', 'engine_rejected'].includes(error.code)) throw error
          }
        }
        await sleep(20)
      }
      assert.ok(activeId, 'Both authenticated browser peers reach the same started game')
      await seats[0].concede(activeId, true)
      // The concession RPC acknowledges scheduling. Settle any still-visible
      // ordinary prompt on the other fixture seat until the terminal frame arrives.
      const { info, rows } = await archived(activeId, Math.min(totalDeadline, Date.now() + 30_000), async () => {
        const state = seats[1].snapshot()
        if (state.status !== 'active' || state.gameId !== activeId || !state.decision || state.decision.kind === 'waiting') return
        const choice = fallback(state)
        if (!choice) return
        try {
          await seats[1].respond(state.decision.id, choice.id)
        } catch (error) {
          if (!['stale_decision', 'engine_rejected', 'game_not_active'].includes(error.code)) throw error
        }
      })
      assert.match(info.deckType, /Pioneer/)
      assert.equal(info.players.length, 2)
      assert.ok(info.players.every(seat => seat.human))
      assert.equal(info.reviewVersion ?? null, armed ? 2 : null)
      assert.equal(rows.some(row => row.kind === 'draw'), armed)
      assert.equal(rows.some(row => Object.keys(row.review?.seatViews ?? {}).length === 2), armed)
      assert.ok(rows.some(row => Object.keys(row.hands ?? {}).length === 2), 'Normal replay capture remains available')
      captures.push({ gameId: activeId, matchId: info.matchId, armed })
      console.log(JSON.stringify({ phase: '[PM-REV-02] real Java Pioneer human table', bothAccountsAcknowledged: armed, protectedCapture: armed }))
    })
  }
  return captures
}
