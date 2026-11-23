import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createTournamentTableBridge, storeTournamentScore } from './tournament-table-bridge.mjs'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { retryFailedStart } from './tournament-start-recovery.mjs'
import { createTournamentService } from './tournaments.mjs'

test(
  'an admin requeues only the confirmed failed physical table and keeps the competition intact',
  {
    skip: !process.env.PLAYMAT_TEST_DATABASE_URL,
  },
  async (t) => {
    const config = { connectionString: process.env.PLAYMAT_TEST_DATABASE_URL }
    const main = new Pool(config)
    const schema = 'recovery_' + randomUUID().replaceAll('-', '')
    await main.query('CREATE SCHEMA ' + schema)
    const pool = new Pool({ ...config, options: '-c search_path=' + schema })
    t.after(async () => {
      await pool.end()
      await main.query('DROP SCHEMA ' + schema + ' CASCADE')
      await main.end()
    })
    for (const file of ['schema.sql', 'tournaments.sql', 'tournament-table-bridge.sql'])
      await pool.query(await readFile(new URL(file, import.meta.url), 'utf8'))
    await pool.query(`CREATE TABLE player_table_reservations(player_id uuid PRIMARY KEY,table_id uuid,
      original_table_id uuid,reservation_id uuid UNIQUE,connection_id uuid,started boolean DEFAULT false,cancel_pending boolean DEFAULT false);
      CREATE TABLE playable_oauth_seats(player_id uuid, account_id uuid, connection_id uuid)`)
    const [owner, tournamentId, pairingId, neighbor, tableId, live, replacement, matchId] = Array.from(
      { length: 8 },
      randomUUID,
    )
    const entries = Array.from({ length: 4 }, randomUUID)
    await pool.query(
      "INSERT INTO accounts(id,username,username_key,password_hash) VALUES($1,'owner','owner','fixture')",
      [owner],
    )
    await pool.query(
      `INSERT INTO tournaments(id,name,format,organizer_id,template,cut,capacity,swiss_best_of,playoff_best_of,max_agents_per_owner,coaching,break_minutes,created_at,status,round_number,deadline_at)
    VALUES($1,'Cup','Standard',$2,'casual','none',8,3,5,4,false,5,0,'playing',1,11)`,
      [tournamentId, owner],
    )
    for (const id of entries) {
      await pool.query("INSERT INTO player_profiles(id,account_id,display_name) VALUES($1,$2,'Pilot')", [
        id,
        owner,
      ])
      await pool.query(
        `INSERT INTO tournament_entries(id,tournament_id,owner_id,player_id,name,owner_name,engine_name,deck_id,deck_revision,deck_name)
      VALUES($1,$2,$3,$1,'Pilot','owner',$1::uuid::text,'deck',1,'deck')`,
        [id, tournamentId, owner],
      )
    }
    for (const [number, id, physical, a, b] of [
      [1, pairingId, tableId, ...entries.slice(0, 2)],
      [2, neighbor, live, ...entries.slice(2)],
    ]) {
      await pool.query(
        `INSERT INTO tournament_pairings(id,tournament_id,round_number,stage,number,best_of,entry_a,entry_b,table_id,opened_at,deadline_at,ack_a,ack_b,launched,attendance_elapsed_ms)
      VALUES($1,$2,1,'swiss',$3,3,$4,$5,$6,1,11,2,3,true,599000)`,
        [id, tournamentId, number, a, b, physical],
      )
      await pool.query('INSERT INTO player_table_reservations(player_id,table_id) VALUES($1,$3),($2,$3)', [
        a,
        b,
        physical,
      ])
    }
    const readPair = async (id) =>
      (await pool.query('SELECT * FROM tournament_pairings WHERE id=$1', [id])).rows[0]
    const before = await readPair(neighbor)
    const admin = { accountId: owner, isAdmin: true }
    const input = { pairingId, tableId, confirmedPreGameFailure: true }
    const probe = async () => ({ pairingId, tableId, canRetry: true })
    const retry = (actor = admin, args = input, inspect = probe) =>
      retryFailedStart(pool, tournamentId, actor, args, inspect)
    for (const actor of [{}, { accountId: owner, isAdmin: true, agent: true }])
      await assert.rejects(retry(actor), /admin/i)
    await assert.rejects(retry(admin, { ...input, confirmedPreGameFailure: false }), /confirm/i)
    for (const proof of [
      null,
      {},
      { tableId, pairingId, canRetry: false },
      { pairingId, tableId: live, canRetry: true },
    ])
      await assert.rejects(
        retry(admin, input, async () => proof),
        /engine/i,
      )
    await pool.query("INSERT INTO matches(id,table_id,started_at,status) VALUES($1,$2,0,'active')", [
      matchId,
      tableId,
    ])
    await assert.rejects(retry(), /record/i)
    await pool.query('DELETE FROM matches WHERE id=$1', [matchId])
    await pool.query(
      `INSERT INTO tournament_engine_results(pairing_id,table_id,seat_a,seat_b,wins_a,wins_b,draws,match_id) VALUES($1,$2,'a','b',0,0,0,$3)`,
      [pairingId, tableId, matchId],
    )
    await assert.rejects(retry(), /record/i)
    await pool.query('DELETE FROM tournament_engine_results WHERE pairing_id=$1', [pairingId])
    const results = await Promise.all([retry(), retry()])
    assert.deepEqual(results.map((r) => r.status).sort(), ['already_queued', 'queued'])
    const queued = await readPair(pairingId)
    assert.equal(queued.table_id, null)
    assert.equal(queued.entry_a, entries[0])
    assert.equal(queued.launched, false)
    assert.equal(queued.ack_a, null)
    assert.equal(queued.ack_b, null)
    assert.equal(queued.attendance_elapsed_ms, '0')
    let now = 2000
    const service = createTournamentService(pool, { clock: () => now })
    await assert.rejects(service.bindTable(tournamentId, pairingId, tableId), /table/i)
    await service.bindTable(tournamentId, pairingId, replacement)
    assert.equal((await readPair(pairingId)).deadline_at, String(2000 + 50 * 60_000))
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ tableId: replacement, state: 'WAITING' }))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise((resolve) => server.close(resolve)))
    const bridge = createTournamentTableBridge(pool, service, {
      engineUrl: 'http://127.0.0.1:' + server.address().port,
    })
    const pilots = entries.slice(0, 2).map((playerId) => ({
      agent: true,
      accountId: owner,
      playerId,
      engineName: playerId,
      connectionId: randomUUID(),
    }))
    for (const p of pilots)
      await pool.query('INSERT INTO playable_oauth_seats VALUES($1,$2,$3)', [
        p.playerId,
        owner,
        p.connectionId,
      ])
    const receipt = { tournamentId, pairingId, tableId: replacement }
    await assert.rejects(bridge.connectSeat(pilots[0], { ...receipt, tableId }, tableId), /changed/i)
    await bridge.connectSeat(pilots[0], receipt, replacement)
    await service.observeWaitingTable(tournamentId, pairingId, replacement)
    now += 1000
    await service.observeWaitingTable(tournamentId, pairingId, replacement)
    await service.tick()
    assert.equal((await readPair(pairingId)).attendance_elapsed_ms, '1000')
    assert.equal((await readPair(pairingId)).completed, false)
    assert.equal(await service.beginTableLaunch(tournamentId, pairingId, replacement), null)
    now += 6 * 60_000
    await bridge.connectSeat(pilots[1], receipt, replacement)
    const expectedDeadline = now + 50 * 60_000
    assert.deepEqual(await service.beginTableLaunch(tournamentId, pairingId, replacement), {
      deadlineAt: expectedDeadline,
    })
    now += 20_000
    assert.deepEqual(await service.beginTableLaunch(tournamentId, pairingId, replacement), {
      deadlineAt: expectedDeadline,
    })
    await service.markLaunched(tournamentId, pairingId, replacement)
    now += 3 * 60_000
    assert.equal(await service.beginTableLaunch(tournamentId, pairingId, replacement), null)
    assert.equal(await service.beginTableLaunch(tournamentId, pairingId, tableId), null)
    assert.equal((await retry()).status, 'already_queued')
    assert.equal((await readPair(pairingId)).table_id, replacement)
    assert.deepEqual(await readPair(neighbor), before)
    assert.equal(
      (await pool.query('SELECT deadline_at FROM tournaments WHERE id=$1', [tournamentId])).rows[0]
        .deadline_at,
      '11',
    )
    for (const [physical, expected] of [
      [tableId, 0],
      [live, 2],
      [replacement, 2],
    ])
      assert.equal(
        (await pool.query('SELECT player_id FROM player_table_reservations WHERE table_id=$1', [physical]))
          .rowCount,
        expected,
      )
    const marker = {
      matchId,
      tournamentScore: {
        pairingId,
        tableId,
        seatA: entries[0],
        seatB: entries[1],
        winsA: 2,
        winsB: 0,
        draws: 0,
      },
    }
    await assert.rejects(storeTournamentScore(pool, marker), /retired/i)
    assert.equal(
      (await pool.query('SELECT pairing_id FROM tournament_engine_results WHERE pairing_id=$1', [pairingId]))
        .rowCount,
      0,
    )
    await storeTournamentScore(pool, {
      ...marker,
      tournamentScore: { ...marker.tournamentScore, tableId: replacement },
    })
    assert.equal(
      (await pool.query('SELECT table_id FROM tournament_engine_results WHERE pairing_id=$1', [pairingId]))
        .rows[0].table_id,
      replacement,
    )
  },
)
