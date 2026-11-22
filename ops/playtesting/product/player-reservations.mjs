import { isUuid, ProductError, transaction } from './decks.mjs'

export async function changeReservation(pool, actor, playerId, input) {
  if (!actor?.playerId || playerId !== actor.playerId || !actor.scopes.includes('play')) throw new ProductError(403,'This pilot cannot control that player')
  const {operation,reservationId,tableId} = input ?? {}
  if (!isUuid(reservationId) || !['reserve','bind','release'].includes(operation)
    || (operation === 'bind' ? !isUuid(tableId) : tableId !== undefined)) throw new ProductError(400,'Invalid table reservation')
  return transaction(pool,async db => {
    const {rowCount} = await db.query(`SELECT p.id FROM player_profiles p JOIN agent_grants g ON g.player_id=p.id AND g.revoked_at IS NULL
      JOIN oauth_connections c ON c.engine_key=g.engine_key AND c.account_id=p.account_id
      WHERE p.id=$1 AND p.account_id=$2 AND p.mcp_enabled AND c.id=$3 AND c.revoked_at IS NULL AND c.expires_at>now()
        AND 'play'=ANY(c.scopes_approved) FOR UPDATE OF p FOR SHARE OF g,c`,[playerId,actor.accountId,actor.connectionId])
    if (!rowCount) throw new ProductError(403,'This pilot permission is inactive')
    const {rows:[held]} = await db.query('SELECT * FROM player_table_reservations WHERE player_id=$1 FOR UPDATE',[playerId])
    if (held && (held.connection_id !== actor.connectionId || held.reservation_id !== reservationId))
      throw new ProductError(409,'This player is reserved')
    if (!held && operation === 'bind') throw new ProductError(409,'Reserve this player before binding a table')
    if (operation === 'reserve' && !held) {
      await db.query('INSERT INTO player_table_reservations(player_id,reservation_id,connection_id) VALUES($1,$2,$3)',[playerId,reservationId,actor.connectionId])
    } else if (operation === 'bind') {
      if (held.table_id && held.table_id !== tableId) throw new ProductError(409,'This player is already bound to another table')
      await db.query('UPDATE player_table_reservations SET table_id=$2,original_table_id=COALESCE(original_table_id,$2) WHERE player_id=$1',[playerId,tableId])
    } else if (operation === 'release' && held) {
      await db.query('DELETE FROM player_table_reservations WHERE player_id=$1',[playerId])
    }
    return {playerId,reservationId,tableId:operation === 'release' ? null : tableId ?? held?.table_id ?? null}
  })
}

export async function checkInvitationReservation(db, actor, tableId) {
  if (!actor.playerId) return
  const {rowCount} = await db.query('SELECT 1 FROM player_table_reservations WHERE player_id=$1 AND connection_id=$2 AND table_id=$3 FOR SHARE',
    [actor.playerId,actor.connectionId,tableId])
  if (!rowCount) throw new ProductError(403,'This pilot has no reservation for that table')
}

export async function restorePlayerReservations(db, original, replacement) {
  // Recovery calls this trusted callback only after XMage created the replacement table.
  const {rows} = await db.query(`SELECT r.player_id,r.original_table_id,r.table_id,p.mcp_enabled,
    (g.revoked_at IS NULL AND c.revoked_at IS NULL AND c.expires_at>now() AND 'play'=ANY(c.scopes_approved)) AS valid
    FROM player_table_reservations r JOIN player_profiles p ON p.id=r.player_id JOIN agent_grants g ON g.player_id=p.id
    JOIN oauth_connections c ON c.id=r.connection_id WHERE r.table_id=ANY($1::uuid[]) OR r.original_table_id=$2
    ORDER BY r.player_id FOR UPDATE OF p,r FOR SHARE OF g,c`, [[original,replacement],original])
  if (!rows.length) return
  if (rows.some(r => !r.mcp_enabled || !r.valid || (r.table_id !== original && r.original_table_id !== original && r.table_id === replacement)))
    throw new ProductError(409,'The replacement table cannot take these player seats')
  await db.query('UPDATE player_table_reservations SET table_id=$2 WHERE player_id=ANY($1::uuid[])',[rows.map(r=>r.player_id),replacement])
}
