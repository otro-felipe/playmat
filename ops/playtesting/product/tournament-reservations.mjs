import { isUuid, ProductError, transaction } from './decks.mjs'
import { authorizeTournamentManagement } from './tournament-access.mjs'

const changed = () => new ProductError(409, 'The tournament reservation cannot be verified for release')

const closedAssignment = `
  SELECT p.tournament_id,p.id AS pairing_id,p.table_id
  FROM tournament_pairing_tables physical
  JOIN tournament_pairings p ON p.id=physical.pairing_id AND p.table_id=physical.table_id
  JOIN tournaments t ON t.id=p.tournament_id
  JOIN tournament_entries e ON e.id IN (p.entry_a,p.entry_b) AND e.tournament_id=t.id
  JOIN matches archived ON archived.id=p.match_id AND archived.table_id=physical.table_id
  WHERE t.status='finished' AND p.completed AND p.result_reason='played'
    AND archived.status='completed' AND archived.ended_at IS NOT NULL
    AND physical.failed_start_retried_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM tournament_pairing_tables mapped JOIN matches m ON m.table_id=mapped.table_id
      WHERE mapped.pairing_id=p.id AND (m.status='active'
        OR EXISTS (SELECT 1 FROM games g WHERE g.match_id=m.id AND g.status='active'))
    )
`

async function requireOrganizer(db, actor, tournamentId) {
  await authorizeTournamentManagement(db, actor)
  const { rowCount } = await db.query(
    'SELECT id FROM tournaments WHERE id=$1 AND organizer_id=$2 FOR SHARE',
    [tournamentId, actor.accountId],
  )
  if (!rowCount) throw new ProductError(404, 'Tournament unavailable to this organizer')
}

export async function inspectTournamentReservations(pool, actor, tournamentId) {
  return transaction(pool, async (db) => {
    await requireOrganizer(db, actor, tournamentId)
    const { rows } = await db.query(
      `SELECT profile.id AS "participantId",profile.display_name AS "displayName",
        CASE
          WHEN NOT profile.mcp_enabled OR profile.retired_at IS NOT NULL THEN 'disabled'
          WHEN lease.reservation_id IS NULL THEN 'available'
          WHEN lease.table_id IS NULL THEN 'reserved'
          WHEN previous.pairing_id IS NULL THEN 'occupied'
          ELSE 'stale'
        END AS status,
        previous.tournament_id AS "tournamentId",previous.pairing_id AS "pairingId",
        previous.table_id AS "tableId",lease.reservation_id AS "expectedReservationId"
      FROM tournament_entries entry
      JOIN player_profiles profile ON profile.id=entry.player_id AND profile.account_id=entry.owner_id
      LEFT JOIN player_table_reservations lease ON lease.player_id=profile.id
      LEFT JOIN LATERAL (
        ${closedAssignment}
        AND p.table_id=lease.table_id AND lease.table_id=lease.original_table_id AND NOT lease.cancel_pending
        AND e.player_id=profile.id AND e.owner_id=profile.account_id AND t.organizer_id=profile.account_id
      ) previous ON true
      WHERE entry.tournament_id=$1 AND entry.owner_id=$2
      ORDER BY profile.display_name,profile.id`,
      [tournamentId, actor.accountId],
    )
    const participants = rows.map(({ participantId, displayName, status, ...expected }) => ({
      participantId, displayName, status,
      ...(status === 'stale' && { release: { ...expected, participantId } }),
    }))
    return { tournamentId: tournamentId.toLowerCase(), participants }
  })
}

export async function releaseStaleTournamentReservation(pool, actor, tournamentId, input) {
  const fields = ['pairingId', 'participantId', 'tableId', 'expectedReservationId']
  if (Object.keys(input).length !== fields.length || !fields.every(key => isUuid(input[key])))
    throw new ProductError(400, 'Provide the exact pairing, participant, table and expected reservation IDs')
  const [pairingId, participantId, tableId, expectedReservationId] = fields.map(key => input[key].toLowerCase())
  return transaction(pool, async (db) => {
    await requireOrganizer(db, actor, tournamentId)
    // Share normal reservation operations' profile lock and verify the exact old assignment.
    const { rowCount: owned } = await db.query(
      'SELECT id FROM player_profiles WHERE id=$1 AND account_id=$2 AND mcp_enabled AND retired_at IS NULL FOR UPDATE',
      [participantId, actor.accountId],
    )
    if (!owned) throw new ProductError(404, 'Participant unavailable to this organizer')
    const { rowCount: ended } = await db.query(
      `${closedAssignment}
      AND p.tournament_id=$1 AND p.id=$2 AND p.table_id=$3 AND e.player_id=$4 AND e.owner_id=$5
      FOR SHARE OF physical,p,e,archived`,
      [tournamentId, pairingId, tableId, participantId, actor.accountId],
    )
    if (!ended) throw changed()
    const { rows: [lease] } = await db.query(
      'SELECT reservation_id,table_id,original_table_id,cancel_pending FROM player_table_reservations WHERE player_id=$1 FOR UPDATE',
      [participantId],
    )
    const receipt = { tournamentId: tournamentId.toLowerCase(), pairingId, participantId, tableId }
    if (!lease) return { ...receipt, status: 'already_clear' }
    if (lease.reservation_id !== expectedReservationId || lease.table_id !== tableId ||
        lease.original_table_id !== tableId || lease.cancel_pending) throw changed()
    const { rowCount } = await db.query(
      'DELETE FROM player_table_reservations WHERE player_id=$1 AND reservation_id=$2 AND table_id=$3',
      [participantId, expectedReservationId, tableId],
    )
    if (rowCount !== 1) throw changed()
    return { ...receipt, status: 'released' }
  })
}
