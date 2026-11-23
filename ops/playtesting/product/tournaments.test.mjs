import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { tournamentStructure, swissPairings, rankStandings, eliminationPairs } from './tournament-rules.mjs'
import { createTournamentService } from './tournaments.mjs'

const group = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: String(i + 1), ownerId: i % 2 ? 'A' : 'B', seed: i + 1 }))
test('attendance, casual and the adapted World Championship choose distinct structures', () => {
  assert.deepEqual(tournamentStructure({ template: 'attendance', cut: 'none' }, 8), { swissRounds: 3, cutSize: 0 })
  assert.deepEqual(tournamentStructure({ template: 'attendance', cut: 'auto' }, 8), { swissRounds: 0, cutSize: 8 })
  assert.deepEqual(tournamentStructure({ template: 'attendance', cut: 'auto' }, 11), { swissRounds: 5, cutSize: 4 })
  assert.deepEqual(tournamentStructure({ template: 'attendance', cut: 'auto' }, 33), { swissRounds: 6, cutSize: 8 })
  assert.deepEqual(tournamentStructure({ template: 'worlds', cut: 'auto' }, 128), { swissRounds: 14, cutSize: 8 })
})
test('eight seats play three complete Swiss rounds avoiding rematches and producing one undefeated player', () => {
  const players = group(8),
    history = []
  for (let round = 1; round <= 3; round++) {
    const standings = rankStandings(players, history)
    const pairs = swissPairings(standings, history)
    assert.equal(pairs.length, 4)
    assert.equal(new Set(pairs.flat()).size, 8)
    for (const [a, b] of pairs) {
      assert.ok(!history.some((h) => [h.a, h.b].includes(a) && [h.a, h.b].includes(b)))
      if (round === 1) assert.notEqual(players.find((p) => p.id === a).ownerId, players.find((p) => p.id === b).ownerId)
      history.push({ a, b, winsA: 2, winsB: 1, draws: 0, stage: 'swiss', completed: true })
    }
  }
  const standings = rankStandings(players, history)
  assert.equal(standings.filter((p) => p.points === 9).length, 1)
  assert.equal(
    standings.reduce((n, p) => n + p.points, 0),
    36,
  )
})
test('a bye receives three points and counts as a 2-0, without contributing an opponent to tiebreakers', () => {
  const players = group(3)
  const history = [{ a: '1', b: null, winsA: 2, winsB: 0, draws: 0, completed: true, stage: 'swiss' }]
  const standings = rankStandings(players, history)
  assert.equal(standings[0].points, 3)
  assert.equal(standings[0].gw, 1)
  assert.ok(!swissPairings(standings, history).some(([a, b]) => a === '1' && b === null))
  assert.deepEqual(eliminationPairs(group(8).map((p) => p.id)), [
    ['1', '8'],
    ['4', '5'],
    ['2', '7'],
    ['3', '6'],
  ])
})

