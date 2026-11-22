// Full packaged bridge with synthetic accounts only. The browser and both MCP clients go through Caddy.
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import { createProduct } from './product.mjs'
import { fixtureMcpFetch } from './fixture-mcp-fetch.mjs'
import { hostDeck, guestDeck, verifySideboarding } from '../mcp/test/bo3-sideboard-fixture.mjs'
import { PlaymatEngineSeat } from '../mcp/src/engine-seat.mjs'
import { createProductClient } from '../mcp/src/product.mjs'

const issuer = 'https://127.0.0.1:8080'
const base = 'http://127.0.0.1:8080'
if (process.env.PLAYMAT_SEQUENCE_LOCAL_TEST !== 'yes' || process.env.PLAYMAT_PUBLIC_URL !== issuer
    || !process.env.DATABASE_URL?.includes('@playmat-sequence-pg:5432/sequence_fixture')) {
  throw Error('This scenario requires the isolated image fixture')
}
const require = createRequire(new URL('../mcp/package.json', import.meta.url))
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'))
const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))
const humanName = 'Dual' + randomBytes(3).toString('hex')
const password = randomBytes(24).toString('hex')
const product = await createProduct({ databaseUrl: process.env.DATABASE_URL })
await product.provisionHuman(humanName, password)
await product.close()

async function form(path, input, headers = {}) {
  return fetch(base + path, { method: 'POST', redirect: 'manual', headers, body: new URLSearchParams(input) })
}
const signedIn = await form('/login', { username: humanName, password })
assert.equal(signedIn.status, 303)
const Cookie = signedIn.headers.get('set-cookie').split(';')[0]
const openBrowserSeat = () => new PlaymatEngineSeat({ engineUrl: 'ws://127.0.0.1:8080/ws', engineName: humanName,
  trustedHeader: 'X-Playmat-User', authenticationHeaders: { Cookie } })
