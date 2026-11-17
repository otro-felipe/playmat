import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocketServer } from 'ws';
import { PlaymatEngineSeat } from '../src/engine-seat.mjs';
import { createMcpServer } from '../src/server.mjs';

const gameId = '11111111-1111-4111-8111-111111111111';
const playerId = '22222222-2222-4222-8222-222222222222';
const roomId = '33333333-3333-4333-8333-333333333333';
const front = '44444444-4444-4444-8444-444444444444';
const back = '55555555-5555-4555-8555-555555555555';

test('[PM-AC-08] selects or cancels the engine ability panel through guarded MCP choices', async (t) => {
  const engineServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(engineServer, 'listening');
  const played = [];
  const responses = { connectUser: true, serverGetMainRoomId: roomId, gameJoin: true, sendPlayerUUID: true };
  const connected = once(engineServer, 'connection');
  engineServer.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const { method, id, params } = JSON.parse(raw);
      if (method === 'sendPlayerUUID') played.push(params);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, result: responses[method] ?? null }));
    });
  });
  const actor = { accountId: 'fixture-owner', engineName: 'FixtureRival', scopes: ['play'] };
  const engine = new PlaymatEngineSeat({
    engineUrl: `ws://127.0.0.1:${engineServer.address().port}`, engineName: actor.engineName, trustedHeader: 'x-fixture-user',
  });
  const server = createMcpServer({
    authorize: async (token) => token === 'fixture-rival' ? actor : null,
    createEngine: () => engine,
  });
  t.after(() => {
    engine.close();
    for (const socket of engineServer.clients) socket.terminate();
    engineServer.close();
    server.closeAllConnections();
    server.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new Client({ name: 'ability-panel-fixture', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer fixture-rival' } },
  }));
  t.after(() => client.close());
  async function call(name, args) {
    const reply = await client.callTool({ name, arguments: args });
    return { isError: reply.isError ?? false, result: JSON.parse(reply.content[0].text) };
  }

  await engine.open();
  const [socket] = await connected;
  const event = (method, messageId, data) => socket.send(JSON.stringify({ method, messageId, objectId: gameId, data }));
  event('START_GAME', 1, { gameId, playerId });
  event('GAME_INIT', 2, { players: [{ playerId, name: actor.engineName }], step: 'PRECOMBAT_MAIN' });
  const abilityPanel = {
    message: 'Choose spell or ability to play Branchloft Pathway',
    choices: { [front]: '1. <b>Play Branchloft Pathway</b>', [back]: '2. <b>Play Boulderloft Pathway</b>' },
  };
  event('GAME_CHOOSE_ABILITY', 3, abilityPanel);
  const observed = await call('wait_for_decision', { timeoutMs: 1_000 });
  assert.equal(observed.isError, false);
  assert.equal(observed.result.event, 'decision');
  assert.equal(observed.result.state.gameId, gameId);
  const { decision } = observed.result.state;
  assert.deepEqual(decision.choices.map(({ label, type }) => [label, type]), [
    ['Play Branchloft Pathway', 'option'],
    ['Play Boulderloft Pathway', 'option'],
    ['Cancel', 'button'],
  ]);
  assert.ok(decision.choices.every((choice) => !Object.hasOwn(choice, 'command')));
  event('START_GAME', 100, { gameId, playerId });
  // An RPC round trip fences delivery of the duplicate notification on the same WebSocket.
  await engine.api.serverGetMainRoomId();
  const repeated = await call('get_game_state', { gameId });
  assert.deepEqual(repeated.result.decision, decision, 'duplicate recovery START_GAME preserves the issued decision');
  assert.equal(repeated.result.step, 'PRECOMBAT_MAIN');

  const action = { gameId, decisionId: decision.id, choiceId: decision.choices[1].id, idempotencyKey: 'back-face' };
  const unprojected = await call('submit_decision', { ...action, choiceId: back, idempotencyKey: 'raw-choice' });
  assert.equal(unprojected.result.code, 'illegal_choice');
  assert.equal(played.length, 0);
  assert.equal((await call('submit_decision', action)).result.submitted, true);
  assert.deepEqual(played.map(([id, , abilityId, expectedPrompt]) => [id, abilityId, expectedPrompt]), [
    [gameId, back, 3],
  ]);

  event('GAME_CHOOSE_ABILITY', 4, abilityPanel);
  const second = await call('wait_for_decision', { gameId, afterDecisionId: decision.id, timeoutMs: 1_000 });
  assert.equal(second.result.event, 'decision');
  const current = second.result.state.decision;
  const stale = await call('submit_decision', { ...action, idempotencyKey: 'stale-face' });
  assert.equal(stale.result.code, 'stale_decision');
  const cancel = current.choices.find((choice) => choice.label === 'Cancel');
  assert.equal((await call('submit_decision', {
    gameId, decisionId: current.id, choiceId: cancel.id, idempotencyKey: 'cancel-panel',
  })).result.submitted, true);
  assert.deepEqual(played.map(([id, , abilityId, expectedPrompt]) => [id, abilityId, expectedPrompt]), [
    [gameId, back, 3],
    [gameId, null, 4],
  ]);
});