test(
  'two owners finish the casual cup through a restart, extended break and duplicate match delivery',
  { skip: !process.env.PLAYMAT_TEST_DATABASE_URL },
  async (t) => {
    const base = new Pool({ connectionString: process.env.PLAYMAT_TEST_DATABASE_URL })
    const schema = 'trn_' + randomUUID().replaceAll('-', '')
    await base.query('CREATE SCHEMA ' + schema)
    const pool = new Pool({
      connectionString: process.env.PLAYMAT_TEST_DATABASE_URL,
      options: '-c search_path=' + schema,
    })
    t.after(async () => {
      await pool.end()
      await base.query('DROP SCHEMA ' + schema + ' CASCADE')
      await base.end()
    })
    for (const file of ['schema.sql', 'tournaments.sql'])
      await pool.query(await readFile(new URL(file, import.meta.url), 'utf8'))
    const owners = [randomUUID(), randomUUID()]
    for (const [i, id] of owners.entries())
      await pool.query("INSERT INTO accounts(id,username,username_key,password_hash) VALUES($1,$2,$2,'fixture')", [
        id,
        'owner' + i,
      ])
    const owner = { accountId: owners[0], username: 'owner0', isAdmin: true }
    const seats = []
    let now = Date.now()
    const clock = () => now
    const options = {
      clock,
      readDeck: async () => ({
        format: 'Standard',
        revision: 1,
        name: 'Secret deck',
        data: { cards: [{ cardName: 'Forest', amount: 60 }], sideboard: [] },
      }),
    }
    let service = createTournamentService(pool, options)
    const event = await service.create(owner, { name: 'Eight seat cup', format: 'Standard', capacity: 8, cut: 'none' })
    for (let i = 0; i < 8; i++) {
      const accountId = owners[i % 2],
        playerId = randomUUID()
      await pool.query('INSERT INTO player_profiles(id,account_id,display_name,mcp_enabled) VALUES($1,$2,$3,true)', [
        playerId,
        accountId,
        'agent' + i,
      ])
      const actor = {
        accountId,
        playerId,
        username: 'owner' + (i % 2),
        engineName: 'agent' + i,
        displayName: 'agent' + i,
        agent: true,
      }
      seats.push(actor)
      await service.join(event.id, actor, { deckId: 'test-deck' })
      await service.wait(event.id, actor)
    }
    await assert.rejects(service.action(event.id, seats[0], { action: 'start' }))
    await service.action(event.id, owner, { action: 'start' })
    for (let round = 1; round <= 3; round++) {
      const tables = await service.pendingTables()
      assert.equal(tables.length, 4)
      for (const table of tables) {
        const id = randomUUID()
        await service.bindTable(event.id, table.pairingId, id)
        const actor = seats.find((s) => s.playerId === table.playerA.playerId)
        assert.equal((await service.wait(event.id, actor)).tableId, id)
        const result = { tableId: id, winsA: 2, winsB: 0, draws: 0 }
        await service.report(event.id, table.pairingId, result)
        await service.report(event.id, table.pairingId, result)
      }
      const view = await service.get(event.id)
      if (round < 3) {
        assert.equal(view.status, 'break')
        assert.ok(!JSON.stringify(view).includes('Secret deck'))
        if (round === 1) {
          await service.action(event.id, owner, { action: 'extend', minutes: 2 })
          await service.action(event.id, owner, { action: 'pause' })
          service = createTournamentService(pool, options)
          now += 24 * 3600_000
          await service.tick()
          assert.equal((await service.get(event.id)).status, 'paused')
          await service.action(event.id, owner, { action: 'resume' })
        }
        now += 8 * 60_000
        await service.tick()
      } else {
        assert.equal(view.status, 'finished')
        assert.equal(view.standings[0].points, 9)
        assert.ok(JSON.stringify(view).includes('Secret deck'))
        assert.equal(view.championId, view.standings[0].id)
      }
    }
  },
)

