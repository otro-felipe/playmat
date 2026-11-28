import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { isUuid, normalize, ProductError, transaction } from './decks.mjs'
import { declaredRuntime, runtimeFields } from './player-runtime.mjs'

const profileScopes = ['play', 'library', 'chat']
const profileQuery = `SELECT p.id AS "playerId",p.display_name AS "displayName",p.flag,p.mcp_enabled AS "mcpEnabled",
  p.provider,p.model,p.reasoning_effort AS "reasoningEffort",
  g.engine_name AS "engineName",r.table_id AS "activeTableId",r.connection_id,r.reservation_id
  FROM player_profiles p JOIN agent_grants g ON g.player_id=p.id AND g.account_id=p.account_id
  LEFT JOIN player_table_reservations r ON r.player_id=p.id`

function owner(actor) {
  if (!actor?.browserSession || actor.agent) throw new ProductError(403,'A signed-in owner is required')
}

export function canonicalAccountScope(actor, scope) {
  return actor?.accountAgent === true && actor.connectionId && actor.scopes.includes(scope)
    && normalize(actor.engineName) === 'mcp_'+normalize(actor.username)
}

export async function selectOAuthPlayer(pool, actor, playerId) {
  if (!actor) return null
  if (playerId === undefined) {
    if (!canonicalAccountScope(actor,'play')) return actor
    const {rowCount} = await pool.query('SELECT 1 FROM playable_oauth_seats WHERE connection_id=$1 AND delegated LIMIT 1',[actor.connectionId])
    return rowCount ? {...actor,playerSelectionEnabled:true} : actor
  }
  if (isUuid(playerId) && playerId.toLowerCase() === actor.playerId) return actor
  if (!isUuid(playerId) || !canonicalAccountScope(actor,'play')) throw new ProductError(403,'This connection cannot select that player')
  const {rows:[row]} = await pool.query(`SELECT g.engine_name,g.scopes,p.id,p.display_name,p.flag,r.reservation_id,r.connection_id,
    r.table_id,r.started,r.cancel_pending FROM playable_oauth_seats s JOIN agent_grants g ON g.engine_key=s.engine_key
    JOIN player_profiles p ON p.id=s.player_id LEFT JOIN player_table_reservations r ON r.player_id=p.id
    WHERE s.connection_id=$1 AND s.account_id=$2 AND s.player_id=$3 AND s.delegated`,[actor.connectionId,actor.accountId,playerId])
  if (!row) throw new ProductError(403,'This connection cannot select that player')
  return {accountId:actor.accountId,username:actor.username,agent:true,connectionId:actor.connectionId,
    accountSelected:true,playerId:row.id,engineName:row.engine_name,displayName:row.display_name,flag:row.flag,
    scopes:profileScopes.filter(scope => actor.scopes.includes(scope) && row.scopes.includes(scope)),
    activeTableId:row.table_id,ownsReservation:!row.connection_id || row.connection_id === actor.connectionId,
    ...(row.connection_id === actor.connectionId ? {reservationId:row.reservation_id,reservationStarted:row.started,reservationCancelPending:row.cancel_pending} : {})}
}

function fields(input, current = {}, allowNull = true) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['displayName','flag','mcpEnabled','provider','model','reasoningEffort'].includes(key))) throw new ProductError(400,'Invalid player settings')
  const settings = {...current,...input}
  const {displayName,flag,mcpEnabled} = settings
  const name = typeof displayName === 'string' && displayName.trim().normalize('NFC')
  if (!name || [...name].length > 40 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new ProductError(400,'Provide a player name of 1 to 40 characters')
  if (flag != null && (typeof flag !== 'string' || !/^[A-Za-z]{2}$/.test(flag))) throw new ProductError(400,'Provide a two-letter country code')
  if (mcpEnabled !== undefined && typeof mcpEnabled !== 'boolean') throw new ProductError(400,'Invalid MCP permission')
  return { name, flag:flag?.toUpperCase() ?? null, enabled:mcpEnabled ?? false, ...runtimeFields(settings,allowNull) }
}

