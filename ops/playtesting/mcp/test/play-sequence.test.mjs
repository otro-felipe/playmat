import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocketServer } from 'ws';
import { PlaymatEngineSeat } from '../src/engine-seat.mjs';
import { createMcpServer } from '../src/server.mjs';

const gameId = '11111111-1111-4111-8111-111111111111';
const playerId = '22222222-2222-4222-8222-222222222222';
const opponentId = '33333333-3333-4333-8333-333333333333';
const forestId = '44444444-4444-4444-8444-444444444444';
const elvesId = '55555555-5555-4555-8555-555555555555';
const duplicateId = '66666666-6666-4666-8666-666666666666';
const spellId = '77777777-7777-4777-8777-777777777777';
const responseId = '88888888-8888-4888-8888-888888888888';
const phase = 'PRECOMBAT_MAIN';

const forest = { id: forestId, cardId: forestId, name: 'Forest', cardTypes: ['LAND'], controllerId: playerId };
const elves = { id: elvesId, cardId: elvesId, name: 'Llanowar Elves', cardTypes: ['CREATURE'], controllerId: playerId };
const spell = { ...elves, id: spellId };
const opposition = { id: responseId, cardId: responseId, name: 'Lightning Strike', controllerId: opponentId };

async function fixture(t, variant = 'normal') {
  const socketServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(socketServer, 'listening');
  const submitted = [];
  const actor = { accountId: 'fixture-owner', engineName: 'Pilot', scopes: ['play'] };
  const engine = new PlaymatEngineSeat({
    engineUrl: `ws://127.0.0.1:${socketServer.address().port}`, engineName: actor.engineName, trustedHeader: 'x-fixture-user',
  });
  const server = createMcpServer({ authorize: async (token) => token === 'fixture-sequence' ? actor : null, createEngine: () => engine });
  const connected = once(socketServer, 'connection');
  const pending = new Set();
  const schedule = (fn) => {
    const timer = setTimeout(() => { pending.delete(timer); fn(); }, 10);
    pending.add(timer);
  };
  const view = (hand, battlefield, playable, stack = {}) => ({
    turn: 2, phase, step: phase, myPlayerId: playerId, activePlayerId: playerId,
    priorityPlayerName: actor.engineName, players: [{ playerId, hasPriority: true, battlefield, name: actor.engineName }],
    myHand: hand, stack,
    canPlayObjects: { objects: Object.fromEntries(playable.map((id) => [id, {}])) },
  });
  const initialHand = { [forestId]: forest, [elvesId]: elves };
  if (variant === 'ambiguous') initialHand[duplicateId] = { ...forest, id: duplicateId, cardId: duplicateId };
  const afterLand = view({ [elvesId]: elves }, { [forestId]: forest }, [elvesId]);
  const afterCast = view({}, { [forestId]: forest }, [forestId], { [spellId]: spell });

  socketServer.on('connection', (socket) => {
    const event = (method, messageId, data) => socket.send(JSON.stringify({ method, messageId, objectId: gameId, data }));
    socket.on('message', (raw) => {
      const { method, id, params } = JSON.parse(raw);
      if (method === 'sendPlayerUUID') submitted.push({ object: params[2], guard: params[3] });
      const result = method === 'serverGetMainRoomId' ? gameId : true;
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
      if (method !== 'sendPlayerUUID') return;
      switch (submitted.length) {
        case 1:
          event('GAME_UPDATE', 4, afterLand);
          schedule(() => event('GAME_SELECT', 5, { message: 'Play spells and abilities', gameView: afterLand }));
          break;
        case 2:
          if (variant === 'opponent-response') {
            event('GAME_UPDATE', 6, { ...afterCast, stack: { ...afterCast.stack, [responseId]: opposition } });
          } else {
            event('GAME_UPDATE', 6, afterCast);
            schedule(() => event(
              variant === 'mandatory' ? 'GAME_ASK' : 'GAME_PLAY_MANA',
              7, { message: variant === 'mandatory' ? 'Choose a replacement' : 'Pay {G}', gameView: afterCast },
            ));
          }
          break;
      }
    });
  });
  t.after(() => {
    for (const timer of pending) clearTimeout(timer);
    engine.close();
    for (const socket of socketServer.clients) socket.terminate();
    socketServer.close();
    server.closeAllConnections();
    server.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new Client({ name: 'play-sequence-fixture', version: '1.0.0' });
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  await client.connect(new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: 'Bearer fixture-sequence' } },
  }));
  t.after(() => client.close());
  const call = async (name, args) => {
    const reply = await client.callTool({ name, arguments: args });
    const response = reply.content[0].text;
    return { error: reply.isError ?? false, result: reply.isError ? response : JSON.parse(response) };
  };
  await engine.open();
  const [socket] = await connected;
  socket.send(JSON.stringify({ method: 'START_GAME', messageId: 1, objectId: gameId, data: { gameId, playerId } }));
  const opening = view(initialHand, {}, Object.keys(initialHand));
  socket.send(JSON.stringify({ method: 'GAME_INIT', messageId: 2, objectId: gameId, data: opening }));
  socket.send(JSON.stringify({
    method: 'GAME_SELECT', messageId: 3, objectId: gameId, data: { gameView: opening, message: 'Play spells and abilities' },
  }));
  const { result } = await call('wait_for_decision', { gameId, timeoutMs: 500 });
  assert.equal(result.state.decision.kind, 'priority');
  return { call, submitted, cursor: result.state.cursor };
}

const steps = [
  { kind: 'answer', select: { cardName: 'Forest', zone: 'hand' }, guard: { kind: 'priority', step: phase } },
  { kind: 'answer', select: { cardName: 'Llanowar Elves', zone: 'hand' }, guard: { kind: 'priority', step: phase }, expectCast: true },
  { kind: 'answer', select: { cardName: 'Forest', zone: 'battlefield' }, guard: { kind: 'payMana', step: phase } },
];

async function play({ call, cursor }) {
  const started = await call('play_sequence', { gameId, cursor, steps });
  assert.equal(started.error, false, started.error ? started.result : 'The authenticated MCP transport can submit the plan');
  for (let attempt = 0; attempt < 30; attempt++) {
    const { result } = await call('get_sequence_status', { gameId, sequenceId: started.result.sequenceId });
    if (result.status !== 'running') return result;
    await sleep(10);
  }
  assert.fail('The sequence did not reach a terminal state.');
}

test('[PM-AC-09] a guarded MCP play sequence handles a land, its own spell and mana windows', { timeout: 5000 }, async (t) => {
  const game = await fixture(t);
  const result = await play(game);
  assert.equal(result.status, 'completed');
  assert.equal(result.appliedDecisions, 3);
  assert.deepEqual(game.submitted, [
    { object: forestId, guard: 3 }, { object: elvesId, guard: 5 }, { object: forestId, guard: 7 },
  ]);
});

for (const [variant, reason, actions] of [
  ['ambiguous', 'ambiguous_choice', 0],
  ['opponent-response', 'state_changed', 2],
  ['mandatory', 'state_changed', 2],
]) {
  test(`[PM-AC-09] a guarded MCP play sequence stops on ${variant}`, { timeout: 5000 }, async (t) => {
    const game = await fixture(t, variant);
    const result = await play(game);
    assert.equal(result.status, 'interrupted');
    assert.equal(result.reason, reason);
    assert.equal(result.appliedDecisions, actions);
    assert.equal(game.submitted.length, actions);
  });
}