async function scheduledFixture(t, count, config = {}) {
  const base = new Pool({ connectionString: process.env.PLAYMAT_TEST_DATABASE_URL })
  const schema = 'trn_' + randomUUID().replaceAll('-', '')
  await base.query('CREATE SCHEMA ' + schema)
  const pool = new Pool({
    connectionString: process.env.PLAYMAT_TEST_DATABASE_URL,
    options: '-c search_path=' + schema,
  })
  t.after(async () => {
    await pool.end()
    await base.query('DROP SCHEMA ' + schema + ' CASCADE')
    await base.end()
  })
  for (const file of ['schema.sql', 'tournaments.sql'])
    await pool.query(await readFile(new URL(file, import.meta.url), 'utf8'))
  const owner = { accountId: randomUUID(), username: 'testowner', isAdmin: true }
  await pool.query("INSERT INTO accounts(id,username,username_key,password_hash) VALUES($1,$2,$2,'fixture')", [
    owner.accountId,
    owner.username,
  ])
  let now = Date.now()
  const deck = {
    format: 'Standard',
    revision: 1,
    name: 'Secret list',
    data: { cards: [{ cardName: 'Forest', amount: 60 }], sideboard: [{ cardName: 'Island', amount: 1 }] },
  }
  const restart = () => createTournamentService(pool, { clock: () => now, readDeck: async () => deck })
  const service = restart()
  const { id } = await service.create(owner, { name: 'Championship', format: 'Standard', capacity: count, ...config })
  const actors = []
  for (let i = 0; i < count; i++) {
    const actor = {
      ...owner,
      ownerIsAdmin: true,
      isAdmin: false,
      agent: true,
      playerId: randomUUID(),
      displayName: 'Agent ' + i,
      engineName: 'pilot' + i,
    }
    actors.push(actor)
    await pool.query('INSERT INTO player_profiles(id,account_id,display_name,mcp_enabled) VALUES($1,$2,$3,true)', [
      actor.playerId,
      owner.accountId,
      actor.displayName,
    ])
    await service.join(id, actor, { deckId: 'registered' })
    await service.wait(id, actor)
  }
  return {
    pool,
    service,
    owner,
    id,
    actors,
    deck,
    restart,
    advance: (delta) => {
      now += delta
    },
    open: () => service.action(id, owner, { action: 'start' }),
  }
}

const dbTest = (title, run) => test(title, { skip: !process.env.PLAYMAT_TEST_DATABASE_URL }, run)

async function observedWaiting(fixture, pairing, seconds) {
  const observe = () => fixture.service.observeWaitingTable(fixture.id, pairing.pairingId, pairing.tableId)
  await observe()
  for (let elapsed = 0; elapsed < seconds; elapsed += 10) {
    fixture.advance(10_000)
    await observe()
  }
}

dbTest(
  'an eight-seat knockout publishes the original lists on start, ignores disconnected registrations and awards owner and agent',
  async (t) => {
    const f = await scheduledFixture(t, 8)
    assert.deepEqual((await f.service.get(f.id)).deckLists, [])
    f.advance(91_000)
    for (const a of f.actors.slice(0, 7)) await f.service.wait(f.id, a)
    f.deck.data.cards[0].cardName = 'Changed in library'
    const first = await f.open()
    assert.equal(first.deckLists.length, 7)
    assert.ok(first.deckLists.every((d) => d.cards[0].cardName === 'Forest'))
    assert.equal(first.participants.filter((p) => p.state === 'absent').length, 1)
    assert.equal(first.pairings.filter((p) => !p.b).length, 1)
    assert.equal(first.cutSize, 8)
    await assert.rejects(f.service.join(f.id, f.actors[0], { deckId: 'new' }), /closed/)
    for (let n = 0; n < 3; n++) {
      for (const m of await f.service.pendingTables()) {
        const tableId = randomUUID()
        await f.service.bindTable(f.id, m.pairingId, tableId)
        await assert.rejects(f.service.report(f.id, m.pairingId, { tableId, winsA: 1, winsB: 1 }), /score/)
        await f.service.report(f.id, m.pairingId, {
          tableId,
          winsA: 0,
          winsB: 0,
          winnerEngineName: m.playerA.engineName,
        })
      }
      f.advance(300_000)
      await Promise.all([f.service.tick(), f.service.tick()])
    }
    const result = await f.service.get(f.id),
      profile = await f.service.profile(f.owner.username)
    assert.equal(result.status, 'finished')
    assert.equal(result.championId, result.standings[0].id)
    assert.equal(profile.trophies.length, 1)
    assert.equal(profile.trophies[0].kind, 'agent')
    assert.equal(profile.participations.length, 7)
  },
)

