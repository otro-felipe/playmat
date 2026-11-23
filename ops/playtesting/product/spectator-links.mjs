import { randomBytes } from 'node:crypto'
import { normalize, ProductError } from './decks.mjs'

export const newSpectatorToken = () => randomBytes(32).toString('base64url')

export async function issuePublicSpectatorLink(db, tableId, host, guest, tableName, bothHands=false) {
  const {rowCount} = await db.query(`INSERT INTO spectator_links AS link(table_id,owner_id,token,public_host,public_guest,live_table_id,table_name,hands_token)
    VALUES($1,$2,$3,$4,$5,$1,$6,$7) ON CONFLICT(table_id) DO UPDATE SET table_id=link.table_id
    WHERE link.owner_id=EXCLUDED.owner_id AND link.public_host=EXCLUDED.public_host AND link.public_guest=EXCLUDED.public_guest
      AND (link.hands_token IS NULL)=(EXCLUDED.hands_token IS NULL)`,
    [tableId,host.accountId,newSpectatorToken(),normalize(host.engineName),normalize(guest.engineName),tableName??null,bothHands?newSpectatorToken():null])
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

export async function listPublicSpectatorLinks(db,accountId) {
  const {rows}=await db.query(`SELECT l.table_id AS "tableId",(l.hands_token IS NOT NULL) AS private_enabled,
      COALESCE(NULLIF(m.name,''),l.table_name,concat_ws(' vs ',COALESCE(host.display_name,h.engine_name),COALESCE(guest.display_name,g.engine_name))) AS "tableName"
    FROM spectator_links l JOIN invitations i ON i.table_id=l.table_id AND NOT i.cancel_pending
    JOIN agent_grants h ON h.engine_key=l.public_host JOIN agent_grants g ON g.engine_key=l.public_guest
    LEFT JOIN player_profiles host ON host.id=h.player_id LEFT JOIN player_profiles guest ON guest.id=g.player_id
    LEFT JOIN LATERAL (SELECT name,status FROM matches WHERE table_id IN (l.table_id,l.live_table_id)
      ORDER BY started_at DESC LIMIT 1) m ON true
    WHERE l.owner_id=$1 AND (m.status='active' OR (m.status IS NULL AND i.expires_at>now()))
    ORDER BY l.created_at DESC,l.table_id`,[accountId])
  return {tables:rows.map(({private_enabled,...table})=>private_enabled?{...table,spectatorVisibility:'both-hands'}:table)}
}
