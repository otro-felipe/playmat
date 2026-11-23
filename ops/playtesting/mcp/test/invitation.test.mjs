import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocketServer } from 'ws';
import { PlaymatEngineSeat } from '../src/engine-seat.mjs';
import { createMcpServer } from '../src/server.mjs';

const deployments=['https://one.playmat.example','https://two.playmat.example'];
for(const origin of [...deployments,undefined]) test('[PM-AC-08] invite origins are independent of CORS on '+(origin??'a local relative-link deployment'),async t=>{
  const clientOrigin='https://authorized-client.example', tableId='22222222-2222-4222-8222-222222222222';
  const server=createMcpServer({ invitationOrigin:origin, allowedOrigins:[...deployments,clientOrigin],
    authorize:async()=>({accountId:'owner',engineName:'Pilot',scopes:['play']}),
    product:async(_token,name,input)=>{
      assert.equal(name,'list_joinable_games');
      assert.equal(input.tableId,tableId);
      return {invites:[{tableId}]};
    },
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const client=new Client({name:'origin-check',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+server.address().port+'/mcp'),{
    requestInit:{headers:{Origin:clientOrigin,Authorization:'Bearer fixture'}},
  }));
  t.after(()=>client.close());
  const list=args=>client.callTool({name:'list_joinable_games',arguments:args});
  assert.equal((await list({tableId})).isError,false);
  for(const path of ['/join/'+tableId,'/join/mcp/'+tableId+'#invite='+'x'.repeat(43)]){
    assert.equal((await list({inviteLink:(origin??'')+path})).isError,false);
    for(const foreign of [...deployments,clientOrigin].filter(v=>v!==origin)){
      assert.equal((await list({inviteLink:foreign+path})).isError,true);
      const reply=await client.callTool({name:'join_game',arguments:{inviteLink:foreign+path,deckId:'fixture'}});
      assert.equal(JSON.parse(reply.content[0].text).code,'invalid_invite');
    }
  }
});

test('[PM-AC-08] join_game uses a private Playmat link, validates before claim, and conveys an optional alias', async (t) => {
  const origin = 'https://playmat.example';
  const tableId = '22222222-2222-4222-8222-222222222222';
  const deck = { name: 'Fixture deck', cards: [{ cardName: 'Forest', amount: 60 }] };
  const deckId = 'pioneer_aggro:main-1.0';
  const access = { tableId, format: 'Pioneer', mode: 'mcp' };
  const inspected = [];
  const claimed = [];
  const server = createMcpServer({
    invitationOrigin:origin, allowedOrigins: [origin],
    authorize: async (token) => token === 'fixture' ? { accountId: 'owner', engineName: 'FixtureAgent', scopes: ['play'] } : null,
    createEngine: ({ engineName }) => ({
      async joinGame(input, invite, claim) {
        assert.equal(engineName, 'FixtureAgent');
        assert.deepEqual(invite, access);
        assert.equal(input.tableId, tableId);
        assert.equal(input.deck.cards[0].cardName, 'Forest');
        assert.equal(input.deck.libraryDeckId, claimed.length === 0 ? undefined : deckId);
        assert.deepEqual(await claim(), { ...access, guestDisplayName: 'Angels', password: 'synthetic-table-fixture' });
        return { state: 'seated' };
      },
    }),
    product: async (_token, name, input) => {
      if (name === 'get_deck') {
        assert.equal(input.deckId, deckId);
        return { id: deckId, library: 'agent', data: { ...deck, sideboard: [] } };
      }
      if (name === 'list_joinable_games') {
        assert.equal(input.tableId,tableId);
        assert.ok(input.inviteToken==='x'.repeat(43));
        return {invites:[{tableId,format:'Pioneer'}]};
      }
      if (name === 'inspect_game_invite') {
        inspected.push(input);
        return access;
      }
      assert.equal(name, 'get_game_invite');
      claimed.push(input);
      return { ...access, guestDisplayName: input.displayName, password: 'synthetic-table-fixture' };
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new Client({ name: 'invitation-fixture', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer fixture' } },
  });
  await client.connect(transport);
  t.after(() => client.close());
  const join = args => client.callTool({ name: 'join_game', arguments: { deck, ...args } });
  assert.equal((await join({ inviteLink: `https://wrong.invalid/join/${tableId}` })).isError, true);
  assert.equal(inspected.length, 0);
  const result = await join({ inviteLink: `${origin}/join/${tableId}`, displayName: 'Angels', model: 'test-model', reasoningEffort: 'high' });
  assert.deepEqual(JSON.parse(result.content[0].text), { state: 'seated' });
  assert.deepEqual(inspected, [{ tableId }]);
  assert.deepEqual(claimed, [{ tableId, displayName: 'Angels', model: 'test-model', reasoningEffort: 'high' }]);
  const byId = await client.callTool({ name: 'join_game', arguments: { tableId, deckId, displayName: 'Angels' } });
  assert.deepEqual(JSON.parse(byId.content[0].text), { state: 'seated' });
  assert.equal((await join({ tableId, deckId })).isError, true);
  assert.equal(claimed.length, 2);
  Object.assign(access, {mode:'friend',spectatorVisibility:'both-hands',requiresSpectatorAcceptance:true});
  const closed = await client.callTool({name:'join_game',arguments:{tableId,deckId,displayName:'Angels'}});
  assert.equal(closed.isError,true);
  assert.equal(JSON.parse(closed.content[0].text).code,'spectator_consent_required');
  assert.equal(claimed.length,2);
  const accepted = await client.callTool({name:'join_game',arguments:{tableId,deckId,displayName:'Angels',acceptSpectatorVisibility:'both-hands'}});
  assert.equal(accepted.isError,false);
  assert.equal(claimed.at(-1).acceptSpectatorVisibility,'both-hands');
  assert.equal(claimed.at(-1).expectedSpectatorVisibility,'both-hands');
  Object.assign(access,{mode:'mcp',requiresSpectatorAcceptance:false});
  const externalLink=origin+'/join/mcp/'+tableId+'#invite='+'x'.repeat(43);
  const listed=await client.callTool({name:'list_joinable_games',arguments:{inviteLink:externalLink}});
  assert.equal(listed.isError,false);
  assert.ok(!listed.content[0].text.includes('#invite='));
  const external=await client.callTool({name:'join_game',arguments:{inviteLink:externalLink,deckId,displayName:'Angels'}});
  assert.equal(external.isError,false);
  assert.ok(inspected.at(-1).inviteToken==='x'.repeat(43) && claimed.at(-1).inviteToken==='x'.repeat(43));
  for(const link of [externalLink.replace('/join/mcp/','/join/'),externalLink.replace('#invite=','?invite='),externalLink.split('#')[0]]) {
    assert.equal((await client.callTool({name:'list_joinable_games',arguments:{inviteLink:link}})).isError,true);
  }
});

test('[PM-AC-08] the MCP seat receives its chosen display name and chat mode for the invited match', { timeout: 5_000 }, async (t) => {
  const origin = 'https://playmat.example';
  const tableId = '22222222-2222-4222-8222-222222222222';
  const roomId = '33333333-3333-4333-8333-333333333333';
  const deck = { name: 'Fixture deck', cards: [{ cardName: 'Forest', amount: 60 }] };
  const engineName = 'FixtureAgent';
  const chatId = '44444444-4444-4444-8444-444444444444';
  const chatSends = [];
  const engineServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(engineServer, 'listening');
  const connected = once(engineServer, 'connection');
  const reply = { connectUser: true, serverGetMainRoomId: roomId, deckValidate: { valid: true }, roomJoinTable: true,
    gameJoin: true, chatFindByGame: chatId, chatJoin: true, chatSendMessage: true };
  engineServer.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const { method, id, params } = JSON.parse(raw);
      if (method === 'chatSendMessage') chatSends.push(params);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, result: reply[method] ?? null }));
    });
  });
  const invite = { tableId, roomId, format: 'Pioneer', mode: 'mcp', chatMode: 'coach' };
  const engine = new PlaymatEngineSeat({
    engineUrl: `ws://127.0.0.1:${engineServer.address().port}`, engineName, trustedHeader: 'x-fixture-user', canonicalAgent: true,
  });
  const server = createMcpServer({
    invitationOrigin:origin, allowedOrigins: [origin],
    authorize: async (token) => token === 'fixture' ? { accountId: 'owner', engineName, scopes: ['play', 'chat'] } : null,
    createEngine: () => engine,
    product: async (_token, operation) => {
      if (operation === 'inspect_game_invite') return invite;
      assert.equal(operation, 'get_game_invite');
      return { ...invite, guestDisplayName: 'Counter Pilot', password: 'synthetic-table-fixture' };
    },
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
    for (const socket of engineServer.clients) socket.terminate();
    engineServer.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new Client({ name: 'chat-mode-fixture', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer fixture' } },
  }));
  t.after(() => client.close());
  async function call(name, args = {}) {
    const response = await client.callTool({ name, arguments: args });
    const value = JSON.parse(response.content[0].text);
    assert.equal(response.isError ?? false, false, value.code);
    return value;
  }

  const join = await call('join_game', { inviteLink: `${origin}/join/${tableId}`, deck });
  assert.equal(join.chatMode, 'coach');
  assert.equal(join.displayName, 'Counter Pilot');
  assert.equal((await call('get_game_state')).displayName, 'Counter Pilot');
  const [socket, request] = await connected;
  assert.equal(request.headers['x-playmat-canonical-agent'], '1');
  const starts = [
    { gameId: '11111111-1111-4111-8111-111111111111', currentTableId: tableId, expectedMode: 'coach' },
    { gameId: '55555555-5555-4555-8555-555555555555', currentTableId: tableId, expectedMode: 'coach' },
    { gameId: '66666666-6666-4666-8666-666666666666', currentTableId: '77777777-7777-4777-8777-777777777777' },
  ];
  for (const [index, { gameId, currentTableId, expectedMode }] of starts.entries()) {
    const started = new Promise(resolve => {
      const unsubscribe = engine.subscribe(() => {
        if (engine.snapshot().gameId !== gameId) return;
        unsubscribe();
        resolve();
      });
    });
    socket.send(JSON.stringify({ method: 'START_GAME', messageId: index + 1, objectId: gameId,
      data: { gameId, playerId: engineName, currentTableId } }));
    await started;
    const state = await call('get_game_state', { gameId });
    assert.equal(state.chatMode, expectedMode);
    assert.equal(state.displayName, expectedMode ? 'Counter Pilot' : undefined);
    if (index === 0) {
      assert.equal((await call('send_chat', { gameId, message: 'Good game' })).sent, true);
      assert.deepEqual(chatSends, [[chatId, null, 'Good game']]);
      socket.send(JSON.stringify({ method: 'CHATMESSAGE', messageId: 100, objectId: chatId,
        data: { username: engineName, messageType: 'TALK', message: 'Good game', time: 1 } }));
      let messages = [];
      for (let attempt = 0; attempt < 10 && !messages.length; attempt++) {
        ({ messages } = await call('list_chat', { gameId }));
        if (!messages.length) await sleep(20);
      }
      assert.deepEqual(messages, [{ author: 'Counter Pilot', message: 'Good game', time: 1 }]);
    }
  }
});
