import { randomUUID } from 'node:crypto'
import { retryFailedStart } from './tournament-start-recovery.mjs'
import { registeredDecklists } from './tournament-decklists.mjs'
import { isUuid, ProductError, transaction } from './decks.mjs'

// The two ticks are intentional: the bound ID must already be recoverable by
// both pilots before XMage can emit the first start-game callback.
export async function reconcileTournamentTable(assignment, ops) {
  if (!assignment.tableId) {
    const table = await ops.prepare()
    if (table?.tableId) await ops.bind(table.tableId)
    return
  }
  const result = await ops.findResult()
  if (result) {
    await ops.report({ tableId: assignment.tableId, ...result })
    return
  }
  if (await ops.ready()) await ops.launch(assignment.tableId)
}

export async function storeTournamentScore(pool, marker) {
  const score = marker.tournamentScore
  if (!score) return
  if (
    !isUuid(score.pairingId) ||
    !isUuid(score.tableId) ||
    !score.seatA ||
    !score.seatB ||
    ![score.winsA, score.winsB, score.draws].every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    throw new Error('Invalid tournament score')
  await transaction(pool, async (db) => {
    // Serialize native scores with retirement. An unexpected marker for a
    // retired table stays in archive staging for inspection and cannot claim
    // the replacement's unique result slot.
    const { rowCount } = await db.query(
      `SELECT table_id FROM tournament_pairing_tables WHERE pairing_id=$1 AND table_id=$2
       AND failed_start_retried_at IS NULL FOR SHARE`,
      [score.pairingId, score.tableId],
    )
    if (!rowCount) throw new Error('Tournament score belongs to an unbound or retired table')
    await db.query(
      `INSERT INTO tournament_engine_results(pairing_id,table_id,seat_a,seat_b,wins_a,wins_b,draws,disqualified,winner_engine_name,match_id)
      VALUES($1,$2,lower($3),lower($4),$5,$6,$7,$8,$9,$10) ON CONFLICT(pairing_id) DO NOTHING`,
      [
        score.pairingId,
        score.tableId,
        score.seatA,
        score.seatB,
        score.winsA,
        score.winsB,
        score.draws,
        score.disqualified ?? null,
        marker.winner ?? null,
        marker.matchId,
      ],
    )
  })
}

// Called in the same trusted transaction that rebinds both engine seats during checkpoint recovery.
export async function restoreTournamentTable(db, original, replacement) {
  if (!isUuid(original) || !isUuid(replacement) || original === replacement)
    throw new ProductError(400, 'Invalid restored table')
  await db.query(
    `UPDATE tournament_pairings SET table_id=$2,original_engine_table_id=COALESCE(original_engine_table_id,$1)
    WHERE NOT completed AND (table_id=$1 OR original_engine_table_id=$1)`,
    [original, replacement],
  )
}

export function createTournamentTableBridge(
  pool,
  tournaments,
  { engineUrl = 'http://127.0.0.1:17173/internal/tournament/table' } = {},
) {
  let running
  async function request(input) {
    const res = await fetch(engineUrl, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', 'x-playmat-internal': 'tournament' },
      body: JSON.stringify(input),
    })
    if (res.status === 409) return null // A player has not opened the engine connection yet.
    if (!res.ok) throw new Error('Tournament engine table request failed (' + res.status + ')')
    return res.json()
  }
  async function handle(pair) {
    const players = [pair.playerA, pair.playerB]
    const agentIds = players.flatMap((p) => (p.playerId ? [p.playerId] : []))
    await reconcileTournamentTable(pair, {
      prepare: () =>
        request({
          action: 'prepare',
          pairingId: pair.pairingId,
          format: pair.format,
          bestOf: pair.bestOf,
          sideboardAfterGame: pair.sideboardAfterGame,
          playDrawChooser: pair.playDrawChooser,
          stage: pair.stage,
          deadlineAt: pair.deadlineAt,
          players: players.map((p) => p.engineName),
        }),
      bind: (tableId) => tournaments.bindTable(pair.tournamentId, pair.pairingId, tableId),
      async findResult() {
        const {
          rows: [r],
        } = await pool.query(
          `SELECT r.wins_a AS "winsA",r.wins_b AS "winsB",r.draws,r.disqualified,r.winner_engine_name AS "winnerEngineName",r.match_id AS "matchId"
          FROM tournament_engine_results r JOIN tournament_pairings p ON p.id=r.pairing_id
          WHERE p.id=$1 AND p.table_id=$2 AND tournament_pairing_for_table(r.table_id)=p.id
            AND r.seat_a=lower($3) AND r.seat_b=lower($4)`,
          [pair.pairingId, pair.tableId, ...players.map((p) => p.engineName)],
        )
        return r
      },
      report: (result) => tournaments.report(pair.tournamentId, pair.pairingId, result),
      async ready() {
        const key = [pair.tournamentId, pair.pairingId, pair.tableId]
        let status
        try {
          status = await request({
            action: 'status',
            tableId: pair.tableId,
            pairingId: pair.pairingId,
            deadlineAt: pair.deadlineAt,
          })
        } catch (error) {
          await tournaments.suspendWaitingTable(...key)
          throw error
        }
        if (status?.tableId !== pair.tableId) {
          await tournaments.suspendWaitingTable(...key)
          return false
        }
        if (status.gameStarted === true) {
          await tournaments.markLaunched(pair.tournamentId, pair.pairingId, pair.tableId)
          return false
        }
        if (!['WAITING', 'READY_TO_START', 'STARTING'].includes(status.state) ||
            typeof status.seatAOnline !== 'boolean' || typeof status.seatBOnline !== 'boolean') {
          await tournaments.suspendWaitingTable(...key)
          return false
        }
        for (const [index, player] of players.entries()) {
          const online = index === 0 ? status.seatAOnline : status.seatBOnline
          if (online === false) {
            await tournaments.missTable(pair.tournamentId, pair.pairingId, pair.tableId, player.engineName)
          } else if (!player.playerId && online) {
            await tournaments.acceptTable(pair.tournamentId, pair.pairingId, pair.tableId, player.engineName)
          }
        }
        await tournaments.observeWaitingTable(...key)
        if (!status.seatAOnline || !status.seatBOnline) return false
        if (!agentIds.length) return true
        const { rowCount } = await pool.query(
          `SELECT player_id FROM player_table_reservations
          WHERE table_id=$1 AND player_id=ANY($2::uuid[]) AND started AND NOT cancel_pending`,
          [pair.tableId, agentIds],
        )
        return rowCount === agentIds.length
      },
      async launch(tableId) {
        const decks = await registeredDecklists(
          pool,
          players.map((p) => p.entryId),
        )
        if (decks.length !== 2) throw new Error('Missing registered tournament deck snapshot')
        const timing = await tournaments.beginTableLaunch(pair.tournamentId, pair.pairingId, tableId)
        if (!timing) return
        const live = await request({
          action: 'launch',
          tableId,
          pairingId: pair.pairingId,
          deadlineAt: timing.deadlineAt,
          decks,
        })
        if (live?.tableId === tableId && live.gameStarted === true)
          await tournaments.markLaunched(pair.tournamentId, pair.pairingId, tableId)
      },
    })
  }
  async function tick() {
    if (running) return running
    running = (async () => {
      for (const closed of await tournaments.closedTables()) {
        await request({ action: 'cancel', tableId: closed.tableId, pairingId: closed.pairingId })
        await pool.query('DELETE FROM player_table_reservations WHERE table_id=$1', [closed.tableId])
        await tournaments.cleanedTable(closed.tournamentId, closed.pairingId, closed.tableId)
      }
      const pairs = await tournaments.pendingTables()
      // One temporarily unavailable engine seat must not block another table.
      const results = await Promise.allSettled(pairs.map(handle))
      const error = results.find((result) => result.status === 'rejected')
      if (error) throw error.reason
    })().finally(() => {
      running = null
    })
    return running
  }
  async function connectSeat(actor, receipt, readyTableId, tournamentId = receipt?.tournamentId) {
    if (!actor?.agent || !actor.playerId || !receipt?.tableId) return receipt
    if (!actor.connectionId) throw new ProductError(403, 'An authorized player connection is required')
    const confirmed = readyTableId === receipt.tableId
    await transaction(pool, async (db) => {
      const { rowCount: entitled } = await db.query(
        `SELECT p.id FROM tournament_pairings p JOIN tournament_entries e
        ON e.id IN(p.entry_a,p.entry_b) JOIN playable_oauth_seats s ON s.player_id=e.player_id AND s.account_id=e.owner_id
        WHERE p.id=$1 AND p.tournament_id=$2 AND p.table_id=$3 AND NOT p.completed
          AND e.player_id=$4 AND e.owner_id=$5 AND s.connection_id=$6 FOR SHARE OF p`,
        [receipt.pairingId, tournamentId, receipt.tableId, actor.playerId, actor.accountId, actor.connectionId],
      )
      if (!entitled) throw new ProductError(409, 'This tournament assignment has changed')
      const { rowCount } = await db.query(
        `INSERT INTO player_table_reservations AS r
        (player_id,reservation_id,connection_id,table_id,original_table_id,started)
      VALUES($1,$2,$3,$4,$4,$5) ON CONFLICT(player_id) DO UPDATE SET started=(r.started OR EXCLUDED.started)
      WHERE r.table_id=EXCLUDED.table_id AND r.connection_id=EXCLUDED.connection_id AND NOT r.cancel_pending`,
        [actor.playerId, randomUUID(), actor.connectionId, receipt.tableId, confirmed],
      )
      if (!rowCount) throw new ProductError(409, 'This agent has a reservation at another table or connection')
    })
    if (confirmed) {
      await tournaments.acceptTable(tournamentId, receipt.pairingId, receipt.tableId, actor.engineName)
      const live = await request({
        action: 'attach',
        pairingId: receipt.pairingId,
        tableId: receipt.tableId,
        engineName: actor.engineName,
      })
      if (live?.state === 'DUELING' && live.gameId && live.ownGamePlayerId) {
        return { ...receipt, gameId: live.gameId, ownGamePlayerId: live.ownGamePlayerId }
      }
    }
    return receipt
  }
  return { tick, connectSeat, retryFailedStart: (id, actor, input) => retryFailedStart(pool, id, actor, input, request) }
}
