import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocketServer } from 'ws';
import { PlaymatEngineSeat } from '../src/engine-seat.mjs';
import { createMcpServer } from '../src/server.mjs';

const gameId = '11111111-1111-4111-8111-111111111111';
const tableId = '33333333-3333-4333-8333-333333333333';
const seats = {
  Alpha: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  Bravo: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

test('two MCP seats distinguish engine priority, actionable choice, HTTP write, client receipt and accepted response', async t => {
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(ws, 'listening');
  const sockets = new Map();
  const engines = new Map();
  const events = [];
  const operations = [];
  ws.on('connection', (socket, req) => {
    sockets.set(req.headers['x-fixture'], socket);
    socket.on('message', raw => {
      const { method, id } = JSON.parse(raw);
      if (method.startsWith('sendPlayer')) operations.push(method);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, result: method === 'serverGetMainRoomId' ? tableId : true }));
    });
  });
  const mcp = createMcpServer({
    authorize: async token => Object.hasOwn(seats, token) ? { accountId: token, engineName: token, scopes: ['play'] } : null,
    createEngine: actor => {
      const engine = new PlaymatEngineSeat({ engineUrl: 'ws://127.0.0.1:' + ws.address().port,
        engineName: actor.engineName, trustedHeader: 'x-fixture', recordDecisionTiming: event => events.push(event) });
      engines.set(actor.engineName, engine);
      return engine;
    },
  });
  mcp.listen(0, '127.0.0.1');
  await once(mcp, 'listening');
  t.after(() => { for (const e of engines.values()) e.close(); for (const s of ws.clients) s.terminate();
    ws.close(); mcp.closeAllConnections(); mcp.close(); });
  const clients = {};
  for (const name of Object.keys(seats)) {
    const client = new Client({ name: 'delivery-fixture', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + mcp.address().port + '/mcp'),
      { requestInit: { headers: { Authorization: 'Bearer ' + name } } }));
    t.after(() => client.close());
    clients[name] = async (tool, args = {}) => JSON.parse((await client.callTool({ name: tool, arguments: args })).content[0].text);
    await clients[name]('get_game_state');
    await engines.get(name).open();
  }
  let seq = 0;
  async function emit(name, method, data) {
    const engine = engines.get(name);
    const changed = new Promise(resolve => { const stop = engine.subscribe(() => { stop(); resolve(); }); });
    sockets.get(name).send(JSON.stringify({ method, messageId: ++seq, objectId: gameId, data }));
    await changed;
  }
  for (const [name, playerId] of Object.entries(seats)) await emit(name, 'START_GAME', { gameId, playerId, currentTableId: tableId });
  const assignedAt = Date.now() - 500;
  function view(name) {
    return { priorityTime: 900, priorityAssignedAtEpochMs: assignedAt, priorityPlayerName: name, step: 'PRECOMBAT_MAIN',
      players: Object.entries(seats).map(([seatName, playerId]) => ({ playerId, name: seatName, hasPriority: name === seatName })) };
  }
  const prompt = name => ({ message: 'private fixture prompt', gameView: view(name), options: { webPrompt: 'mulligan' } });
  // Wait until the real long poll subscribed, independently of the test's
  // own WebSocket callback acknowledgement subscriptions.
  const alpha = engines.get('Alpha');
  const subscribe = alpha.subscribe.bind(alpha);
  let listen;
  const listening = new Promise(resolve => { listen = resolve; });
  alpha.subscribe = listener => { const stop = subscribe(listener); listen(); return stop; };
  const waiting = clients.Alpha('wait_for_decision', { gameId, timeoutMs: 2000 });
  await listening;
  alpha.subscribe = subscribe;
  await emit('Alpha', 'GAME_UPDATE', view('Alpha'));
  await emit('Bravo', 'GAME_UPDATE', view('Alpha'));
  await emit('Alpha', 'GAME_ASK', prompt('Alpha'));
  const read = (await waiting).state;
  const observedAtEpochMs = Date.now();
  const first = events.find(event => event.stage === 'actionable' && event.seatId === seats.Alpha);
  assert.ok(first, 'the native prompt is recorded even before the pilot reads');
  assert.equal(first.priorityAssignedAtEpochMs, assignedAt);
  assert.equal(first.deliveryStatus, 'unconfirmed');
  assert.equal(first.tableId, tableId);
  assert.equal(first.gameId, gameId);
  assert.equal(first.decisionId, read.decision.id);
  assert.equal(first.openingCursor, read.decision.delivery.openingCursor);
  const flushed = events.find(event => event.stage === 'response_written' && event.decisionId === first.decisionId);
  assert.ok(flushed.responseWrittenAtEpochMs >= first.actionableAtEpochMs);
  assert.equal(flushed.deliveryConfirmedAtEpochMs, null);
  await clients.Bravo('get_game_state', {gameId, receivedDecision: { decisionId: first.decisionId, cursor: read.cursor, receivedAtEpochMs: observedAtEpochMs }});
  assert.equal(events.filter(event => event.stage === 'delivery_confirmed').length, 0, 'another seat cannot acknowledge the read');
  const answer = { gameId, cursor: read.cursor, decisionId: read.decision.id, choiceId: read.decision.choices[0].id,
    idempotencyKey: 'fixture-answer', receivedDecision: { decisionId: first.decisionId, cursor: read.cursor, receivedAtEpochMs: observedAtEpochMs } };
  assert.equal((await clients.Alpha('submit_decision', { ...answer, idempotencyKey: 'invalid', choiceId: 'invalid-choice' })).code, 'illegal_choice');
  assert.equal(events.some(event => event.stage === 'operation_accepted'), false);
  assert.equal((await clients.Alpha('submit_decision', answer)).submitted, true);
  assert.equal((await clients.Alpha('submit_decision', answer)).submitted, true);
  const accepted = events.filter(event => event.stage === 'operation_accepted');
  assert.equal(accepted.length, 1);
  assert.equal(operations.length, 1);
  assert.equal(accepted[0].deliveryStatus, 'confirmed');
  assert.equal(accepted[0].clientReceivedAtEpochMs, observedAtEpochMs);
  assert.ok(accepted[0].firstAcceptedAtEpochMs >= observedAtEpochMs);
  assert.equal(accepted[0].engineToClientMs, observedAtEpochMs - assignedAt);
  assert.equal(accepted[0].clientToFirstAcceptedMs, accepted[0].firstAcceptedAtEpochMs - observedAtEpochMs);

  // Bravo receives an engine decision while its pilot has no ongoing tool call.
  await emit('Bravo', 'GAME_ASK', prompt('Bravo'));
  const unobserved = events.find(event => event.stage === 'actionable' && event.seatId === seats.Bravo);
  assert.equal(unobserved.deliveryStatus, 'unconfirmed');
  await emit('Bravo', 'GAME_OVER', { gameView: view('Bravo'), message: 'finished' });
  const closed = events.find(event => event.stage === 'decision_closed' && event.decisionId === unobserved.decisionId);
  assert.equal(closed.deliveryStatus, 'unconfirmed');
  assert.equal(closed.responseWrittenAtEpochMs, null);
  assert.equal(closed.clientToFirstAcceptedMs, null);
  // A later receipt can prove delivery by echoing its ID, even without a
  // trustworthy client clock. An out-of-window reading must not fabricate an interval.
  await emit('Alpha', 'GAME_ASK', prompt('Alpha'));
  const next = await clients.Alpha('get_game_state', { gameId, view: 'compact' });
  await clients.Alpha('get_game_state', { gameId, receivedDecision: {
    decisionId: next.decision.id, cursor: next.cursor, receivedAtEpochMs: assignedAt - 3_600_000 } });
  const echoed = events.find(e => e.stage === 'delivery_confirmed' && e.decisionId === next.decision.id);
  assert.equal(echoed.deliveryStatus, 'confirmed');
  assert.equal(echoed.clientReceivedAtEpochMs, null);
  assert.ok(echoed.deliveryConfirmedAtEpochMs >= echoed.responseWrittenAtEpochMs);
  assert.equal(echoed.engineToClientMs, null);
  assert.doesNotMatch(JSON.stringify(events), /private fixture|mulligan|Bearer|fixture-answer|Alpha|Bravo/);
});
