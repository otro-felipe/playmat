import { lineText } from './line-explanations.mjs'
import { privateSpectatorBoard } from './private-spectator-board.mjs'
import { publicSpectatorBoard } from './public-spectator-board.mjs'
import { configureSpectatorLink, listPublicSpectatorLinks, newSpectatorToken } from './spectator-links.mjs'
import { isUuid, normalize, ProductError } from './decks.mjs'

const missing = () => new ProductError(404, 'Spectator match not found')
const forbidden = () => new ProductError(403, 'The browser host is required')
const sharedRoute = /^\/api\/playtesting\/spectate\/([A-Za-z0-9_-]{43})(\/events)?$/
const tableRoute = /^\/api\/playtesting\/tables\/([^/]+)\/(spectator-link|spectator)(\/events)?$/
const key = /^[A-Za-z0-9_-]{43}$/

export async function readSpectatorEngine(tableId,privateSeats=false) {
  const url = new URL('http://127.0.0.1:17173/internal/spectator')
  url.searchParams.set('table', tableId)
  if (privateSeats) url.searchParams.set('seatKnowledge','true')
  let response
  try { response = await fetch(url, { redirect:'error', signal:AbortSignal.timeout(3500) }) }
  catch { throw new ProductError(503, 'Spectator connection unavailable') }
  if (response.status === 404) return null
  if (!response.ok) throw new ProductError(503, 'Spectator connection unavailable')
  return response.json()
}