dbTest(
  'presentation timers warn on round obligations, only confirmed seats escape disqualification, cleanup retries safely',
  async (t) => {
    const f = await scheduledFixture(t, 3, { cut: 'none', swissRounds: 1 })
    await f.open()
    const [m] = await f.service.pendingTables(),
      tableId = randomUUID()
    await f.service.bindTable(f.id, m.pairingId, tableId)
    const absent = f.actors.find((p) => p.playerId === m.playerB.playerId)
    await f.service.wait(f.id, absent)
    await f.service.acceptTable(f.id, m.pairingId, tableId, m.playerA.engineName)
    await observedWaiting(f, { ...m, tableId }, 180)
    assert.deepEqual((await f.service.get(f.id)).pairings.find((p) => p.id === m.pairingId).absentWarningIds, [
      m.playerB.entryId,
    ])
    await observedWaiting(f, { ...m, tableId }, 420)
    await Promise.all([f.service.tick(), f.service.tick()])
    const view = await f.service.get(f.id)
    assert.equal(view.participants.find((p) => p.id === m.playerB.entryId).state, 'disqualified')
    assert.equal(view.status, 'finished')
    assert.equal((await f.service.closedTables())[0].tableId, tableId)
    await f.service.cleanedTable(f.id, m.pairingId, tableId)
    assert.deepEqual(await f.service.closedTables(), [])
  },
)
dbTest(
  'Worlds cuts to the second day on 12 points, locks ten-win seeds, then publishes only Top 8 and plays Bo5',
  async (t) => {
    const f = await scheduledFixture(t, 32, { template: 'worlds', breakMinutes: 0 })
    await f.open()
    for (let n = 1; n <= 14; n++) {
      const tables = await f.service.pendingTables()
      assert.ok(tables.length > 0)
      for (const m of tables) {
        assert.equal(m.bestOf, 3)
        const id = randomUUID()
        await f.service.bindTable(f.id, m.pairingId, id)
        await f.service.report(f.id, m.pairingId, { tableId: id, winsA: 2, winsB: 1 })
      }
      const view = await f.service.get(f.id)
      assert.deepEqual(view.deckLists, [])
      if (n === 7 || n === 14) {
        assert.equal(view.status, 'paused')
        if (n === 7) assert.ok(view.standings.every((p) => p.points >= 12 || p.state === 'eliminated'))
        await f.service.action(f.id, f.owner, { action: 'resume' })
      } else await f.service.tick()
    }
    const top = await f.service.get(f.id)
    assert.equal(top.stage, 'playoffs')
    assert.equal(top.deckLists.length, 8)
    const finals = await f.service.pendingTables()
    assert.equal(finals.length, 4)
    assert.ok(finals.every((p) => p.bestOf === 5 && p.sideboardAfterGame === 2 && p.deadlineAt === null))
    assert.ok(
      top.pairings.filter((p) => p.stage === 'playoffs').every((p) => top.deckLists.some((d) => d.entryId === p.a)),
    )
  },
)

