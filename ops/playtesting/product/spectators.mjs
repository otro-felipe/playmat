import { randomBytes } from 'node:crypto'
import { isUuid, normalize, ProductError } from './decks.mjs'

const missing = () => new ProductError(404, 'Spectator match not found')
const forbidden = () => new ProductError(403, 'The browser host is required')
const sharedRoute = /^\/api\/playtesting\/spectate\/([A-Za-z0-9_-]{43})(\/events)?$/
const tableRoute = /^\/api\/playtesting\/tables\/([^/]+)\/(spectator-link|spectator)(\/events)?$/
const key = /^[A-Za-z0-9_-]{43}$/

async function engine(tableId) {
  const url = new URL('http://127.0.0.1:17173/internal/spectator')
  url.searchParams.set('table', tableId)
  let response
  try { response = await fetch(url, { redirect:'error', signal:AbortSignal.timeout(3500) }) }
  catch { throw new ProductError(503, 'Spectator connection unavailable') }
  if (response.status === 404) return null
  if (!response.ok) throw new ProductError(503, 'Spectator connection unavailable')
  return response.json()
}

const boardFields = ['activePlayerId','activePlayerName','attackOption','bufferTime','combat','companion','exiles','phase','players',
  'priorityPlayerName','priorityTime','rangeOfInfluence','revealed','stack','step','turn']
const playerFields = ['attachments','battlefield','commandList','controlled','counters','designationNames','exile','graveyard','handCount','hasLeft',
  'hasPriority','initiative','isActive','isHuman','libraryCount','life','manaPool','monarch','name','playerId','topCard','wins','winsNeeded']
const select = (source, fields) => Object.fromEntries(fields.filter(field => Object.hasOwn(source,field)).map(field => [field,source[field]]))
function board(view) {
  if (!view) return null
  return {...select(view,boardFields),players:(view.players??[]).map(player=>select(player,playerFields))}
}

export function spectatorStorage(pool, archive) {
  return {
    async existing(tableId, owner) {
      const {rows:[row]}=await pool.query('SELECT token FROM spectator_links WHERE table_id=$1 AND owner_id=$2',[tableId,owner])
      return row?.token
    },
    async issue(tableId, owner, token) {
      const {rows:[row]} = await pool.query(`INSERT INTO spectator_links AS s(table_id,owner_id,token) VALUES($1,$2,$3)
        ON CONFLICT(table_id) DO UPDATE SET table_id=EXCLUDED.table_id WHERE s.owner_id=EXCLUDED.owner_id RETURNING token`,[tableId,owner,token])
      if (!row) throw forbidden()
      return row.token
    },
    async table(token) {
      const {rows:[row]}=await pool.query('SELECT table_id FROM spectator_links WHERE token=$1',[token])
      return row?.table_id
    },
    async mayObserve(tableId, accountId) {
      const {rowCount}=await pool.query('SELECT 1 FROM human_match_seats WHERE table_id=$1 AND account_id=$2 AND allowed',[tableId,accountId])
      return rowCount===1
    },
    async presentation(tableId, players) {
      const names=players.map(player=>normalize(player.name))
      const {rows:[row]}=await pool.query(`SELECT
        (SELECT a.username FROM human_match_seats h JOIN accounts a ON a.id=h.account_id
          WHERE h.table_id=$1 AND h.allowed) AS delegated,
        (SELECT invitee_key FROM invitations WHERE table_id=$1 AND mode='mcp' AND claimed_at IS NOT NULL) AS guest,
        (SELECT guest_display_name FROM invitations WHERE table_id=$1 AND mode='mcp' AND claimed_at IS NOT NULL) AS alias,
        ARRAY(SELECT engine_key FROM agent_grants WHERE engine_key=ANY($2::text[])) AS agents`,[tableId,names])
      return row
    },
    // After an engine restart, the same link identifies only the latest game of its own completed match.
    async finished(tableId) {
      const {rows:[game]}=await pool.query(`SELECT g.id,g.object_key,g.checksum,g.started_at FROM matches m JOIN games g ON g.match_id=m.id
        WHERE m.table_id=$1 AND m.status='completed' ORDER BY g.game_number DESC LIMIT 1`,[tableId])
      if (!game) return null
      const {rows:registered}=await pool.query('SELECT player_id AS "playerId",engine_name AS name FROM game_players WHERE game_id=$1 AND player_id IS NOT NULL',[game.id])
      const rows=game.object_key ? await archive.readReviewArchive(game) : []
      const frame=rows.findLast(r=>r.view)
      const finish=rows.findLast(r=>r.kind==='spectatorEnd')
      const players=finish?.players??registered
      const lines=[], chat=[]
      for (const row of rows) {
        if (row.kind==='spectatorTalk' && row.chat && players.some(player=>player.name===row.chat.playerName)) {
          chat.push(select(row.chat,['messageId','playerName','message','at']))
        }
        if (row.kind!=='line') continue
        const player=players.find(p=>p.playerId===row.actorPlayerId)
        if (player) lines.push({lineId:game.id+':'+player.playerId+':'+row.commandId, playerId:player.playerId,playerName:player.name,
          reasoning:row.reasoning,at:row.at??Number(game.started_at)+row.t,turn:row.turn??null})
      }
      const hands=Object.fromEntries(players.map(p=>[p.playerId,finish?.hands?.[p.playerId]??frame?.hands?.[p.name]??frame?.review?.seatViews?.[p.playerId]?.myHand??{}]))
      return {role:'spectator',tableId,gameId:game.id,status:'finished',revision:rows.length,players,view:board(frame?.view),hands,lines:lines.slice(-100),chat:chat.slice(-100)}
    },
  }
}

