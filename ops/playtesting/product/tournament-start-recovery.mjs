import { ProductError, isUuid, transaction } from './decks.mjs'
import { roundDurationMs, tournamentRow } from './tournament-state.mjs'
import { requireTournamentAdmin } from './tournament-access.mjs'

// Retire one physical table only after the organizer identifies a pregame failure
// and the native engine and durable match records both confirm it is safe to retry.
export async function retryFailedStart(pool, tournamentId, actor, input, inspect, clock = Date.now) {
  requireTournamentAdmin(actor)
  const { pairingId, tableId } = input
  if (![tournamentId, pairingId, tableId].every(isUuid))
    throw new ProductError(400, 'Provide the exact tournament, pairing and table IDs')
  if (input.confirmedPreGameFailure !== true)
    throw new ProductError(400, 'Confirm that this table failed before its first game started')

  return transaction(pool, async (db) => {
    const tournament = await tournamentRow(db, tournamentId, 'FOR UPDATE')
    const {
      rows: [pair],
    } = await db.query(
      `SELECT p.*, physical.failed_start_retried_at
       FROM tournament_pairings p JOIN tournament_pairing_tables physical
         ON physical.pairing_id=p.id AND physical.table_id=$3
       WHERE p.tournament_id=$1 AND p.id=$2 FOR UPDATE OF p,physical`,
      [tournamentId, pairingId, tableId],
    )
    if (!pair) throw new ProductError(409, 'This table does not belong to the selected pairing')
    if (pair.failed_start_retried_at !== null) return { status: 'already_queued', pairingId, tableId }
    if (
      tournament.status !== 'playing' ||
      tournament.round_number !== pair.round_number ||
      pair.table_id !== tableId ||
      !pair.entry_b ||
      pair.completed
    )
      throw new ProductError(409, 'This pairing is no longer active at this table')
    if (
      pair.original_engine_table_id ||
      pair.match_id ||
      pair.winner_entry ||
      pair.result_reason ||
      pair.wins_a ||
      pair.wins_b ||
      pair.draws
    )
      throw new ProductError(409, 'The pairing already has a game, checkpoint or result record')
    const native = await inspect({ action: 'inspectFailedStart', pairingId, tableId })
    if (native?.pairingId !== pairingId || native.tableId !== tableId || native.canRetry !== true)
      throw new ProductError(409, 'The engine cannot confirm the previous table is safe to replace')
    // The archive worker removes staging files after its PostgreSQL commit.
    // Check PostgreSQL after probing native storage to cover an in-flight import.
    const {
      rows: [data],
    } = await db.query(
      `SELECT EXISTS (SELECT FROM tournament_engine_results WHERE pairing_id=$1)
        OR EXISTS (SELECT FROM matches m JOIN tournament_pairing_tables x ON x.table_id=m.table_id WHERE x.pairing_id=$1)
        OR EXISTS (SELECT FROM tournament_pairing_tables WHERE pairing_id=$1 AND table_id<>$2 AND failed_start_retried_at IS NULL)
        AS recorded`,
      [pairingId, tableId],
    )
    if (data.recorded)
      throw new ProductError(409, 'The pairing already has a game, checkpoint or result record')
    const now = clock()
    await db.query(
      'UPDATE tournament_pairing_tables SET failed_start_retried_at=$3 WHERE pairing_id=$1 AND table_id=$2',
      [pairingId, tableId, now],
    )
    await db.query(
      `UPDATE tournament_pairings SET table_id=NULL, launched=false, launch_requested_at=NULL, ack_a=NULL, ack_b=NULL,
       attendance_elapsed_ms=0, attendance_observed_at=NULL,
       deadline_at=CASE WHEN deadline_at IS NOT NULL THEN $3::bigint END
       WHERE id=$1 AND table_id=$2`,
      [pairingId, tableId, now + roundDurationMs],
    )
    await db.query(
      `DELETE FROM player_table_reservations WHERE table_id=$1 AND player_id IN
       (SELECT player_id FROM tournament_entries WHERE id IN ($2,$3))`,
      [tableId, pair.entry_a, pair.entry_b],
    )
    return { status: 'queued', pairingId, tableId }
  })
}