const boardFields = ['activePlayerId','activePlayerName','attackOption','bufferTime','combat','companion','exilePresentation','exiles','phase','players',
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
    async tournamentTable(tableId) {
      const {rows:[row]}=await pool.query('SELECT tournament_pairing_for_table($1) IS NOT NULL AS tournament',[tableId])
      return row.tournament
    },
    async privateToken(tableId,owner) {
      const {rows:[row]}=await pool.query(`SELECT owner_id=$2 AS owned,CASE WHEN owner_id=$2 THEN hands_token END AS token
        FROM spectator_links WHERE table_id=$1 OR live_table_id=$1`,[tableId,owner])
      if (row && !row.owned) throw forbidden()
      if (!row?.token) throw missing()
      return row.token
    },
    async existing(tableId, owner) {
      const {rows:[row]}=await pool.query('SELECT CASE WHEN owner_id=$2 THEN token END AS token FROM spectator_links WHERE table_id=$1 OR live_table_id=$1',[tableId,owner])
      if (row && !row.token) throw forbidden()
      return row?.token
    },
    async issue(tableId, owner, token) {
      const {rows:[row]} = await pool.query(`INSERT INTO spectator_links AS s(table_id,owner_id,token) VALUES($1,$2,$3)
        ON CONFLICT(table_id) DO UPDATE SET table_id=EXCLUDED.table_id WHERE s.owner_id=EXCLUDED.owner_id RETURNING token`,[tableId,owner,token])
      if (!row) throw forbidden()
      return row.token
    },
    async table(token) {
      const {rows:[row]}=await pool.query(`SELECT table_id AS id,(public_host IS NOT NULL) AS "publicBoard",(hands_token=$1) IS TRUE AS "privateSeats"
        FROM spectator_links l WHERE (token=$1 OR hands_token=$1)
        AND tournament_pairing_for_table(l.table_id) IS NULL AND tournament_pairing_for_table(l.live_table_id) IS NULL`,[token])
      return row
    },
    listOwned: accountId => listPublicSpectatorLinks(pool,accountId),
    configure:(tableId,owner,mode)=>configureSpectatorLink(pool,tableId,owner,mode),
    async publicTarget(id,capability=null) {
      const {rows:[row]}=await pool.query(`SELECT l.public_host,l.public_guest,l.live_table_id,l.token AS public_token,
        EXISTS (SELECT 1 FROM matches m WHERE m.table_id IN (l.table_id,l.live_table_id)
          AND m.status IN ('completed','interrupted')) AS terminal,
        l.hands_token=$2 AND EXISTS(SELECT 1 FROM invitations i WHERE i.table_id=l.table_id AND NOT i.cancel_pending
          AND (i.claimed_at IS NOT NULL OR i.expires_at>now())) AS private_live,
        EXISTS(SELECT 1 FROM invitations i WHERE i.table_id=l.table_id AND i.claimed_at IS NOT NULL AND NOT i.cancel_pending) AS claimed,
        EXISTS(
        SELECT 1 FROM invitations i WHERE i.table_id=l.table_id AND NOT i.cancel_pending AND i.expires_at>now()
        AND NOT EXISTS (SELECT 1 FROM matches WHERE table_id IN (l.table_id,l.live_table_id))) AS waiting
        FROM spectator_links l WHERE l.table_id=$1 AND l.public_host IS NOT NULL`,[id,capability])
      return row
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
        ARRAY(SELECT engine_key FROM agent_grants WHERE engine_key=ANY($2::text[])) AS agents,
        (SELECT json_object_agg(g.engine_key,json_build_object('displayName',p.display_name,'flag',p.flag))
         FROM agent_grants g JOIN player_profiles p ON p.id=g.player_id WHERE g.engine_key=ANY($2::text[])) AS profiles`,[tableId,names])
      return row
    },
    // After an engine restart, the same link identifies only the latest game of its own completed match.
    async finished(tableId,publicTarget) {
      const {rows:[game]}=await pool.query(`SELECT g.id,g.object_key,g.checksum,g.started_at FROM matches m JOIN games g ON g.match_id=m.id
        WHERE m.table_id=ANY($1::uuid[]) AND m.status='completed' ORDER BY g.game_number DESC LIMIT 1`,[[tableId,publicTarget?.live_table_id].filter(Boolean)])
      if (!game) return null
      const {rows:registered}=await pool.query('SELECT player_id AS "playerId",engine_name AS name FROM game_players WHERE game_id=$1 AND player_id IS NOT NULL',[game.id])
      const rows=game.object_key ? await archive.readReviewArchive(game) : []
      const lastRollback=rows.findLastIndex(row=>row.kind==='rollback')
      const frame=rows.findLast((row,index)=>index>lastRollback && row.view)
      const finish=rows.findLast((row,index)=>index>lastRollback && row.kind==='spectatorEnd')
      const rollbackRevision=rows.reduce((count,row)=>count+(row.kind==='rollback' ? 1 : 0),0)
      const players=finish?.players??registered
      const lines=[], chat=[], seen=new Set()
      for (const row of rows) {
        if (!publicTarget && row.kind==='spectatorTalk' && row.chat && players.some(player=>player.name===row.chat.playerName)) {
          chat.push(select(row.chat,['messageId','playerName','message','at']))
        }
        if (row.kind!=='line') continue
        const player=players.find(p=>p.playerId===row.actorPlayerId)
        const note=lineText(row,true)
        if (!player || !note || typeof row.commandId!=='string' || !row.commandId || row.commandId.length>120) continue
        const lineId=game.id+':'+player.playerId+':'+row.commandId
        if (seen.has(lineId)) continue
        seen.add(lineId)
        lines.push({lineId,playerId:player.playerId,playerName:player.name,...note,
          at:row.at??Number(game.started_at)+row.t,turn:row.turn??null})
      }
      if (publicTarget) return {role:'spectator',tableId,gameId:game.id,status:'finished',revision:rows.length,rollbackRevision,players,view:frame?.view,lines:lines.slice(-100).filter(line=>line.audience==='public')}
      const hands=Object.fromEntries(players.map(p=>[p.playerId,finish?.hands?.[p.playerId]??frame?.hands?.[p.name]??frame?.review?.seatViews?.[p.playerId]?.myHand??{}]))
      return {role:'spectator',tableId,gameId:game.id,status:'finished',revision:rows.length,rollbackRevision,players,view:board(frame?.view),hands,lines:lines.slice(-100),chat:chat.slice(-100)}
    },
  }
}

export function createSpectators({storage, readEngine=readSpectatorEngine}) {
  const groups=new Map(), cache=new Map(), identities=new Map()
  let connections=0
  const browser = actor=>{ if (!actor?.accountId || actor.agent) throw forbidden() }
  async function share(actor,tableId,issue=true,privateSeats=false) {
    browser(actor)
    if (!isUuid(tableId) || await storage.tournamentTable?.(tableId)) throw missing()
    if (privateSeats) return {path:'/watch/'+await storage.privateToken(tableId,actor.accountId)}
    const existing=await storage.existing?.(tableId,actor.accountId)
    if (existing) return {path:'/watch/'+existing}
    if (!issue) throw forbidden()
    const current=await readEngine(tableId)
    if (!current || !current.owner || normalize(current.owner)!==normalize(actor.username)) throw forbidden()
    return {path:'/watch/'+await storage.issue(tableId,actor.accountId,newSpectatorToken())}
  }
  async function listOwned(actor) {
    browser(actor)
    return storage.listOwned(actor.accountId)
  }
  async function publicTable(token) {
    if (!key.test(token)) throw missing()
    const target=await storage.table(token)
    if (!target) throw missing()
    return typeof target==='string' ? {id:target,publicBoard:false} : target
  }
  async function privateTableId(actor,id) {
    browser(actor)
    if (!isUuid(id) || await storage.tournamentTable?.(id) || !await storage.mayObserve(id,actor.accountId)) throw forbidden()
    return id
  }
  const channel=(id,publicBoard,capability)=>capability?'both-hands/'+capability:publicBoard?'public/'+id:id
  async function snapshot(id,publicBoard=false,privateSeats=false,capability=null) {
    const now=Date.now(), cacheKey=channel(id,publicBoard,privateSeats && capability)
    let entry=cache.get(cacheKey)
    if (privateSeats || !entry || entry.until<now) {
      entry={until:now+650, value:(async()=>{
        const target=publicBoard ? await storage.publicTarget(id,privateSeats?capability:null) : null
        if (publicBoard && !target || privateSeats && !target?.private_live) throw missing()
        const closed = () => ({role:'spectator',visibility:'closed',status:'finished',publicPath:'/watch/'+target.public_token})
        if (privateSeats && target.terminal) return closed()
        let live, unavailable
        try { live=await readEngine(target?.live_table_id??id,privateSeats && target.claimed) }
        catch (error) { if (error.status!==503) throw error; unavailable=error }
        if (privateSeats && live && live.snapshot?.tableId !== (target.live_table_id??id)) throw missing()
        let data=live?.snapshot ?? (privateSeats?null:await storage.finished?.(id,target))
        if (!data && target?.waiting && !unavailable) data={role:'spectator',tableId:id,gameId:null,status:'waiting',revision:0,players:[],view:null}
        if (!data) throw unavailable??missing()
        if (target) {
          const expected=[target.public_host,target.public_guest]
          const names=new Set([...(data.players??[]),...(data.view?.players??[])].map(p=>normalize(p.name)))
          if ((live && normalize(live.owner)!==target.public_host) || [...names].some(name=>!expected.includes(name))
              || (data.view && !expected.every(name=>names.has(name)))) throw missing()
        }
        if (privateSeats && live && data.status==='finished') return closed()
        // Archived games are immutable. Retain their projected final frame, not the full replay.
        if (!live && data.status==='finished' && data.view) entry.until=Date.now()+300000
        const view=board(data.view)
        const project = frame => {
          if (privateSeats) {
            if (frame.status==='playing' && !target.claimed) throw missing()
            return privateSpectatorBoard({...frame,tableId:id})
          }
          if (publicBoard) return publicSpectatorBoard({...frame,tableId:id})
          const {seatKnowledge,...legacy}=frame
          return legacy
        }
        if (!storage.presentation) return project({...data,view})
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
          const profile=roles.profiles?.[name]
          const displayName=profile?.displayName ?? (roles.guest===name ? roles.alias : null)
          return {...player,control,...(displayName?{displayName}:{}),...(profile?.flag ? {flag:profile.flag} : {})}
        })
        return project({...data,view,players,...(roles.delegated?{humanMcpName:roles.delegated}:{})})
      })()}
      cache.set(cacheKey,entry)
      if (cache.size>32) cache.delete(cache.keys().next().value)
    }
    const data=await entry.value
    return data.visibility==='closed'?data:{...data,spectators:groups.get(cacheKey)?.size??0}
  }
  function publish(id,res,publicBoard=false,privateSeats=false,capability=null) {
    const cacheKey=channel(id,publicBoard,privateSeats && capability)
    if (connections>=256 || (groups.get(cacheKey)?.size??0)>=100) throw new ProductError(429,'Spectator limit reached')
    let group=groups.get(cacheKey)
    if (!group) groups.set(cacheKey,group=new Set())
    group.add(res)
    connections++
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Accel-Buffering':'no'})
    res.write('retry: 2000\n\n')
    const remove=()=>{if (group.delete(res)) connections--; if (!group.size) groups.delete(cacheKey)}
    res.once('close',remove)
    let last, busy=false
    const update=async()=>{
      if (busy || res.destroyed) return
      busy=true
      try {
        const data=await snapshot(id,publicBoard,privateSeats,capability)
        const revision=[data.gameId,data.status,data.revision,data.rollbackRevision??0,data.spectators].join('/')
        if (revision!==last) {
          last=revision
          if (!res.write('event: snapshot\ndata: '+JSON.stringify(data)+'\n\n') && res.writableLength>2*1024*1024) res.destroy()
          if (data.visibility==='closed') res.end()
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
  async function configure(actor,tableId,mode) {
    browser(actor)
    if (!isUuid(tableId)) throw missing()
    return storage.configure(tableId,actor.accountId,mode)
  }
  return { share,configure,listOwned,publicTable,publicTableId:async token=>(await publicTable(token)).id,privateTableId,snapshot,publish,close }
}

export async function spectatorRoute(req,res,path,resolveActor,spectators,send,readBody) {
  const shared=sharedRoute.exec(path), table=tableRoute.exec(path)
  const list=path==='/api/playtesting/tables/spectator-links'
  if (!shared && !table && !list) {
    if (path.startsWith('/api/playtesting/spectate/')) throw missing()
    return false
  }
  res.setHeader('Cache-Control','no-store')
  res.setHeader('Referrer-Policy','no-referrer')
  if (req.headers.authorization) throw forbidden()
  if (list) {
    if (req.method!=='GET') throw new ProductError(405,'Use GET')
    send(res,200,await spectators.listOwned(await resolveActor(req)))
  } else if (table?.[2]==='spectator-link') {
    if (!table[3] && req.method==='PATCH') {
      const actor=await resolveActor(req)
      send(res,200,await spectators.configure(actor,table[1],(await readBody(req))?.spectatorVisibility))
      return true
    }
    if (table[3] || !['GET','POST'].includes(req.method)) throw new ProductError(405,'Use GET, POST or PATCH')
    const mode=new URL(req.url,'http://localhost').searchParams.get('visibility')
    if (mode!==null && !['public-board','both-hands'].includes(mode)) throw missing()
    send(res,200,await spectators.share(await resolveActor(req),table[1],req.method==='POST',mode==='both-hands'))
  } else {
    if (req.method!=='GET') throw new ProductError(405,'Use GET')
    const {id,publicBoard,privateSeats}=shared ? await spectators.publicTable(shared[1]) : {id:await spectators.privateTableId(await resolveActor(req),table[1])}
    const data=await spectators.snapshot(id,publicBoard,privateSeats,privateSeats?shared[1]:null)
    if (shared?.[2] || table?.[3]) spectators.publish(id,res,publicBoard,privateSeats,privateSeats?shared[1]:null)
    else send(res,200,data)
  }
  return true
}