export function createSpectators({storage, readEngine=engine}) {
  const groups=new Map(), cache=new Map(), identities=new Map()
  let connections=0
  const browser = actor=>{ if (!actor?.accountId || actor.agent) throw forbidden() }
  async function share(actor,tableId) {
    browser(actor)
    if (!isUuid(tableId)) throw missing()
    const existing=await storage.existing?.(tableId,actor.accountId)
    if (existing) return {path:'/watch/'+existing}
    const current=await readEngine(tableId)
    if (!current || !current.owner || normalize(current.owner)!==normalize(actor.username)) throw forbidden()
    return {path:'/watch/'+await storage.issue(tableId,actor.accountId,randomBytes(32).toString('base64url'))}
  }
  async function publicTableId(token) {
    if (!key.test(token)) throw missing()
    const id=await storage.table(token)
    if (!id) throw missing()
    return id
  }
  async function privateTableId(actor,id) {
    browser(actor)
    if (!isUuid(id) || !await storage.mayObserve(id,actor.accountId)) throw forbidden()
    return id
  }
  async function snapshot(id) {
    const now=Date.now()
    let entry=cache.get(id)
    if (!entry || entry.until<now) {
      entry={until:now+650, value:(async()=>{
        let live, unavailable
        try { live=await readEngine(id) }
        catch (error) { if (error.status!==503) throw error; unavailable=error }
        const data=live?.snapshot ?? await storage.finished?.(id)
        if (!data) throw unavailable??missing()
        // Archived games are immutable. Retain their projected final frame, not the full replay.
        if (!live && data.status==='finished' && data.view) entry.until=Date.now()+300000
        const view=board(data.view)
        if (!storage.presentation) return {...data,view}
        const identityKey=data.gameId && data.players?.length ? id+'/'+data.gameId : null
        let roles=identities.get(identityKey)
        if (!roles) {
          roles=await storage.presentation(id,data.players??[])
          if (identityKey) identities.set(identityKey,roles)
          if (identities.size>128) identities.delete(identities.keys().next().value)
        }
        const players=(data.players??[]).map(player=>{
          const name=normalize(player.name)
          const gamePlayer=view?.players.find(item=>item.playerId===player.playerId)
          const control=roles.delegated && name===normalize(roles.delegated) ? 'human-mcp'
            : roles.agents.includes(name) || roles.guest===name ? 'mcp' : gamePlayer?.isHuman===false ? 'bot' : 'human'
          const displayName=roles.guest===name ? roles.alias : null
          return {...player,control,...(displayName?{displayName}:{})}
        })
        return {...data,view,players,...(roles.delegated?{humanMcpName:roles.delegated}:{})}
      })()}
      cache.set(id,entry)
      if (cache.size>32) cache.delete(cache.keys().next().value)
    }
    return {...await entry.value,spectators:groups.get(id)?.size??0}
  }
  function publish(id,res) {
    if (connections>=256 || (groups.get(id)?.size??0)>=100) throw new ProductError(429,'Spectator limit reached')
    let group=groups.get(id)
    if (!group) groups.set(id,group=new Set())
    group.add(res)
    connections++
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Accel-Buffering':'no'})
    res.write('retry: 2000\n\n')
    const remove=()=>{if (group.delete(res)) connections--; if (!group.size) groups.delete(id)}
    res.once('close',remove)
    let last, busy=false
    const update=async()=>{
      if (busy || res.destroyed) return
      busy=true
      try {
        const data=await snapshot(id)
        const revision=[data.gameId,data.status,data.revision,data.spectators].join('/')
        if (revision!==last) {
          last=revision
          if (!res.write('event: snapshot\ndata: '+JSON.stringify(data)+'\n\n') && res.writableLength>2*1024*1024) res.destroy()
        }
      } catch { res.end() }
      finally { busy=false }
    }
    const timer=setInterval(update,900)
    const heartbeat=setInterval(()=>{if (!res.destroyed) res.write(': heartbeat\n\n')},15000)
    res.once('close',()=>{clearInterval(timer);clearInterval(heartbeat)})
    void update()
  }
  function close(){ for(const group of groups.values()) for(const res of group) res.end(); cache.clear(); identities.clear() }
  return { share,publicTableId,privateTableId,snapshot,publish,close }
}

export async function spectatorRoute(req,res,path,resolveActor,spectators,send) {
  const shared=sharedRoute.exec(path), table=tableRoute.exec(path)
  if (!shared && !table) {
    if (path.startsWith('/api/playtesting/spectate/')) throw missing()
    return false
  }
  res.setHeader('Cache-Control','no-store')
  res.setHeader('Referrer-Policy','no-referrer')
  if (req.headers.authorization) throw forbidden()
  if (table?.[2]==='spectator-link') {
    if (table[3] || req.method!=='POST') throw new ProductError(405,'Use POST')
    send(res,200,await spectators.share(await resolveActor(req),table[1]))
  } else {
    if (req.method!=='GET') throw new ProductError(405,'Use GET')
    const id=shared?await spectators.publicTableId(shared[1]):await spectators.privateTableId(await resolveActor(req),table[1])
    const data=await spectators.snapshot(id)
    if (shared?.[2] || table?.[3]) spectators.publish(id,res)
    else send(res,200,data)
  }
  return true
}
