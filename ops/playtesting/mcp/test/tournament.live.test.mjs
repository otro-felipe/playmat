import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import { PlaymatEngineSeat } from '../src/engine-seat.mjs'

async function matchMarker(pairingId) {
  const dir = process.env.PLAYMAT_REPLAY_DIR ?? '/opt/xmage/saved/replays'
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.match.json')) continue
    const item = JSON.parse(await readFile(dir + '/' + file, 'utf8'))
    if (item.tournamentScore?.pairingId === pairingId) return item
  }
}
async function openPair(t) {
  const pairingId = randomUUID()
  const names = ['PilotA', 'PilotB'].map((prefix) => prefix + pairingId.slice(0, 8))
  const seats = names.map(
    (engineName) =>
      new PlaymatEngineSeat({
        engineName,
        accountId: randomUUID(),
        recoverySeatId: 'agent:' + randomUUID(),
        playerId: randomUUID(),
        connectionId: randomUUID(),
        engineUrl: 'ws://127.0.0.1:17172/ws',
        trustedHeader: 'X-Playmat-User',
      }),
  )
  t.after(() => seats.forEach((seat) => seat.close()))
  const request = async (action, args = {}) => {
    const res = await fetch('http://127.0.0.1:17173/internal/tournament/table', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-playmat-internal': 'tournament' },
      body: JSON.stringify({ action, pairingId, ...args }),
    })
    assert.equal(res.status, 200, action)
    return res.json()
  }
  await Promise.all(seats.map((seat) => seat.open()))
  return { pairingId, names, seats, request }
}
// Inside an isolated fixture namespace with no public network; this intentionally ends synthetic games.
test(
  'a Swiss/Worlds assignment seats real profiles and a Worlds playoff starts game two before any sideboard',
  {
    skip: process.env.PLAYMAT_LOCAL_TOURNAMENT_FIXTURE !== '1',
    timeout: 100_000,
  },
  async (t) => {
    const { pairingId, names, seats, request } = await openPair(t)
    async function until(check, description, timeout = 15000) {
      const end = Date.now() + timeout
      while (Date.now() < end) {
        if (await check()) return
        await sleep(50)
      }
      assert.fail('Timed out waiting for ' + description)
    }
    const assignment = { players: names, format: 'Standard', stage: 'playoffs', bestOf: 5, sideboardAfterGame: 2 }
    const { tableId } = await request('prepare', assignment)
    assert.equal((await request('prepare', assignment)).tableId, tableId)
    seats.forEach((seat) => seat.acceptTournamentTable(tableId))
    const deck = { name: 'Tournament fixture', cards: [{ cardName: 'Forest', amount: 60 }], sideboard: [] }
    await request('launch', { tableId, decks: [deck, deck] })
    await until(
      () =>
        seats.every((seat) => seat.snapshot().gameId) &&
        seats.some((seat) => seat.snapshot().decision?.choices?.length),
      'game one',
    )
    const g1 = seats[0].snapshot().gameId
    assert.equal(seats[1].snapshot().gameId, g1)
    await seats[1].concede(g1, false)
    await until(
      () =>
        seats.every((seat) => seat.snapshot().gameId && seat.snapshot().gameId !== g1) &&
        seats.some((seat) => seat.snapshot().decision?.choices?.length),
      'second pre-board game',
    )
    const g2 = seats[1].snapshot().gameId
    await seats[1].concede(g2, false)
    await until(() => seats.every((seat) => seat.snapshot().sideboard), 'first sideboard after game two')
    for (const seat of seats) {
      const { deck: registered, decisionId } = seat.sideboardState()
      await seat.submitSideboard({ deck: registered, decisionId })
    }
    await until(
      () =>
        seats.every((seat) => seat.snapshot().gameId !== g2) &&
        seats.some((seat) => seat.snapshot().decision?.choices?.length),
      'game three',
    )
    await seats[1].concede(seats[1].snapshot().gameId, false)
    await until(() => matchMarker(pairingId), 'completed match marker')
    const marker = await matchMarker(pairingId)
    assert.equal(marker.winner, names[0])
    assert.deepEqual([marker.tournamentScore.winsA, marker.tournamentScore.winsB], [3, 0])
  },
)