function view(row, actor) {
  const {connection_id,reservation_id,provider,model,reasoningEffort,...profile} = row
  const availability=!profile.mcpEnabled ? 'disabled' : !reservation_id ? 'available' : profile.activeTableId ? 'occupied' : 'reserved'
  return {...profile,...declaredRuntime({provider,model,reasoningEffort}),availability,
    ...(actor.playerId && connection_id === actor.connectionId ? {reservationId:reservation_id} : {})}
}

export async function listPlayers(pool, actor, availableOnly=false) {
  if (canonicalAccountScope(actor,'play')) {
    const {rows} = await pool.query(profileQuery+` WHERE EXISTS (SELECT 1 FROM playable_oauth_seats s
      WHERE s.player_id=p.id AND s.connection_id=$1 AND s.delegated) ORDER BY p.display_name,p.id`,[actor.connectionId])
    return {players:rows.map(row => view(row,actor)).filter(p=>!availableOnly || p.availability==='available')}
  }
  if (!actor?.playerId) owner(actor)
  const {rows} = await pool.query(profileQuery+` WHERE p.account_id=$1 AND p.retired_at IS NULL AND ($2::uuid IS NULL OR p.id=$2) ORDER BY p.display_name,p.id`,
    [actor.accountId,actor.playerId ?? null])
  return {players:rows.map(row => view(row,actor)).filter(p=>!availableOnly || p.availability==='available')}
}

export async function createPlayer(pool, actor, input) {
  owner(actor)
  return insertPlayer(pool,actor,fields(input))
}

export async function createPlayerSlot(pool,actor,input) {
  if (!canonicalAccountScope(actor,'players:manage')) throw new ProductError(403,'Account consent to manage player slots is required')
  const {requestId,...settings}=input??{}
  if (!isUuid(requestId) || 'mcpEnabled' in settings) throw new ProductError(400,'Provide a request ID and player settings')
  return insertPlayer(pool,actor,fields({...settings,mcpEnabled:true},{},false),requestId)
}

async function requireLivePlayerManagement(db, actor) {
  const {rowCount}=await db.query(`SELECT 1 FROM oauth_connections c
    JOIN accounts a ON a.id=c.account_id AND a.enabled
    JOIN agent_grants g ON g.engine_key=c.engine_key AND g.account_id=a.id
    WHERE c.id=$1 AND c.account_id=$2 AND c.expires_at>now() AND c.revoked_at IS NULL
      AND g.oauth_managed AND g.player_id IS NULL AND g.revoked_at IS NULL AND g.engine_key='mcp_' || a.username_key
      AND 'players:manage'=ANY(c.scopes_approved) AND 'players:manage'=ANY(g.scopes) FOR SHARE OF c,g,a`,[actor.connectionId,actor.accountId])
  if (!rowCount) throw new ProductError(403,'Player management consent is inactive')
}

async function insertPlayer(pool,actor,{name,flag,enabled,provider,model,reasoningEffort},requestId=null) {
  // Preserve the original fingerprint for requests made before runtime metadata was supported.
  const settings = provider || model || reasoningEffort ? [name,flag,provider,model,reasoningEffort] : [name,flag]
  const signature=requestId ? createHash('sha256').update(JSON.stringify(settings)).digest('hex') : null
  return transaction(pool, async db => {
    if (requestId) await requireLivePlayerManagement(db,actor)
    const id = randomUUID()
    const engine = 'mcp_p' + id.replaceAll('-','').slice(0,18)
    const inserted=await db.query(`INSERT INTO player_profiles(id,account_id,display_name,flag,mcp_enabled,creation_request,creation_signature,provider,model,reasoning_effort)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (account_id,creation_request) DO NOTHING`,
    [id,actor.accountId,name,flag,enabled,requestId,signature,provider,model,reasoningEffort])
    if (!inserted.rowCount) {
      const {rows:[prior]}=await db.query(profileQuery+' WHERE p.account_id=$1 AND p.creation_request=$2 AND p.creation_signature=$3 AND p.retired_at IS NULL',[actor.accountId,requestId,signature])
      if (!prior) throw new ProductError(409,'This request ID already belongs to another or retired player')
      return view(prior,actor)
    }
    await db.query(`INSERT INTO agent_grants(player_id,digest,account_id,engine_name,engine_key,scopes,oauth_managed,revoked_at)
      VALUES($1,$2,$3,$4,$4,$5,true,CASE WHEN $6 THEN NULL ELSE now() END)`,
      [id,randomBytes(32).toString('hex'),actor.accountId,engine,profileScopes,enabled])
    return view((await db.query(profileQuery+' WHERE p.id=$1',[id])).rows[0],actor)
  })
}