let browser = openBrowserSeat()
const clientId = 'https://fixture.invalid/client'
const callback = 'https://fixture.invalid/callback'
async function authorizePilot(playerId) {
  const verifier = randomBytes(48).toString('base64url')
  const params = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: callback, resource: issuer+'/mcp',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: randomUUID() })
  const page = await fetch(base + '/oauth/authorize?' + params, { headers: { Cookie }, redirect:'manual' })
  assert.equal(page.status, 200)
  const request = /name="request" value="([a-f0-9-]{36})"/.exec(await page.text())?.[1]
  assert.ok(request)
  const approved = await form('/oauth/authorize', { request, decision: 'allow', ...(playerId && {playerId}) }, { Cookie, Origin: issuer })
  assert.equal(approved.status, 303)
  const redirect = new URL(approved.headers.get('location'))
  assert.equal(redirect.origin + redirect.pathname, callback)
  const exchange = await form('/oauth/token', { grant_type:'authorization_code', client_id:clientId, code:redirect.searchParams.get('code'),
    redirect_uri:callback, code_verifier:verifier, resource:issuer+'/mcp' })
  assert.equal(exchange.status, 200)
  const token = (await exchange.json()).access_token
  assert.ok(token)
  return token
}
const token = await authorizePilot()
const clients = []
async function connect(label, pilotToken = token) {
  const client = new Client({name:label,version:'1'})
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
    fetch:fixtureMcpFetch, requestInit:{ headers:{Authorization:'Bearer '+pilotToken} },
  }))
  await client.callTool({ name:'get_guide', arguments:{ bundle:true } })
  return async (tool, args = {}, expectedCode = null) => {
    const response = await client.callTool({name:tool,arguments:args})
    const text = response.content[0]?.text ?? ''
    if (!text.startsWith('{')) throw Error(tool+' returned a protocol error')
    const value = JSON.parse(text)
    if (Array.isArray(expectedCode)) {
      if (response.isError && expectedCode.includes(value.code)) return null
    } else if (expectedCode) { assert.equal(value.code, expectedCode); return }
    if (response.isError) throw Error(tool+' failed: '+value.code)
    return value
  }
}
const deck = cardName => ({ name:'Fixture', cards:[{ cardName, amount:60 }], sideboard:[] })
async function until(f, label, timeoutMs=30000) {
  const end = Date.now()+timeoutMs
  while (Date.now()<end) { const value = await f(); if (value) return value; await sleep(250) }
  throw Error('Timed out waiting for '+label)
}
async function verifyHumanControls() {
  await browser.open()
  const room = await browser.api.serverGetMainRoomId()
  const [host, rival] = await Promise.all([connect('human-controller'),connect('mcp-player')])
  async function create(mode, allowed, winsNeeded=1) {
    const table = await host('create_human_match',{mode,humanMcpAllowed:allowed,...(mode==='mcp'?{chatMode:'chatty'}:{}),format:'Pioneer',winsNeeded,name:'Dual seat fixture',deck:deck('Forest')})
    assert.ok(table.tableId)
    const list = await host('list_human_matches')
    assert.equal(list.matches.some(row=>row.tableId===table.tableId), allowed, 'Discovery includes only current enabled human seats')
    assert.ok(list.matches.every(row=>Object.keys(row).sort().join() === 'status,tableId'))
    assert.equal((await browser.api.tableIsOwner(room,table.tableId)),true,'The original browser connection still owns the new table')
    assert.equal((await (await fetch(base+'/api/playtesting/human-seat/'+table.tableId,{headers:{Cookie}})).json()).humanMcpAllowed,allowed)
    return table.tableId
  }
  // A host with an open browser can create a waiting friend table. The MCP cannot see the disabled human seat.
  const waiting = await create('friend',false)
  await host('get_game_state',{humanTableId:waiting},'human_seat_forbidden')
  await browser.api.tableRemove(room,waiting)
  const tableId = await create('mcp',true,2)
  const watchHost=base+'/api/playtesting/tables/'+tableId
  const privateResponse=await fetch(watchHost+'/spectator',{headers:{Cookie}})
  assert.equal(privateResponse.status,200)
  assert.equal((await privateResponse.json()).role,'spectator')
  const share=()=>fetch(watchHost+'/spectator-link',{method:'POST',headers:{Cookie}})
  const issued=await share()
  assert.equal(issued.status,200)
  const {path:watchPath}=await issued.json()
  assert.ok(/^\/watch\/[A-Za-z0-9_-]{43}$/.test(watchPath),'The host receives a separate public link')
  assert.ok((await (await share()).json()).path===watchPath,'Repeated sharing returns the same link')
  const watch=base+'/api/playtesting/spectate/'+watchPath.split('/').at(-1)
  assert.equal((await fetch(base+watchPath,{redirect:'manual'})).status,200,'The spectator app can open signed out')
  assert.equal((await fetch(watch,{method:'POST'})).status,405,'The anonymous channel never accepts writes')
  assert.equal((await fetch(watch,{headers:{Authorization:'Bearer '+token}})).status,403,'Agent bearer cannot use the spectator projection')
  assert.equal((await fetch(base+'/api/playtesting/spectate/'+tableId)).status,404,'Table IDs do not grant access to the feed')
  assert.ok((await rival('list_joinable_games')).invites.some(row=>row.tableId===tableId))
  await rival('join_game',{tableId,deck:deck('Mountain'),displayName:'Rival del bosque'})
  assert.equal((await host('start_match',{humanTableId:tableId})).started,true)
  const own = () => host('get_game_state',{humanTableId:tableId})
  const peer = () => rival('get_game_state')
  const accepted = [false,false]
  let gameId, browserRejected = false
  await until(async () => {
    const states = await Promise.all([own(),peer()])
    for (const [i,state] of states.entries()) {
      if (state.tableId!==tableId || !state.gameId) continue
      gameId=state.gameId
      const visible = state.ownHand ?? []
      if (visible.length) {
        assert.ok(visible.every(card=>card.name===(i===0?'Forest':'Mountain')),'Each seat sees only its own fixture hand')
        assert.ok(!JSON.stringify(state).includes('"name":"'+(i===0?'Mountain':'Forest')+'"'),'Opening projection omits the opponent deck')
      }
      const watching = browser.snapshot()
      if (i === 0 && state.decision && watching.gameId === gameId && !browserRejected) {
        // Use a real, current browser-side response. The guarded prompt must remain available to MCP.
        if (!watching.decision?.choices?.length) return false
        browser.close()
        browser = openBrowserSeat()
        await browser.open()
        const observer = await until(() => {
          const current = browser.snapshot()
          return current.gameId === gameId && current.decision?.choices?.length && current
        },'the reopened browser to observe the pending prompt')
        await browser.api.gameResync(gameId)
        const observedDecision = browser.snapshot().decision ?? observer.decision
        const pick = observedDecision.choices.find(c => /^Keep\b|^Play first\b/.test(c.label)) ?? observedDecision.choices[0]
        await assert.rejects(() => browser.respond(observedDecision.id, pick.id), error => error.code === -32001)
        await assert.rejects(() => browser.api.matchQuit(gameId), error => error.code === -32001)
        await assert.rejects(() => browser.sendChat({gameId,message:'browser cannot act'}), error => error.code === -32001)
        const after = await own()
        assert.equal(after.decision?.id,state.decision.id)
        browserRejected = true
      }
      if (browserRejected && accepted.every(Boolean) && states.every(s=>s.ownHand?.length) && watching.gameId===gameId) return true
      if (!state.decision || accepted[i] && states[1-i].decision) continue
      const choice = state.decision.choices.find(c=>/^Keep\b|^Play first\b/.test(c.label))
        ?? state.decision.choices.find(c=>c.type==='pass') ?? state.decision.choices[0]
      if (!choice) continue
      const args = { ...(i===0?{humanTableId:tableId}:{}), gameId, cursor:state.cursor, commandId:randomUUID(),
        reasoning:'Accept the current opening choice to begin the duel.',
        actions:[{kind:'choose',decisionId:state.decision.id,choiceId:choice.id}] }
      const result = await (i===0?host:rival)('play_line',args)
      assert.equal(result.appliedDecisions,1,'Each agent completes its own guarded line: '+result.status+' '+(result.reason??''))
      accepted[i]=true
    }
    return false
  },'both real seats to accept decisions with distinct private hands')
  const greetings=['¡Sí! «hola» & literal &amp;','Watch fixture rival reply']
  assert.equal((await own()).chatMode,'chatty')
  assert.equal((await peer()).chatMode,'chatty')
  const [heardHost] = await Promise.all([
    rival('wait_for_chat',{gameId,afterCursor:0,timeoutMs:5000}),
    host('send_chat',{gameId,humanTableId:tableId,message:greetings[0]}),
  ])
  assert.equal(heardHost.messages.at(-1)?.message,greetings[0])
  const [heardRival] = await Promise.all([
    host('wait_for_chat',{gameId,humanTableId:tableId,afterCursor:0,timeoutMs:5000}),
    rival('send_chat',{gameId,message:greetings[1]}),
  ])
  assert.equal(heardRival.messages.at(-1)?.message,greetings[1])
  assert.deepEqual((await rival('wait_for_chat',{gameId,afterCursor:heardHost.cursor,timeoutMs:100})).messages,[])
  const watched=await until(async()=>{
    const response=await fetch(watch)
    assert.equal(response.status,200)
    assert.match(response.headers.get('cache-control'),/no-store/)
    const state=await response.json()
    return state.gameId===gameId && state.lines.length>=2 && greetings.every(message=>state.chat.some(row=>row.message===message)) && state
  },'a public spectator to receive chat, hands and reasoning from both seats')
  assert.equal(watched.status,'playing')
  assert.equal(watched.players.length,2)
  assert.equal(watched.humanMcpName,humanName)
  assert.equal(watched.players.find(p=>p.name===humanName)?.control,'human-mcp')
  assert.equal(watched.players.find(p=>p.control==='mcp')?.displayName,'Rival del bosque')
  assert.equal(new Set(watched.lines.map(line=>line.playerId)).size,2)
  const handNames=Object.values(watched.hands).map(cards=>Object.values(cards)[0]?.name).sort()
  assert.deepEqual(handNames,['Forest','Mountain'])
  for (const internal of ['review','seatViews','canPlayObjects','lookedAt','decision']) assert.equal(watched.view[internal],undefined)
  const stream=await fetch(watch+'/events')
  assert.equal(stream.status,200)
  assert.match(stream.headers.get('content-type'),/text\/event-stream/)
  const reader=stream.body.getReader()
  try {
    let buffer=''
    while(!buffer.includes('event: snapshot\ndata:') || !buffer.endsWith('\n\n')) {
      const {done,value}=await reader.read(); assert.equal(done,false)
      buffer+=new TextDecoder().decode(value)
    }
    const event=JSON.parse(buffer.split('event: snapshot\ndata: ')[1].split('\n')[0])
    assert.ok(event.spectators>=1 && event.lines.length>=2 && event.gameId===gameId)
  } finally { await reader.cancel() }
  // In a best-of-three, resign from the seat that does not own the current decision.
  // The winning agent need not answer the opponent's concession.
  const deciding = await until(async()=> {
    const states=await Promise.all([own(),peer()])
    const chooser=states.findIndex(state=>state.decision?.choices?.length)
    return chooser >= 0 && { chooser }
  },'one seat to own a pending choice')
  const resigning = deciding.chooser===0 ? rival : host
  await resigning('concede',{...(resigning===host?{humanTableId:tableId}:{}),gameId,entireMatch:true})
  let terminalProgress=''
  await until(async () => {
    const states=await Promise.all([own(),peer(),browser.snapshot()])
    const publicStatus=JSON.stringify(states.map(({status,score})=>({status,score})))
    if (publicStatus!==terminalProgress) console.log('Duel termination '+publicStatus)
    terminalProgress=publicStatus
    if (!states.every(s=>s.status==='match_over')) return false
    assert.ok(states.every(s=>s.score?.winsNeeded===2 && s.score.wins+s.score.losses===1),'Quitting ends the best-of-three at one played game')
    assert.equal(states[0].score.wins,states[1].score.losses)
    assert.deepEqual(states[2].score,states[0].score)
    return true
  },'the completed duel')
  await until(async () => !(await host('list_human_matches')).matches.some(row=>row.tableId===tableId),'completed duel to leave discovery')
  await until(async()=>{const x=await (await fetch(watch)).json();return x.gameId===gameId && x.status==='finished'},'the same spectator link to show the completed match')
  // A browser-hosted table is read-only before an agent has ever attached to its human seat.
  const invitationPassword = randomUUID()
  const waitingForControl = await browser.api.roomCreateTable(room, {name:'Browser opt-in',gameType:'Two Player Duel',
    deckType:'Constructed - Pioneer',playerTypes:['HUMAN','COMPUTER_MAD'],humanMcpAllowed:true,winsNeeded:1,rated:false,
    spectatorsAllowed:false,password:invitationPassword})
  const webTable = waitingForControl.tableId
  assert.ok(await browser.api.roomJoinTable(room,webTable,humanName,'HUMAN',1,deck('Forest'),invitationPassword))
  assert.ok(await browser.api.roomJoinTable(room,webTable,'Goldfish','COMPUTER_MAD',2,deck('Plains'),invitationPassword))
  assert.ok(await browser.api.matchStart(room,webTable))
  const fresh = await until(()=>{const s=browser.snapshot();return s.tableId===webTable && s.status==='active' && s.gameId && s},'browser-only table display')
  await assert.rejects(()=>browser.api.matchQuit(fresh.gameId),error=>error.code===-32001)
  // Open and close the same engine transport used by the MCP service, then verify the ordinary browser
  // stays connected and cannot take over even before a replacement controller has attached.
  const actor=await createProductClient('http://127.0.0.1:8790',issuer).authorize(token)
  const temporaryController=new PlaymatEngineSeat({engineUrl:'ws://127.0.0.1:17172/ws',engineName:humanName,
    trustedHeader:'X-Playmat-User',accountId:actor.accountId,connectionId:actor.connectionId,
    recoverySeatId:'human:'+actor.accountId,humanTableId:webTable})
  try {
    await temporaryController.open()
    await until(()=>temporaryController.snapshot().gameId===fresh.gameId,'the temporary controller to see the game')
  } finally { temporaryController.close() }
  assert.equal(browser.snapshot().gameId,fresh.gameId)
  await assert.rejects(()=>browser.api.matchQuit(fresh.gameId),error=>error.code===-32001)
  assert.ok((await host('list_human_matches')).matches.some(row=>row.tableId===webTable))
  await until(async()=>{const s=await host('get_game_state',{humanTableId:webTable});return s.gameId===fresh.gameId && s.status==='active'},'agent attach to browser-created game')
  await host('concede',{humanTableId:webTable,gameId:fresh.gameId,entireMatch:true})
  await until(()=>browser.snapshot().status==='match_over','browser-created match completes')

  // Starting the lobby from a separate setup-only connection must work even though human gameplay is disabled.
  const disabled = await create('mcp',false)
  assert.equal((await fetch(base+'/api/playtesting/tables/'+disabled+'/spectator',{headers:{Cookie}})).status,403,'Ordinary player view has no private broadcast')
  await rival('join_game',{tableId:disabled,deck:deck('Mountain')})
  assert.equal((await host('start_match',{humanTableId:disabled})).started,true)
  const browserGame = await until(() => {
    const state = browser.snapshot()
    return state.tableId===disabled && state.gameId && state.gameId!==gameId && state.status==='active' && state
  },'the original browser to enter the disabled match')
  await host('get_game_state',{humanTableId:disabled,gameId:browserGame.gameId},'human_seat_forbidden')
  await browser.concede(browserGame.gameId,true)
  await until(async ()=>(await peer()).status==='match_over','the disabled match to complete')

  for (const mode of ['practice','bot']) {
    const id = await create(mode,false)
    await host('get_game_state',{humanTableId:id},'human_seat_forbidden')
    const state=await until(()=>{const state=browser.snapshot(); return state.tableId===id && state.status==='active' && state.gameId && state},mode+' browser game')
    await browser.concede(state.gameId,true)
    await until(()=>browser.snapshot().status==='match_over',mode+' complete')
  }
  console.log('Verified four modes, discovery, human and MCP decisions, isolated hands and an observer-only browser with and without an attached agent.')
}

