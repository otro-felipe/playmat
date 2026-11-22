import { randomBytes, randomUUID } from 'node:crypto'
import { isUuid, normalize, ProductError, transaction } from './decks.mjs'

const profileScopes = ['play', 'library', 'chat']
const profileQuery = `SELECT p.id AS "playerId",p.display_name AS "displayName",p.flag,p.mcp_enabled AS "mcpEnabled",
  g.engine_name AS "engineName",r.table_id AS "activeTableId",r.connection_id,r.reservation_id
  FROM player_profiles p JOIN agent_grants g ON g.player_id=p.id AND g.account_id=p.account_id
  LEFT JOIN player_table_reservations r ON r.player_id=p.id`

function owner(actor) {
  if (!actor?.browserSession || actor.agent) throw new ProductError(403,'A signed-in owner is required')
}

function canonicalPlay(actor) {
  return actor?.accountAgent === true && actor.connectionId && actor.scopes.includes('play')
    && normalize(actor.engineName) === 'mcp_'+normalize(actor.username)
}

export async function selectOAuthPlayer(pool, actor, playerId) {
  if (!actor) return null
  if (playerId === undefined) {
    if (!canonicalPlay(actor)) return actor
    const {rowCount} = await pool.query('SELECT 1 FROM playable_oauth_seats WHERE connection_id=$1 AND delegated LIMIT 1',[actor.connectionId])
    return rowCount ? {...actor,playerSelectionEnabled:true} : actor
  }
  if (isUuid(playerId) && playerId.toLowerCase() === actor.playerId) return actor
  if (!isUuid(playerId) || !canonicalPlay(actor)) throw new ProductError(403,'This connection cannot select that player')
  const {rows:[row]} = await pool.query(`SELECT g.engine_name,g.scopes,p.id,p.display_name,p.flag,r.reservation_id,r.connection_id,
    r.table_id,r.started,r.cancel_pending FROM playable_oauth_seats s JOIN agent_grants g ON g.engine_key=s.engine_key
    JOIN player_profiles p ON p.id=s.player_id LEFT JOIN player_table_reservations r ON r.player_id=p.id
    WHERE s.connection_id=$1 AND s.account_id=$2 AND s.player_id=$3 AND s.delegated`,[actor.connectionId,actor.accountId,playerId])
  if (!row) throw new ProductError(403,'This connection cannot select that player')
  return {accountId:actor.accountId,username:actor.username,agent:true,connectionId:actor.connectionId,
    playerId:row.id,engineName:row.engine_name,displayName:row.display_name,flag:row.flag,
    scopes:profileScopes.filter(scope => actor.scopes.includes(scope) && row.scopes.includes(scope)),
    activeTableId:row.table_id,ownsReservation:!row.connection_id || row.connection_id === actor.connectionId,
    ...(row.connection_id === actor.connectionId ? {reservationId:row.reservation_id,reservationStarted:row.started,reservationCancelPending:row.cancel_pending} : {})}
}

function fields(input, current = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['displayName','flag','mcpEnabled'].includes(key))) throw new ProductError(400,'Invalid player settings')
  const {displayName,flag,mcpEnabled} = {...current,...input}
  const name = typeof displayName === 'string' && displayName.trim().normalize('NFC')
  if (!name || [...name].length > 40 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new ProductError(400,'Provide a player name of 1 to 40 characters')
  if (flag != null && (typeof flag !== 'string' || !/^[A-Za-z]{2}$/.test(flag))) throw new ProductError(400,'Provide a two-letter country code')
  if (mcpEnabled !== undefined && typeof mcpEnabled !== 'boolean') throw new ProductError(400,'Invalid MCP permission')
  return [name,flag?.toUpperCase() ?? null,mcpEnabled ?? false]
}

function view(row, actor) {
  const {connection_id,reservation_id,...profile} = row
  return {...profile,...(actor.playerId && connection_id === actor.connectionId ? {reservationId:reservation_id} : {})}
}

export async function listPlayers(pool, actor) {
  if (canonicalPlay(actor)) {
    const {rows} = await pool.query(profileQuery+` WHERE EXISTS (SELECT 1 FROM playable_oauth_seats s
      WHERE s.player_id=p.id AND s.connection_id=$1 AND s.delegated) ORDER BY p.display_name,p.id`,[actor.connectionId])
    return {players:rows.map(row => view(row,actor))}
  }
  if (!actor?.playerId) owner(actor)
  const {rows} = await pool.query(profileQuery+` WHERE p.account_id=$1 AND ($2::uuid IS NULL OR p.id=$2) ORDER BY p.display_name,p.id`,
    [actor.accountId,actor.playerId ?? null])
  return {players:rows.map(row => view(row,actor))}
}

export async function createPlayer(pool, actor, input) {
  owner(actor)
  const [name,flag,enabled] = fields(input)
  return transaction(pool, async db => {
    const id = randomUUID()
    const engine = 'mcp_p' + id.replaceAll('-','').slice(0,18)
    await db.query('INSERT INTO player_profiles(id,account_id,display_name,flag,mcp_enabled) VALUES($1,$2,$3,$4,$5)', [id,actor.accountId,name,flag,enabled])
    await db.query(`INSERT INTO agent_grants(player_id,digest,account_id,engine_name,engine_key,scopes,oauth_managed,revoked_at)
      VALUES($1,$2,$3,$4,$4,$5,true,CASE WHEN $6 THEN NULL ELSE now() END)`,
      [id,randomBytes(32).toString('hex'),actor.accountId,engine,profileScopes,enabled])
    return view((await db.query(profileQuery+' WHERE p.id=$1',[id])).rows[0],actor)
  })
}

export async function updatePlayer(pool, actor, id, input) {
  owner(actor)
  if (!isUuid(id)) throw new ProductError(404,'Player not found')
  return transaction(pool,async db => {
    const {rows:[current]} = await db.query(profileQuery+' WHERE p.id=$1 AND p.account_id=$2 FOR UPDATE OF p,g',[id,actor.accountId])
    if (!current) throw new ProductError(404,'Player not found')
    const [name,flag,enabled] = fields(input,current)
    await db.query('UPDATE player_profiles SET display_name=$2,flag=$3,mcp_enabled=$4 WHERE id=$1',[id,name,flag,enabled])
    if (enabled !== current.mcpEnabled) {
      await db.query('UPDATE agent_grants SET revoked_at=CASE WHEN $2 THEN NULL ELSE now() END WHERE player_id=$1',[id,enabled])
      if (!enabled) {
        await db.query('UPDATE oauth_connections SET revoked_at=now() WHERE engine_key=$1 AND revoked_at IS NULL',[current.engineName])
        await db.query('DELETE FROM oauth_authorization_codes WHERE engine_key=$1',[current.engineName])
      }
    }
    return view((await db.query(profileQuery+' WHERE p.id=$1',[id])).rows[0],actor)
  })
}

export async function profileConsent(db, actor, id) {
  owner(actor)
  if (!isUuid(id)) throw new ProductError(404,'Player not found')
  const {rows:[grant]} = await db.query(`SELECT g.engine_key,g.scopes FROM player_profiles p JOIN agent_grants g ON g.player_id=p.id
    WHERE p.id=$1 AND p.account_id=$2 AND p.mcp_enabled AND g.revoked_at IS NULL FOR SHARE OF p,g`,[id,actor.accountId])
  if (!grant) throw new ProductError(404,'Player not available for MCP')
  return grant
}