async function lockOwnedPlayer(db, actor, id) {
  if (!isUuid(id)) throw new ProductError(404,'Player not found')
  const {rows:[current]} = await db.query(profileQuery+' WHERE p.id=$1 AND p.account_id=$2 AND p.retired_at IS NULL FOR UPDATE OF p,g',[id,actor.accountId])
  if (!current) throw new ProductError(404,'Player not found')
  return current
}

async function revokePlayer(db, engineName) {
  await db.query('UPDATE agent_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE engine_key=$1',[engineName])
  await db.query('UPDATE oauth_connections SET revoked_at=now() WHERE engine_key=$1 AND revoked_at IS NULL',[engineName])
  await db.query('DELETE FROM oauth_authorization_codes WHERE engine_key=$1',[engineName])
}

export async function updatePlayer(pool, actor, id, input) {
  owner(actor)
  return transaction(pool,async db => {
    const current = await lockOwnedPlayer(db,actor,id)
    const {name,flag,enabled,provider,model,reasoningEffort} = fields(input,current)
    await db.query('UPDATE player_profiles SET display_name=$2,flag=$3,mcp_enabled=$4,provider=$5,model=$6,reasoning_effort=$7 WHERE id=$1',
      [id,name,flag,enabled,provider,model,reasoningEffort])
    if (enabled !== current.mcpEnabled) {
      if (enabled) await db.query('UPDATE agent_grants SET revoked_at=NULL WHERE player_id=$1',[id])
      else await revokePlayer(db,current.engineName)
    }
    return view((await db.query(profileQuery+' WHERE p.id=$1',[id])).rows[0],actor)
  })
}

export async function renamePlayerSlot(pool, actor, id, input) {
  if (!canonicalAccountScope(actor,'players:manage') || actor.playerId) throw new ProductError(403,'Account consent to manage player slots is required')
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'displayName'))
    throw new ProductError(400,'Provide only a display name')
  const { name } = fields(input)
  return transaction(pool,async db => {
    await requireLivePlayerManagement(db,actor)
    const current = await lockOwnedPlayer(db,actor,id)
    if (current.displayName !== name) await db.query('UPDATE player_profiles SET display_name=$2 WHERE id=$1',[id,name])
    return view((await db.query(profileQuery+' WHERE p.id=$1',[id])).rows[0],actor)
  })
}

export async function retirePlayer(pool, actor, id) {
  owner(actor)
  return transaction(pool,async db => {
    const current = await lockOwnedPlayer(db,actor,id)
    // Take a fresh snapshot after acquiring the same profile lock as reserve.
    const {rowCount} = await db.query(`SELECT 1 FROM player_table_reservations WHERE player_id=$1
      UNION ALL SELECT 1 FROM game_players seat JOIN games g ON g.id=seat.game_id JOIN matches m ON m.id=g.match_id
        WHERE seat.engine_key=$2 AND m.status='active' LIMIT 1`,[id,current.engineName])
    if (rowCount) throw new ProductError(409,'This player is reserved or has a match in progress')
    await db.query('UPDATE player_profiles SET retired_at=now(),mcp_enabled=false WHERE id=$1',[id])
    await revokePlayer(db,current.engineName)
    return {playerId:current.playerId}
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
