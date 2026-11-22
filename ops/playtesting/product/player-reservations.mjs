import { isUuid, normalize, ProductError, transaction } from './decks.mjs'

const operations = new Set(['reserve','begin','bind','release','lock_cancel','cancel'])

async function assertNoActiveMatch(db, held) {
  const {rowCount} = await db.query("SELECT 1 FROM matches WHERE table_id=ANY($1::uuid[]) AND status='active' LIMIT 1",
    [[held.table_id,held.original_table_id]])
  if (rowCount) throw new ProductError(409,'This player has a match in progress')
}

async function lockWaitingTable(db, actor, held) {
  await assertNoActiveMatch(db, held)
  const {rows:[invite]} = await db.query('SELECT creator_key, claimed_at FROM invitations WHERE table_id=$1 FOR UPDATE',[held.table_id])
  if (invite && (invite.creator_key !== normalize(actor.engineName) || invite.claimed_at))
    throw new ProductError(409,'Only the host can cancel an unclaimed invitation')
  await db.query('UPDATE invitations SET cancel_pending=true WHERE table_id=$1',[held.table_id])
  await db.query('UPDATE player_table_reservations SET cancel_pending=true WHERE player_id=$1',[actor.playerId])
}

export async function changeReservation(pool, actor, playerId, input) {
  if (!actor?.playerId || playerId !== actor.playerId || !actor.scopes.includes('play')) throw new ProductError(403,'This pilot cannot control that player')
  const {operation,reservationId,tableId} = input ?? {}
  const requiresTable = operation === 'bind' || operation === 'lock_cancel'
  if (!isUuid(reservationId) || !operations.has(operation) || (requiresTable && !isUuid(tableId))
    || (tableId !== undefined && (!isUuid(tableId) || (!requiresTable && operation !== 'cancel'))))
    throw new ProductError(400,'Invalid table reservation')
  return transaction(pool,async db => {
    const {rowCount} = await db.query(`SELECT p.id FROM player_profiles p JOIN agent_grants g ON g.player_id=p.id AND g.revoked_at IS NULL
      JOIN playable_oauth_seats s ON s.player_id=p.id AND s.account_id=p.account_id
      JOIN oauth_connections c ON c.id=s.connection_id
      WHERE p.id=$1 AND p.account_id=$2 AND p.mcp_enabled AND c.id=$3 AND c.revoked_at IS NULL AND c.expires_at>now()
        AND 'play'=ANY(c.scopes_approved) FOR UPDATE OF p FOR SHARE OF g,c`,[playerId,actor.accountId,actor.connectionId])
    if (!rowCount) throw new ProductError(403,'This pilot permission is inactive')
    const {rows:[held]} = await db.query('SELECT * FROM player_table_reservations WHERE player_id=$1 FOR UPDATE',[playerId])
    if (held && (held.connection_id !== actor.connectionId || held.reservation_id !== reservationId))
      throw new ProductError(409,'This player is reserved')
    if (!held && !['reserve','release','cancel'].includes(operation)) throw new ProductError(409,'Reserve this player first')
    if (held?.cancel_pending && operation !== 'lock_cancel' && operation !== 'cancel') throw new ProductError(409,'Cancellation in progress')
    if (operation === 'reserve' && !held) {
      await db.query('INSERT INTO player_table_reservations(player_id,reservation_id,connection_id) VALUES($1,$2,$3)',[playerId,reservationId,actor.connectionId])
    } else if (operation === 'begin') {
      await db.query('UPDATE player_table_reservations SET started=true WHERE player_id=$1',[playerId])
    } else if (operation === 'bind') {
      if (held.table_id && held.table_id !== tableId) throw new ProductError(409,'This player is already bound to another table')
      await db.query('UPDATE player_table_reservations SET table_id=$2,original_table_id=COALESCE(original_table_id,$2) WHERE player_id=$1',[playerId,tableId])
    } else if (operation === 'lock_cancel') {
      if (tableId !== held.table_id) throw new ProductError(409,'The waiting table changed')
      await lockWaitingTable(db,actor,held)
    } else if ((operation === 'release' || operation === 'cancel') && held) {
      await assertNoActiveMatch(db,held)
      if (operation === 'release' && held.table_id) {
        const {rowCount} = await db.query('SELECT 1 FROM invitations WHERE table_id=$1 AND claimed_at IS NOT NULL FOR SHARE',[held.table_id])
        if (rowCount) throw new ProductError(409,'The claimed table must finish before releasing this player')
      }
      if (operation === 'cancel') {
        if (held.table_id ? !held.cancel_pending || held.table_id !== tableId : held.started || tableId !== undefined)
          throw new ProductError(409,'The engine must confirm this waiting table before cancellation')
        if (held.table_id) {
          await db.query('DELETE FROM invitations WHERE table_id=$1 AND cancel_pending AND claimed_at IS NULL',[held.table_id])
          await db.query('DELETE FROM spectator_links WHERE public_host IS NOT NULL AND (table_id=$1 OR live_table_id=$1)',[held.table_id])
        }
      }
      await db.query('DELETE FROM player_table_reservations WHERE player_id=$1',[playerId])
    }
    return {playerId,reservationId,tableId:['release','cancel'].includes(operation) ? null : tableId ?? held?.table_id ?? null}
  })
}

export async function checkInvitationReservation(db, actor, tableId) {
  if (!actor.playerId) return
  const {rowCount} = await db.query('SELECT 1 FROM player_table_reservations WHERE player_id=$1 AND connection_id=$2 AND table_id=$3 AND NOT cancel_pending FOR SHARE',
    [actor.playerId,actor.connectionId,tableId])
  if (!rowCount) throw new ProductError(403,'This pilot has no reservation for that table')
}

export async function restorePlayerReservations(db, original, replacement) {
  // Recovery calls this trusted callback only after XMage created the replacement table.
  const {rows} = await db.query(`SELECT r.player_id,r.original_table_id,r.table_id,r.cancel_pending,p.mcp_enabled,
    EXISTS (SELECT 1 FROM playable_oauth_seats s WHERE s.player_id=r.player_id AND s.connection_id=c.id) AS valid
    FROM player_table_reservations r JOIN player_profiles p ON p.id=r.player_id JOIN agent_grants g ON g.player_id=p.id
    JOIN oauth_connections c ON c.id=r.connection_id WHERE r.table_id=ANY($1::uuid[]) OR r.original_table_id=$2
    ORDER BY r.player_id FOR UPDATE OF p,r FOR SHARE OF g,c`, [[original,replacement],original])
  if (!rows.length) return
  if (rows.some(r => r.cancel_pending || !r.mcp_enabled || !r.valid || (r.table_id !== original && r.original_table_id !== original && r.table_id === replacement)))
    throw new ProductError(409,'The replacement table cannot take these player seats')
  await db.query('UPDATE player_table_reservations SET table_id=$2 WHERE player_id=ANY($1::uuid[])',[rows.map(r=>r.player_id),replacement])
}