async function verifyHumanSideboard() {
  const [human, guest] = await Promise.all([connect('human-controller'), connect('mcp-player')])
  const { tableId } = await human('create_human_match', { mode: 'mcp', humanMcpAllowed: true,
    format: 'Pioneer', winsNeeded: 2, name: 'Sideboarding via both seats', deck: hostDeck })
  await guest('join_game', { tableId, deck: guestDeck })
  const host = (name, args, retryable) => human(name, { ...args, humanTableId: tableId }, retryable)
  await host('start_match')
  await verifySideboarding(host, guest, [humanName, 'mcp_' + humanName])
  console.log('Verified a 2–1 BO3 with both seat routes, private swap receipts and two sideboard windows.')
}

try {
  if (process.env.PLAYMAT_SEQUENCE_SCENARIOS === 'human-sideboarding') await verifyHumanSideboard()
  else if (process.env.PLAYMAT_SEQUENCE_SCENARIOS === 'player-identities') {
    const { verifyPlayerIdentities } = await import('./player-identities.local.mjs')
    async function foreignCookie() {
      const other = humanName+'Other'
      const fixtureProduct = await createProduct({ databaseUrl:process.env.DATABASE_URL })
      try { await fixtureProduct.provisionHuman(other,password) } finally { await fixtureProduct.close() }
      const login = await form('/login',{username:other,password})
      assert.equal(login.status,303)
      return login.headers.get('set-cookie').split(';')[0]
    }
    async function revokeCanonical() {
      const revoked = await form('/oauth/revoke',{client_id:clientId,token})
      assert.equal(revoked.status,200)
    }
    await verifyPlayerIdentities({ base, issuer, Cookie, authorizePilot, connect, until, browser, foreignCookie, revokeCanonical })
  } else await verifyHumanControls()
} finally {
  for(const client of clients) await client.close()
  browser.close()
}
