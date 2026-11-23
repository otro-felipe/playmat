import { randomBytes } from 'node:crypto'
import { normalize, ProductError, transaction } from './decks.mjs'

export const newSpectatorToken = () => randomBytes(32).toString('base64url')

export async function issuePublicSpectatorLink(db, tableId, host, guest, tableName, bothHands=false) {
  const {rowCount} = await db.query(`INSERT INTO spectator_links AS link(table_id,owner_id,token,public_host,public_guest,live_table_id,table_name,hands_token)
    VALUES($1,$2,$3,$4,$5,$1,$6,$7) ON CONFLICT(table_id) DO UPDATE SET public_guest=COALESCE(link.public_guest,EXCLUDED.public_guest)
    WHERE link.owner_id=EXCLUDED.owner_id AND link.public_host=EXCLUDED.public_host AND (link.public_guest IS NULL OR link.public_guest=EXCLUDED.public_guest)
      AND (link.hands_token IS NULL)=(EXCLUDED.hands_token IS NULL)`,
    [tableId,host.accountId,newSpectatorToken(),normalize(host.engineName),guest ? normalize(guest.engineName) : null,tableName??null,bothHands?newSpectatorToken():null])
  if (!rowCount) throw new ProductError(409,'This table already has a different broadcast')
}

export async function restoreSpectatorLink(db, original, replacement) {
  const {rows:[link]} = await db.query(`SELECT table_id FROM spectator_links WHERE public_host IS NOT NULL
    AND ($1=table_id OR $1=live_table_id) FOR UPDATE`,[original])
  if (!link) return
  const {rowCount} = await db.query(`SELECT 1 FROM spectator_links WHERE table_id<>$1 AND ($2=table_id OR $2=live_table_id)`,[link.table_id,replacement])
  if (rowCount) throw new ProductError(409,'The replacement table already has a broadcast')
  await db.query('UPDATE spectator_links SET live_table_id=$2 WHERE table_id=$1',[link.table_id,replacement])
}

// Freeze the invitation under the same row lock acquired by owner configuration.
// A failed or later released reservation still has observed this table's settings.
export async function freezeGuestSpectatorSettings(db, actor, tableId) {
  await db.query(`UPDATE invitations SET spectator_settings_locked=true
    WHERE table_id=$1 AND mode='friend' AND NOT cancel_pending AND creator_key<>$2
      AND (invitee_key=$2 OR (invitee_key IS NULL AND recipient_account_id=$3))`,
    [tableId,normalize(actor.engineName),actor.accountSelected ? actor.accountId : null])
}

const configurable = `i.mode='friend' AND i.claimed_at IS NULL AND NOT i.cancel_pending AND NOT i.spectator_settings_locked
  AND i.expires_at>now() AND l.live_table_id=l.table_id AND l.public_host IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.table_id=l.table_id)
  AND NOT EXISTS (SELECT 1 FROM player_table_reservations r JOIN agent_grants g ON g.player_id=r.player_id
    WHERE r.table_id=l.table_id AND g.engine_key<>l.public_host AND
      (g.engine_key=i.invitee_key OR (i.invitee_key IS NULL AND g.account_id=i.recipient_account_id)))`

export async function configureSpectatorLink(pool, tableId, accountId, visibility) {
  if (!['both-hands','public-board'].includes(visibility)) throw new ProductError(400,'Choose a spectator visibility')
  return transaction(pool,async db=>{
    // A preceding claim/reserve can commit while we wait. Evaluate eligibility in
    // a fresh statement after locking instead of using an older joined snapshot.
    const {rows:[owned]}=await db.query(`SELECT l.owner_id=$2 AS owned FROM invitations i
      JOIN spectator_links l ON l.table_id=i.table_id WHERE l.table_id=$1 AND l.public_host IS NOT NULL FOR UPDATE OF i`,[tableId,accountId])
    if (!owned?.owned) throw new ProductError(403,'Only the web host of an MCP table can configure this link')
    const {rows:[allowed]}=await db.query(`SELECT COALESCE(g.account_id,i.recipient_account_id) AS guest_owner
      FROM invitations i JOIN spectator_links l ON l.table_id=i.table_id LEFT JOIN agent_grants g ON g.engine_key=l.public_guest
      WHERE i.table_id=$1 AND ${configurable}`,[tableId])
    if (!allowed?.guest_owner) throw new ProductError(409,'Spectator settings are locked once the guest begins joining or the match starts')
    const both=visibility==='both-hands'
    await db.query('UPDATE invitations SET spectator_both_hands=$2,spectator_guest_consent_required=$3 WHERE table_id=$1',
      [tableId,both,both && allowed.guest_owner!==accountId])
    await db.query(`UPDATE spectator_links SET hands_token=CASE WHEN $2 THEN COALESCE(hands_token,$3) END WHERE table_id=$1`,
      [tableId,both,both?newSpectatorToken():null])
    return {tableId,spectatorVisibility:visibility}
  })
}

export async function listPublicSpectatorLinks(db,accountId) {
  const {rows}=await db.query(`SELECT l.table_id AS "tableId",(l.hands_token IS NOT NULL) AS private_enabled,
      (${configurable}) AS configurable,
      COALESCE(NULLIF(m.name,''),l.table_name,concat_ws(' vs ',COALESCE(host.display_name,h.engine_name),COALESCE(guest.display_name,g.engine_name))) AS "tableName"
    FROM spectator_links l JOIN invitations i ON i.table_id=l.table_id AND NOT i.cancel_pending
    JOIN agent_grants h ON h.engine_key=l.public_host LEFT JOIN agent_grants g ON g.engine_key=l.public_guest
    LEFT JOIN player_profiles host ON host.id=h.player_id LEFT JOIN player_profiles guest ON guest.id=g.player_id
    LEFT JOIN LATERAL (SELECT name,status FROM matches WHERE table_id IN (l.table_id,l.live_table_id)
      ORDER BY started_at DESC LIMIT 1) m ON true
    WHERE l.owner_id=$1 AND (m.status='active' OR (m.status IS NULL AND i.expires_at>now()))
    ORDER BY l.created_at DESC,l.table_id`,[accountId])
  return {tables:rows.map(({private_enabled,configurable,...table})=>({...table,...(configurable && {canConfigureSpectatorVisibility:true}),
    ...(private_enabled && {spectatorVisibility:'both-hands'})}))}
}