dbTest(
  'completed Swiss matches conceal opposing archetypes across history and statistics until deck publication',
  async (t) => {
    const f = await scheduledFixture(t, 4, { cut: 'none', swissRounds: 2 })
    for (const file of [
      'oauth-schema.sql',
      'player-identities.sql',
      'review-schema.sql',
      'review-permissions.sql',
      'tournament-access.sql',
      'history-retention.sql',
      'performance-schema.sql',
    ]) {
      await f.pool.query(await readFile(new URL(file, import.meta.url), 'utf8'))
    }
    const { migrateDeckLists, refineMigratedDeckLists } = await import('./deck-list-migration.mjs')
    await migrateDeckLists(f.pool)
    await refineMigratedDeckLists(f.pool)
    const { createArchive } = await import('./archive.mjs')
    const { createReviewPermissions } = await import('./review-permissions.mjs')
    const { putDeck } = await import('./decks.mjs')
    const archive = createArchive(f.pool, '', new Map()),
      permissions = createReviewPermissions(f.pool)
    await f.open()
    const [pair] = await f.service.pendingTables(),
      tableId = randomUUID(),
      matchId = randomUUID(),
      gameId = randomUUID()
    const actors = [pair.playerA, pair.playerB].map((s) => f.actors.find((a) => a.playerId === s.playerId))
    await f.service.bindTable(f.id, pair.pairingId, tableId)
    for (const actor of actors)
      await f.pool.query(
        "INSERT INTO agent_grants(digest,account_id,engine_name,engine_key,scopes,player_id) VALUES($1,$2,$3,$3,'{play,history}',$4)",
        [randomUUID(), actor.accountId, actor.engineName, actor.playerId],
      )
    await putDeck(
      f.pool,
      actors[1].accountId,
      'sibling-deck',
      { data: f.deck.data, name: 'Sibling private deck', format: 'Standard', expectedRevision: 0 },
      'private',
      null,
      actors[1].playerId,
    )
    await f.pool.query(
      "INSERT INTO matches(id,table_id,format,started_at,status) VALUES($1,$2,'Standard',1,'completed')",
      [matchId, tableId],
    )
    await f.pool.query(
      "INSERT INTO games(id,match_id,game_number,started_at,status,archive_state) VALUES($1,$2,1,1,'completed','ready')",
      [gameId, matchId],
    )
    for (const [i, actor] of actors.entries())
      await f.pool.query(
        'INSERT INTO game_players(game_id,engine_key,engine_name,human,archetype,player_id) VALUES($1,$2,$2,true,$3,$4)',
        [gameId, actor.engineName, i ? 'HiddenAggro' : 'MyDeck', actor.playerId],
      )

    // Engine recovery assigns a new table. Captures made on the original table stay private, too.
    const replacementTable = randomUUID()
    await f.pool.query('UPDATE tournament_pairings SET original_engine_table_id=table_id,table_id=$2 WHERE id=$1', [
      pair.pairingId,
      replacementTable,
    ])
    const secondRecovery = randomUUID()
    await f.pool.query('UPDATE tournament_pairings SET table_id=$2 WHERE id=$1', [pair.pairingId, secondRecovery])
    for (const capturedTable of [tableId, replacementTable, secondRecovery]) {
      const { rows } = await f.pool.query('SELECT tournament_pairing_for_table($1) AS id', [capturedTable])
      assert.equal(rows[0].id, pair.pairingId)
    }
    // The first archived game can belong to the intermediate physical table.
    await f.pool.query('UPDATE matches SET table_id=$2 WHERE id=$1', [matchId, replacementTable])
    const before = await permissions.reviewAccess(actors[0], matchId)
    assert.equal(before.fullAvailable, false)
    assert.deepEqual(
      before.perspectives.filter((p) => p.owned).map((p) => p.seatId),
      [actors[0].engineName],
    )
    await f.service.report(f.id, pair.pairingId, { tableId: secondRecovery, matchId, winsA: 2, winsB: 0 })
    assert.equal((await permissions.reviewAccess(actors[0], matchId)).fullAvailable, true)
    const hidden = await archive.matchList(actors[0])
    assert.ok(JSON.stringify(hidden).includes('MyDeck'))
    assert.ok(!JSON.stringify(hidden).includes('HiddenAggro'))
    const stats = await archive.performance(actors[0], {})
    assert.ok(!JSON.stringify(stats).includes('HiddenAggro'))
    assert.ok(!JSON.stringify(stats).includes('Sibling private deck'))
    await f.pool.query("UPDATE tournaments SET status='finished' WHERE id=$1", [f.id])
    assert.ok(JSON.stringify(await archive.matchList(actors[0])).includes('HiddenAggro'))
    assert.ok(JSON.stringify(await archive.performance(actors[0], {})).includes('HiddenAggro'))
  },
)

