import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProductClient } from '../src/product.mjs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createMcpServer } from '../src/server.mjs'

test('selected tournament seat survives join, resumed waits and library operations on the product boundary', async t => {
  const calls = []
  const app = createServer(async (req, res) => {
    let raw = ''; for await (const x of req) raw += x
    calls.push([req.method,req.url,req.headers['x-playmat-player-id'],raw && JSON.parse(raw)])
    res.writeHead(200, {'content-type':'application/json'}); res.end('{}')
  }).listen(0,'127.0.0.1')
  await once(app,'listening'); t.after(()=>app.close())
  const client = createProductClient('http://127.0.0.1:' + app.address().port)
  const call = (name, args) => client.operation('fixture',name,args,'player')
  await call('list_tournaments',{})
  await call('get_tournament',{tournamentId:'cup'})
  await call('join_tournament',{tournamentId:'cup',deckId:'elves'})
  await call('wait_for_next_round',{tournamentId:'cup'})
  await call('list_decks',{library:'private'})
  assert.deepEqual(calls,[
    ['GET','/api/playtesting/tournaments','player',''],
    ['GET','/api/playtesting/tournaments/cup','player',''],
    ['POST','/api/playtesting/tournaments/cup/join','player',{deckId:'elves'}],
    ['POST','/api/playtesting/tournaments/cup/wait','player',{}],
    ['GET','/api/playtesting/decks?library=private','player',''],
  ])
})

test('public MCP tournament reads page standings, select a round and follow deck publication', async t => {
  const tournamentId = randomUUID(), entryId = randomUUID()
  const event = {
    name: 'Practice', status: 'running', roundNumber: 2, standings: [{id: randomUUID()}, {id: entryId}],
    pairings: [{roundNumber: 1}, {roundNumber: 2}], deckLists: [],
  }
  const server = createMcpServer({
    authorize: async () => ({ accountId: 'owner', engineName: 'Fixture', scopes: ['play'], playerSelectionEnabled: true }),
    product: async (_token, operation, args) => {
      assert.equal(operation, 'get_tournament')
      assert.equal(args.tournamentId, tournamentId)
      return event
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const client = new Client({ name: 'tournament-reader', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + server.address().port + '/mcp'), {
    requestInit: { headers: { Authorization: 'Bearer synthetic' } },
  }))
  t.after(() => client.close())
  async function read(args) {
    const reply = await client.callTool({name: 'get_tournament', arguments: { tournamentId, ...args }})
    return JSON.parse(reply.content[0].text)
  }
  const page = await read({offset: 1, limit: 1})
  assert.equal(page.total, 2)
  assert.deepEqual(page.standings, [{id: entryId}])
  assert.deepEqual((await read({section: 'pairings'})).pairings, [event.pairings[1]])
  assert.deepEqual((await read({section: 'pairings', roundNumber: 1})).pairings, [event.pairings[0]])
  assert.equal((await read({section: 'deck', entryId})).code, 'not_found')
  event.deckLists.push({entryId, cards: [{cardName: 'Forest', amount: 60}], sideboard: []})
  assert.deepEqual((await read({section: 'deck', entryId})).deck, event.deckLists[0])
})

test('tournament waits check membership and never open or take over an unrelated engine seat', async t => {
  const {createMcpServer}=await import('../src/server.mjs')
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js')
  const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const {randomUUID}=await import('node:crypto')
  const tournamentId=randomUUID(), actor={accountId:randomUUID(),connectionId:randomUUID(),engineName:'TournamentFixture',scopes:['play'],ownsReservation:true,playerId:randomUUID()}
  let status='unregistered',opens=0
  const mcp=createMcpServer({authorize:async()=>actor,createEngine:()=>{opens++;throw new Error('unexpected engine connection')},
    product:async()=>{if(status==='unregistered') throw Error('unknown membership');return {state:status}}})
  mcp.listen(0,'127.0.0.1');await once(mcp,'listening')
  const client=new Client({name:'inactive-cup',version:'1'})
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+mcp.address().port+'/mcp'),{requestInit:{headers:{authorization:'Bearer fixture'}}}))
  t.after(async()=>{await client.close();mcp.closeAllConnections();mcp.close()})
  for(const state of ['unregistered','paused','finished','busy','registration']){
    status=state
    const result=await client.callTool({name:'wait_for_next_round',arguments:{playerId:actor.playerId,tournamentId,waitMs:0}})
    if(state==='unregistered') assert.ok(result.isError)
    else assert.equal(JSON.parse(result.content[0].text).state,state)
    assert.equal(opens,0)
  }
})
