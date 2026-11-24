import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createProductClient } from '../src/product.mjs';
import { createMcpServer } from '../src/server.mjs';

test('one connection addresses both private projections and receipts of one game without a current-player setting', async t => {
  const accountId = randomUUID(), connectionId = randomUUID(), tableId = randomUUID(), gameId = randomUUID();
  const base = { accountId, connectionId, engineName: 'Canonical', scopes: ['play', 'library', 'chat', 'history'] };
  const players = ['First', 'Second'].map(engineName => ({ ...base, playerId:randomUUID(), engineName,
    scopes:['play','library','chat'], ownsReservation:true, activeTableId:tableId, reservationId:randomUUID() }));
  const runtime = {provider:'openai', model:'gpt-fixture', reasoningEffort:'medium'};
  Object.assign(players[0], runtime);
  const calls = [], engines = [];
  let selectable = true;
  let legacyTableId = randomUUID();
  const legacyGameId = randomUUID();
  const api = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-canonical');
    const id = req.headers['x-playmat-player-id'];
    const player = players.find(p => p.playerId === id);
    calls.push({ path:req.url, id });
    res.setHeader('content-type', 'application/json');
    if (id && !player) { res.writeHead(403); res.end('{}'); return; }
    if (req.url === '/internal/verify') res.end(JSON.stringify(player ?? {...base, playerSelectionEnabled:selectable}));
    else if (req.url === '/api/playtesting/players') res.end(JSON.stringify({ players: player ? [player] : players }));
    else if (req.url.startsWith('/api/playtesting/decks?')) res.end(JSON.stringify({ decks:['shared-library'] }));
    else if (req.url === '/internal/mcp-events/list') res.end(JSON.stringify({ events:[], reader:id }));
    else { res.writeHead(404); res.end('{}'); }
  });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const product = createProductClient('http://127.0.0.1:' + api.address().port);
  const server = createMcpServer({ authorize: product.authorize, product:product.operation, eventRequest:product.eventRequest,
    createEngine: actor => {
      engines.push(actor.engineName);
      let ended = false;
      return { profileConnectionId:actor.connectionId, profileId:actor.playerId, profileTableId:actor.activeTableId,
        open:async()=>{}, subscribe:()=>()=>{}, close:()=>{}, matchesPlayerGrant:() => true,
        snapshot:()=>({ gameId:actor.playerId ? gameId : legacyGameId, tableId:actor.playerId ? tableId : legacyTableId, ownHand:[actor.engineName], cursor:ended?2:1, epoch:'test', turn:1, stack:[],players:[],
          priority:'self', status:ended?'match_over':'active', decision:ended?null:{id:'prompt',kind:'priority',choices:[{id:'pass',type:'pass'}]} }),
        respond: async()=>{ended=true; return {submitted:true};} };
    } });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const client = new Client({ name:'single-client', version:'1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + server.address().port + '/mcp'), {
    requestInit:{ headers:{authorization:'Bearer fixture-canonical'} } }));
  t.after(async()=>{await client.close();server.closeAllConnections();server.close();api.closeAllConnections();api.close();});
  const call = async(name,args={}) => JSON.parse((await client.callTool({name,arguments:args})).content[0].text);
  const eventList = async params => {
    const reply = await fetch('http://127.0.0.1:' + server.address().port + '/mcp', { method:'POST',
      headers:{ accept:'application/json, text/event-stream', 'content-type':'application/json', authorization:'Bearer fixture-canonical' },
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'events/list',params}) });
    return reply.json();
  };
  const ids = players.map(p=>p.playerId);
  assert.equal((await eventList({})).error.code,-32602);
  assert.equal((await eventList({playerId:randomUUID()})).error.code,-32001);
  for (const playerId of ids) assert.equal((await eventList({playerId})).result.reader,playerId);

  const listed = (await call('list_players')).players;
  assert.deepEqual(listed.map(p=>p.playerId),ids);
  const {provider, model, reasoningEffort} = listed[0];
  assert.deepEqual({provider, model, reasoningEffort}, runtime);
  assert.equal(listed[1].model, undefined);
  assert.deepEqual(await call('list_decks'), {decks:['shared-library']});
  assert.equal((await call('get_game_state',{gameId})).code,'player_required');
  assert.equal((await call('get_game_state',{playerId:randomUUID(),gameId})).code,'player_forbidden');
  assert.deepEqual(engines,[]);
  for (const state of await Promise.all(players.map(p=>call('get_game_state',{playerId:p.playerId,gameId})))) {
    assert.equal(state.ownHand.length,1);
  }
  const pair=await Promise.all(players.map(p=>call('wait_for_decision',{playerId:p.playerId,gameId,timeoutMs:100})));
  assert.deepEqual(pair.map(r=>r.state.ownHand), [['First'],['Second']]);
  assert.deepEqual(engines.sort(), ['First','Second']);
  for (const playerId of ids) {
    assert.deepEqual((await call('list_players',{playerId})).players.map(p=>p.playerId),[playerId]);
    assert.deepEqual(await call('list_decks',{playerId}),{decks:['shared-library']});
    assert.ok(calls.some(c=>c.path.includes('/decks?') && c.id===playerId));
    assert.equal((await call('get_replay',{playerId,gameId})).code,'forbidden');
    assert.equal((await call('get_game_state',{playerId,humanTableId:tableId})).code,'player_forbidden');
  }
  const commandId='same-command';
  const before=calls.length;
  const end=await call('play_line',{playerId:ids[0],gameId,commandId,cursor:1,waitMs:100,actions:[{kind:'choose',decisionId:'prompt',choiceId:'pass'}]});
  assert.equal(end.state.status,'match_over');
  assert.ok(calls.slice(before).filter(c=>c.path==='/internal/verify'&&c.id===ids[0]).length>=2,'revalidate the exact selected actor');
  players[0].activeTableId=null;players[0].reservationId=null;
  assert.equal((await call('wait_for_decision',{playerId:ids[0],gameId,commandId})).event,'match_over');
  assert.notEqual((await call('wait_for_decision',{playerId:ids[1],gameId,commandId})).event,'match_over');
  assert.equal((await call('wait_for_decision',{gameId,commandId})).code,'player_required');
  const second=await call('play_line',{playerId:ids[1],gameId,commandId,cursor:1,waitMs:100,actions:[{kind:'choose',decisionId:'prompt',choiceId:'pass'}]});
  assert.equal(second.state.status,'match_over');
  assert.notEqual(second.sequenceId,end.sequenceId);
  players[1].activeTableId=null; players[1].reservationId=null;
  const recovered=await Promise.all(ids.map(playerId=>call('wait_for_decision',{playerId,gameId,commandId})));
  assert.deepEqual(recovered.map(receipt=>receipt.sequenceId),[end.sequenceId,second.sequenceId]);
  selectable=false;
  assert.deepEqual((await call('get_game_state')).ownHand,['Canonical']);
  selectable=true;
  assert.deepEqual((await call('get_game_state',{gameId:legacyGameId})).ownHand,['Canonical']);
  legacyTableId=tableId;
  assert.equal((await call('get_game_state',{gameId:legacyGameId})).code,'player_required');
  assert.equal((await call('get_game_state',{gameId:randomUUID()})).code,'player_required');
});