const lifegainLands = [
  'Scoured Barrens',
  'Blossoming Sands',
  'Bloodfell Caves',
  'Dismal Backwater',
  'Jungle Hollow',
  'Rugged Highlands',
  'Swiftwater Cliffs',
  'Thornwood Falls',
  'Tranquil Cove',
  'Wind-Scarred Crag',
  'Radiant Fountain',
  'Kabira Crossroads',
  'Sejiri Refuge',
  'Akoum Refuge',
  'Graypelt Refuge',
]
for (const [stage, description] of [
  ['swiss', 'a timed Swiss match plays five additional turns then archives a draw without starting another game'],
  [
    'playoffs',
    'a tied elimination match awards the game and match to the higher life total after five additional turns',
  ],
])
  test(
    description,
    {
      skip: process.env.PLAYMAT_LOCAL_TOURNAMENT_FIXTURE !== '1',
      timeout: 120_000,
    },
    async (t) => {
      const { pairingId, names, seats, request } = await openPair(t)
      const { tableId } = await request('prepare', {
        players: names,
        format: 'Modern',
        stage,
        bestOf: 3,
        deadlineAt: Date.now() + 300000,
      })
      seats.forEach((seat) => seat.acceptTournamentTable(tableId))
      const deck = { name: 'Time fixture', cards: [{ cardName: 'Forest', amount: 60 }], sideboard: [] }
      const firstDeck =
        stage === 'playoffs' ? { ...deck, cards: lifegainLands.map((cardName) => ({ cardName, amount: 4 })) } : deck
      await request('launch', { tableId, decks: [firstDeck, deck] })
      const handled = [new Set(), new Set()]
      let called = null
      let maxTurn = 0
      let matchId
      for (let cycle = 0; cycle < 1400; cycle++) {
        if (cycle % 20 === 0 && (await matchMarker(pairingId))) break
        for (const [index, seat] of seats.entries()) {
          const state = seat.snapshot()
          if (state.gameId && !matchId) matchId = state.gameId
          if (state.gameId) assert.equal(state.gameId, matchId, 'No new games after time is called')
          maxTurn = Math.max(maxTurn, state.turn ?? 0)
          if (called === null && state.turn >= 1 && state.decision?.choices?.length) {
            called = state.turn
            await request('status', { tableId, deadlineAt: Date.now() - 1 })
          }
          const d = state.decision
          if (!d?.choices?.length || handled[index].has(d.id)) continue
          const choice =
            d.choices.find((c) => /^keep\b/i.test(c.label)) ??
            d.choices.find((c) => c.canPlayLand) ??
            d.choices.find((c) => c.type === 'pass' || /^pass\b/i.test(c.label)) ??
            d.choices[0]
          try {
            await seat.respond(d.id, choice.id)
            handled[index].add(d.id)
          } catch (error) {
            if (!['stale_decision', 'engine_rejected'].includes(error.code)) throw error
          }
        }
        await sleep(20)
      }
      assert.ok(called !== null && maxTurn >= called + 5, 'Both pilots receive the five extra turns')
      const marker = await matchMarker(pairingId)
      assert.deepEqual(
        [marker?.tournamentScore?.winsA, marker?.tournamentScore?.winsB, marker?.tournamentScore?.draws],
        stage === 'playoffs' ? [1, 0, 0] : [0, 0, 1],
      )
      assert.equal(marker?.winner, stage === 'playoffs' ? names[0] : undefined)
    },
  )

test(
  'a full-match concession during the initial join closes every simultaneous Bo3 table',
  {
    skip: process.env.PLAYMAT_LOCAL_TOURNAMENT_FIXTURE !== '1',
    timeout: 45000,
  },
  async (t) => {
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        const { pairingId, names, seats, request } = await openPair(t)
        const { tableId } = await request('prepare', { players: names, format: 'Standard', stage: 'swiss', bestOf: 3 })
        seats.forEach((seat) => seat.acceptTournamentTable(tableId))
        const deck = { name: 'Concession fixture', cards: [{ cardName: 'Forest', amount: 60 }], sideboard: [] }
        await request('launch', { tableId, decks: [deck, deck] })
        const until = Date.now() + 20000
        while (!seats[1].snapshot().gameId && Date.now() < until) await sleep(5)
        const gameId = seats[1].snapshot().gameId
        assert.ok(gameId)
        await seats[1].concede(gameId, true)
        let marker
        while (!(marker = await matchMarker(pairingId)) && Date.now() < until) {
          assert.ok(!seats[1].snapshot().sideboard, 'A match concession must end without sideboarding')
          await sleep(20)
        }
        assert.equal(marker?.winner, names[0])
      }),
    )
  },
)
