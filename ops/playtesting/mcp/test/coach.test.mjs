import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocketServer } from 'ws';
import { PlaymatEngineSeat } from '../src/engine-seat.mjs';
import { createMcpServer } from '../src/server.mjs';

const tableId = '11111111-1111-4111-8111-111111111111';
const gameId = '22222222-2222-4222-8222-222222222222';
const playerId = '33333333-3333-4333-8333-333333333333';
const humanId = '44444444-4444-4444-8444-444444444444';
const roomId = '55555555-5555-4555-8555-555555555555';
const chatId = '66666666-6666-4666-8666-666666666666';

async function fixture(t, chatMode, chat = true) {
  const websocket = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(websocket, 'listening');
  const connected = once(websocket, 'connection');
  const actions = [], messages = [];
  websocket.on('connection', socket => socket.on('message', raw => {
    const { method, id, params } = JSON.parse(raw);
    if (method.startsWith('sendPlayer')) actions.push(method);
    if (method === 'chatSendMessage') messages.push(params[2]);
    const replies = { connectUser: true, serverGetMainRoomId: roomId, deckValidate: { valid: true }, roomJoinTable: true,
      gameJoin: true, chatFindByGame: chatId, chatJoin: true, chatSendMessage: true, sendPlayerBoolean: true };
    if (id !== undefined) socket.send(JSON.stringify({ jsonrpc: '2.0', id, result: replies[method] ?? null }));
  }));
  const engine = new PlaymatEngineSeat({ engineUrl: `ws://127.0.0.1:${websocket.address().port}`, engineName: 'CoachRival', trustedHeader: 'x-fixture-user' });
  const server = createMcpServer({
    allowedOrigins: ['https://playmat.example'],
    authorize: async token => token === 'fixture' ? { accountId: 'owner', engineName: 'CoachRival', scopes: chat ? ['play', 'chat'] : ['play'] } : null,
    createEngine: () => engine,
    product: async () => ({ tableId, roomId, format: 'Pioneer', mode: 'mcp', chatMode, password: 'synthetic-table-fixture' }),
  });
  t.after(() => {
    engine.close();
    server.closeAllConnections(); server.close();
    for (const socket of websocket.clients) socket.terminate();
    websocket.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new Client({ name: 'coach-contract-fixture', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer fixture' } },
  }));
  t.after(() => client.close());
  async function call(name, args = {}, error = false) {
    const reply = await client.callTool({ name, arguments: args });
    const value = JSON.parse(reply.content[0].text);
    assert.equal(reply.isError ?? false, error, value.message);
    return value;
  }
  const guides = new Map();
  for (const guideId of ['getting-started', 'turn-planning', 'card-catalog', 'rules']) guides.set(guideId, await call('get_guide', { guideId }));
  const join = await call('join_game', { tableId, deck: { name: 'Fixture', cards: [{ cardName: 'Forest', amount: 60 }] } });
  const [socket] = await connected;
  let messageId = 0;
  async function emit(method, data, ready) {
    const changed = new Promise(resolve => {
      const unsubscribe = engine.subscribe(() => { if (ready(engine.snapshot())) { unsubscribe(); resolve(); } });
    });
    socket.send(JSON.stringify({ method, messageId: ++messageId, objectId: gameId, data }));
    await changed;
  }
  await emit('START_GAME', { gameId, playerId, currentTableId: tableId }, state => state.gameId === gameId);
  return { client, call, emit, join, guides, actions, messages };
}

function position(turn, activePlayerName = 'Human') {
  return {
    myPlayerId: playerId, turn, step: 'PRECOMBAT_MAIN', activePlayerName,
    activePlayerId: activePlayerName === 'Human' ? humanId : playerId, priorityPlayerName: activePlayerName,
    responseIdle: { status: 'running', deadlineEpochMs: 1_900_000_900_000, sampledAtEpochMs: 1_900_000_000_000, secondsRemaining: 900, timeoutSeconds: 900 },
    myHand: { own: { id: 'own', name: 'PRIVATE_RIVAL_CARD' } },
    opponentHands: { [humanId]: { secret: { name: 'HIDDEN_HUMAN_CARD' } } },
    watchedHands: [{ cards: { secret: { name: 'WATCHED_HUMAN_CARD' } } }],
    revealed: [{ name: 'Public reveal', cards: { public: { id: 'public', name: 'PUBLIC_REVEALED_CARD' } } }],
    lookedAt: [{ name: 'Private effect', cards: { look: { id: 'look', name: 'PRIVATE_LOOK_CARD' } } }],
    players: [{ playerId, name: 'CoachRival', life: 20 }, { playerId: humanId, name: 'Human', life: 20, handCount: 4 }],
    canPlayObjects: { objects: {} },
  };
}

test('the connected coach receives actionable tone/timing/privacy instructions through initialize, tools and resources', async t => {
  const { client, guides } = await fixture(t, 'coach');
  const instructions = client.getInstructions();
  for (const requirement of [
    /chatMode is coach/, /warm, specific and lightly playful/, /After each completed human turn/,
    /judged from what was known before the decision/, /Coach mode grants no hand access/,
    /Resolve your pending engine decision first/, /chatty.*without tactical coaching/, /absent or unknown chatMode means quiet/,
  ]) assert.match(instructions, requirement);
  const delivered = guides.get('getting-started');
  const resource = await client.readResource({ uri: 'playmat://guides/getting-started' });
  assert.equal(delivered.text, resource.contents[0].text);
  for (const requirement of [
    /During the human's turn/, /at most one genuinely strong opportunity/, /After each completed human turn/,
    /A different line is not automatically a better line/, /Missing information is not proof/,
    /private `lookedAt` effect is not consent/, /do not cancel or split it/,
    /Otra opción podría haber sido/, /Esa línea me parece razonable/, /no tengo una alternativa claramente mejor/,
  ]) assert.match(delivered.text, requirement);
});

for (const mode of ['quiet', 'chatty', 'coach', undefined]) {
  test(`${mode ?? 'legacy'} invitations retain their mode without expanding hand visibility`, async t => {
    const { call, emit, join, messages, actions } = await fixture(t, mode);
    assert.equal(join.chatMode, mode ?? 'quiet');
    await emit('GAME_UPDATE', position(3), state => state.turn === 3);
    const state = await call('get_game_state', { gameId });
    assert.equal(state.chatMode, mode ?? 'quiet');
    assert.equal(state.ownHand[0].name, 'PRIVATE_RIVAL_CARD');
    assert.equal(state.revealed[0].cards[0].name, 'PUBLIC_REVEALED_CARD');
    assert.equal(state.lookedAt[0].cards[0].name, 'PRIVATE_LOOK_CARD');
    assert.equal(state.players.find(player => !player.yourSeat).handCount, 4);
    assert.doesNotMatch(JSON.stringify(state), /HIDDEN_HUMAN_CARD|WATCHED_HUMAN_CARD|opponentHands|watchedHands/);
    assert.deepEqual(messages, []);
    assert.deepEqual(actions, []);
  });
}

test('a short turn review uses existing chat without consuming a pending decision or renewing its deadline', async t => {
  const { call, emit, messages, actions } = await fixture(t, 'coach');
  await emit('GAME_UPDATE', position(3), state => state.turn === 3);
  await emit('GAME_SELECT', { message: 'Play spells and abilities', gameView: position(4, 'CoachRival') }, state => state.turn === 4 && state.decision);
  const before = await call('get_game_state', { gameId });
  assert.ok(before.decision.choices.length);
  const comment = 'Con lo que vi en la mesa, no tengo una alternativa claramente mejor. Bien cuidado ese recurso 🦦';
  assert.equal((await call('send_chat', { gameId, message: comment })).sent, true);
  const after = await call('get_game_state', { gameId });
  assert.equal(after.decision.id, before.decision.id);
  assert.equal(after.timing.inactivity.deadlineEpochMs, before.timing.inactivity.deadlineEpochMs);
  assert.deepEqual(messages, [comment]);
  assert.deepEqual(actions, []);
  const pass = after.decision.choices.find(choice => choice.type === 'pass');
  await call('submit_decision', { gameId, cursor: after.cursor, decisionId: after.decision.id, choiceId: pass.id, idempotencyKey: 'explicit-answer' });
  assert.deepEqual(actions, ['sendPlayerBoolean']);
});

test('missing chat scope refuses a review without answering or removing the engine decision', async t => {
  const { call, emit, actions, messages } = await fixture(t, 'coach', false);
  await emit('GAME_SELECT', { message: 'Play spells and abilities', gameView: position(4, 'CoachRival') }, state => state.turn === 4 && state.decision);
  const before = await call('get_game_state', { gameId });
  assert.equal((await call('send_chat', { gameId, message: 'Comentario de prueba' }, true)).code, 'forbidden');
  assert.equal((await call('get_game_state', { gameId })).decision.id, before.decision.id);
  assert.deepEqual(messages, []);
  assert.deepEqual(actions, []);
});