dbTest('the admin switches a small Worlds field to three casual rounds with the same deck registrations', async (t) => {
  const f = await scheduledFixture(t, 8, { template: 'worlds' })
  await assert.rejects(f.open(), /few/)
  const before = await f.service.get(f.id)
  await assert.rejects(
    f.service.action(f.id, f.actors[0], { action: 'structure', template: 'attendance', cut: 'none', swissRounds: 3 }),
  )
  await f.service.action(f.id, f.owner, { action: 'structure', template: 'attendance', cut: 'none', swissRounds: 3 })
  const started = await f.open()
  assert.deepEqual(started.participants.map((p) => p.id).sort(), before.participants.map((p) => p.id).sort())
  assert.equal(started.roundsTotal, 3)
  assert.equal(started.cutSize, 0)
  assert.equal(started.stage, 'swiss')
  assert.equal((await f.service.pendingTables()).length, 4)
  await assert.rejects(
    f.service.action(f.id, f.owner, { action: 'structure', template: 'worlds', cut: 'auto' }),
    /current/,
  )
})

dbTest(
  'an agent who disconnects after acknowledgement can forfeit a pending table; launch transfers the AFK clock to the engine',
  async (t) => {
    const f = await scheduledFixture(t, 4, { cut: 'none', swissRounds: 1 })
    await f.open()
    const [pregame, playing] = await f.service.pendingTables()
    for (const table of [pregame, playing]) {
      table.tableId = randomUUID()
      await f.service.bindTable(f.id, table.pairingId, table.tableId)
      await f.service.acceptTable(f.id, table.pairingId, table.tableId, table.playerA.engineName)
      await f.service.acceptTable(f.id, table.pairingId, table.tableId, table.playerB.engineName)
    }
    await f.service.markLaunched(f.id, playing.pairingId, playing.tableId)
    for (const table of [pregame, playing])
      await f.service.missTable(f.id, table.pairingId, table.tableId, table.playerB.engineName)
    await observedWaiting(f, pregame, 600)
    await f.service.tick()
    const result = await f.service.get(f.id)
    assert.equal(result.pairings.find((p) => p.id === pregame.pairingId).reason, 'no_show')
    assert.equal(result.pairings.find((p) => p.id === playing.pairingId).completed, false)
  },
)

dbTest('an engine or worker outage freezes each pending table attendance clock across restart', async (t) => {
  const f = await scheduledFixture(t, 2, { cut: 'none', swissRounds: 1 })
  await f.open()
  const [pair] = await f.service.pendingTables()
  pair.tableId = randomUUID()
  await f.service.bindTable(f.id, pair.pairingId, pair.tableId)
  await f.service.acceptTable(f.id, pair.pairingId, pair.tableId, pair.playerA.engineName)
  await observedWaiting(f, pair, 120)
  f.advance(24 * 3600_000)
  f.service = f.restart()
  await f.service.tick()
  const stopped = (await f.service.get(f.id)).pairings[0]
  assert.equal(stopped.completed, false)
  assert.equal(stopped.attendanceDeadlineAt, null)
  assert.deepEqual(stopped.absentWarningIds, [])
  await observedWaiting(f, pair, 470)
  // A confirmed negative probe freezes even a brief gap below the worker timeout.
  await f.service.suspendWaitingTable(f.id, pair.pairingId, pair.tableId)
  f.advance(20_000)
  await observedWaiting(f, pair, 0)
  await f.service.tick()
  assert.equal((await f.service.get(f.id)).pairings[0].completed, false)
  await observedWaiting(f, pair, 10)
  await f.service.tick()
  assert.equal((await f.service.get(f.id)).pairings[0].reason, 'no_show')
})

dbTest(
  'a profile playing at an unrelated table is unavailable for attendance and cannot take a tournament seat',
  async (t) => {
    const f = await scheduledFixture(t, 4, { cut: 'none' })
    const actor = { ...f.actors[0], activeTableId: randomUUID(), ownsReservation: true }
    const receipt = await f.service.wait(f.id, actor)
    assert.equal(receipt.state, 'busy')
    assert.equal(receipt.tableId, null)
    assert.equal(receipt.online, false)
    assert.equal((await f.service.get(f.id)).participants.find((p) => p.playerId === actor.playerId).online, false)
    const opened = await f.open()
    assert.equal(opened.participants.find((p) => p.playerId === actor.playerId).state, 'absent')
  },
)
