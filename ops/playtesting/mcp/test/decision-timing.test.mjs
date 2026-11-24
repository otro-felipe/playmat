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

async function fixture(t, beforeReply = async () => {}) {
  const websocket = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(websocket, 'listening');
  const connected = once(websocket, 'connection');
  const actions = [];
  websocket.on('connection', socket => socket.on('message', async raw => {
    const { method, id, params } = JSON.parse(raw);
    if (method.startsWith('sendPlayer')) actions.push({ method, params });
    const override = await beforeReply(method);
    const responses = { connectUser: true, serverGetMainRoomId: roomId, gameJoin: true, sendPlayerBoolean: true };
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, result: override ?? responses[method] ?? null }));
  }));
  const engine = new PlaymatEngineSeat({
    engineUrl: `ws://127.0.0.1:${websocket.address().port}`, engineName: 'FixtureRival', trustedHeader: 'x-fixture-user',
  });
  const server = createMcpServer({
    authorize: async token => token === 'fixture-rival'
      ? { accountId: 'fixture-owner', engineName: 'FixtureRival', scopes: ['play'] } : null,
    createEngine: () => engine,
  });
  t.after(() => {
    engine.close();
    for (const socket of websocket.clients) socket.terminate();
    websocket.close();
    server.closeAllConnections();
    server.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new Client({ name: 'decision-timing-fixture', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer fixture-rival' } },
  }));
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const value = JSON.parse(response.content[0].text);
    assert.equal(response.isError ?? false, false, value.message);
    return value;
  };
  await engine.open();
  const [socket] = await connected;
  let messageId = 0;
  const emit = async (method, data, promptMessageId = ++messageId) => {
    const changed = new Promise(resolve => {
      const unsubscribe = engine.subscribe(() => { unsubscribe(); resolve(); });
    });
    socket.send(JSON.stringify({ method, messageId: promptMessageId, objectId: gameId, data }));
    await changed;
  };
  await emit('START_GAME', { gameId, playerId });
  return { actions, call, emit, engine };
}

function view(priorityTime, player = {}) {
  return { priorityTime, step: 'PRECOMBAT_MAIN', priorityPlayerName: 'FixtureRival',
    players: [{ playerId, name: 'FixtureRival', hasPriority: true, timerActive: true, ...player }] };
}

test('MCP reports match-clock samples including paused and zero balances, never an invented inactivity deadline', { timeout: 5000 }, async t => {
  const { actions, call, emit } = await fixture(t);
  // An old server timestamp must not be converted to a decision deadline or an invented live balance.
  const reportAt = 1_700_000_000_000;
  for (const [priorityTime, player, expected, alias] of [
    [1500, { priorityTimeLeftSecs: 42, priorityTimeSavedTimeMs: reportAt },
      { status: 'running', lastReportedSecondsRemaining: 42, reportedAtEpochMs: reportAt }, 42],
    [1500, { priorityTimeLeftSecs: 42, priorityTimeSavedTimeMs: reportAt, timerActive: false },
      { status: 'paused', lastReportedSecondsRemaining: 42, reportedAtEpochMs: reportAt }, null],
    [1500, { priorityTimeLeftSecs: 0 },
      { status: 'running', lastReportedSecondsRemaining: 0, reportedAtEpochMs: null }, 0],
    [0, { priorityTimeLeftSecs: 0 },
      { status: 'disabled', lastReportedSecondsRemaining: null, reportedAtEpochMs: null }, null],
    [undefined, { priorityTimeLeftSecs: 42 },
      { status: 'unknown', lastReportedSecondsRemaining: null, reportedAtEpochMs: null }, null],
    [1500, {},
      { status: 'running', lastReportedSecondsRemaining: null, reportedAtEpochMs: null }, null],
  ]) {
    await emit('GAME_UPDATE', view(priorityTime, player));
    const state = await call('get_game_state', { gameId });
    assert.deepEqual(state.timing.matchClock, expected);
    assert.equal(state.secondsRemaining, alias);
    assert.deepEqual(state.timing.inactivity, { status: 'unknown', deadlineEpochMs: null, secondsRemaining: null, timeoutSeconds: null });
    assert.equal(state.timing.warning, null);
  }
  assert.deepEqual(actions, []);
});

test('a null match clock keeps a pending choice and warning visible after a wait timeout without playing it', { timeout: 5000 }, async t => {
  const { actions, call, emit } = await fixture(t);
  await emit('GAME_ASK', { message: 'Keep this hand?', gameView: view(0), options: { webPrompt: 'mulligan' } });
  const initial = await call('get_game_state', { gameId });
  assert.equal(initial.secondsRemaining, null);
  assert.equal(initial.timing.matchClock.status, 'disabled');
  assert.ok(initial.decision.choices.length > 0);
  assert.match(initial.timing.warning, /inactivity deadline is unknown; null does not mean unlimited time/);
  // Asking only for a newer cursor/decision must not hide an already observed unanswered prompt.
  const waited = await call('wait_for_decision', {
    gameId, afterCursor: initial.cursor, afterDecisionId: initial.decision.id, timeoutMs: 100,
  });
  assert.equal(waited.event, 'timeout');
  assert.equal(waited.cursor, initial.cursor);
  assert.deepEqual(waited.state.decision, initial.decision);
  assert.equal(waited.state.timing.warning, initial.timing.warning);
  assert.deepEqual(actions, []);
  // The normal, explicit legal choice still uses the engine prompt guard.
  const choice = waited.state.decision.choices[0];
  const answered = await call('submit_decision', {
    gameId, cursor: waited.state.cursor, decisionId: waited.state.decision.id, choiceId: choice.id, idempotencyKey: 'explicit-answer',
  });
  assert.equal(answered.submitted, true);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].method, 'sendPlayerBoolean');
  const [, , , expectedPrompt, line] = actions[0].params;
  assert.equal(expectedPrompt, 2);
  assert.equal(line, null); // A standalone answer is not part of a planned line.
  await emit('GAME_OVER', { gameView: view(0), message: 'Fixture finished' });
  const finished = await call('get_game_state', { gameId });
  assert.equal(finished.decision, null);
  assert.equal(finished.timing.warning, null);
});

test('authoritative own idle deadline survives polling independently of a disabled match clock', { timeout: 5000 }, async t => {
  const { actions, call, emit } = await fixture(t);
  const sampledAtEpochMs = Date.now();
  const deadlineEpochMs = sampledAtEpochMs + 900_000;
  await emit('GAME_ASK', { message: 'Keep this hand?', gameView: { ...view(0), myPlayerId: playerId,
    responseIdle: { status: 'running', sampledAtEpochMs, deadlineEpochMs, remainingMillis: 900_000, timeoutSeconds: 900 } },
    options: { webPrompt: 'mulligan' } });
  const first = await call('get_game_state', { gameId });
  assert.equal(first.timing.matchClock.status, 'disabled');
  assert.equal(first.secondsRemaining, null);
  assert.equal(first.timing.inactivity.status, 'running');
  assert.equal(first.timing.inactivity.deadlineEpochMs, deadlineEpochMs);
  assert.ok(first.timing.inactivity.secondsRemaining > 895 && first.timing.inactivity.secondsRemaining <= 900);
  assert.match(first.timing.warning, /auto-concede even with the match clock disabled/);
  for (let n = 0; n < 5; n++) {
    const observed = await call('get_game_state', { gameId });
    assert.equal(observed.timing.inactivity.deadlineEpochMs, deadlineEpochMs);
    assert.ok(observed.timing.inactivity.secondsRemaining <= first.timing.inactivity.secondsRemaining);
  }
  assert.deepEqual(actions, []);
  await emit('GAME_UPDATE', { ...view(0), myPlayerId: playerId,
    responseIdle: { status: 'running', sampledAtEpochMs, deadlineEpochMs: 0, remainingMillis: 0, timeoutSeconds: 900 } });
  assert.deepEqual((await call('get_game_state', { gameId })).timing.inactivity,
    { status: 'running', deadlineEpochMs: 0, secondsRemaining: 0, timeoutSeconds: 900 });
});

test('idle metadata is own-seat only and clears inactive or disabled deadlines', { timeout: 5000 }, async t => {
  const { actions, call, emit } = await fixture(t);
  for (const status of ['inactive', 'disabled']) {
    await emit('GAME_UPDATE', { ...view(0), myPlayerId: playerId, responseIdle: { status, timeoutSeconds: 900 } });
    assert.deepEqual((await call('get_game_state', { gameId })).timing.inactivity,
      { status, deadlineEpochMs: null, secondsRemaining: null, timeoutSeconds: null });
  }
  await emit('GAME_UPDATE', { ...view(0), myPlayerId: 'another-seat', responseIdle: {
    status: 'running', sampledAtEpochMs: Date.now(), deadlineEpochMs: Date.now() + 900_000, remainingMillis: 900_000, timeoutSeconds: 900 } });
  assert.deepEqual((await call('get_game_state', { gameId })).timing.inactivity,
    { status: 'unknown', deadlineEpochMs: null, secondsRemaining: null, timeoutSeconds: null });
  assert.deepEqual(actions, []);
});

for (const timeoutSeconds of [900, 600]) test(`[PM-AC-08-TIMING] 600 remaining seconds preserve the actual ${timeoutSeconds}-second idle window independently of a 15-minute match clock`, { timeout: 5000 }, async t => {
  const { actions, call, emit } = await fixture(t);
  const sampledAtEpochMs = Date.now();
  const deadlineEpochMs = sampledAtEpochMs + 600_000;
  await emit('GAME_ASK', { message: 'Keep this hand?', gameView: { ...view(900, { priorityTimeLeftSecs: 900 }), myPlayerId: playerId,
    responseIdle: { status: 'running', sampledAtEpochMs, deadlineEpochMs, remainingMillis: 600_000, timeoutSeconds } }, options: { webPrompt: 'mulligan' } });
  const state = await call('get_game_state', { gameId });
  assert.equal(state.timing.inactivity.timeoutSeconds, timeoutSeconds, 'Copy the server window, not a default or the remaining balance');
  assert.equal(state.timing.inactivity.deadlineEpochMs, deadlineEpochMs);
  assert.ok(state.timing.inactivity.secondsRemaining > 595 && state.timing.inactivity.secondsRemaining <= 600);
  assert.equal(state.timing.matchClock.lastReportedSecondsRemaining, 900);
  assert.deepEqual(actions, [], 'Reading either clock never submits a choice or changes the engine deadline');
});

test('[PM-AC-08-TIMING] unavailable or invalid idle duration stays unknown even with a running deadline', { timeout: 5000 }, async t => {
  const { actions, call, emit } = await fixture(t);
  for (const timeoutSeconds of [undefined, -1, 1.5, '900']) {
    const sampledAtEpochMs = Date.now();
    await emit('GAME_UPDATE', { ...view(0), myPlayerId: playerId, responseIdle: { status: 'running', sampledAtEpochMs,
      deadlineEpochMs: sampledAtEpochMs + 600_000, remainingMillis: 600_000, timeoutSeconds } });
    const state = await call('get_game_state', { gameId });
    assert.equal(state.timing.inactivity.status, 'running');
    assert.equal(state.timing.inactivity.timeoutSeconds, null, 'Never invent 900 or copy 600 remaining as the configured duration');
  }
  assert.deepEqual(actions, []);
});

test(
  'a native answer in flight keeps its sent cursor and has no acknowledgement or inferred decision opening',
  { timeout: 5000 },
  async (t) => {
    const sent = Promise.withResolvers(),
      release = Promise.withResolvers();
    const { actions, call, emit } = await fixture(t, async (method) => {
      if (method === 'sendPlayerBoolean') {
        sent.resolve();
        await release.promise;
      }
    });
    await emit('GAME_ASK', { message: 'First question?', gameView: view(0) });
    const state = await call('get_game_state', { gameId });
    const commandId = 'fixture-actual-dispatch';
    const line = call('play_line', {
      gameId,
      commandId,
      cursor: state.cursor,
      waitMs: 0,
      actions: [{ kind: 'choose', decisionId: state.decision.id, choiceId: state.decision.choices[0].id }],
    });
    try {
      await sent.promise;
      const pending = await call('wait_for_decision', { gameId, commandId, timeoutMs: 100 });
      assert.equal(pending.appliedDecisions, 0);
      assert.equal(pending.lastSubmission.cursor, state.cursor);
      assert.equal(pending.lastSubmission.decisionOpenedAtEpochMs, null);
      assert.ok(Number.isFinite(pending.lastSubmission.dispatchedAtEpochMs));
      assert.equal(pending.lastSubmission.acknowledgedAtEpochMs, null);
      assert.equal(pending.lastSubmission.acknowledged, false);
    } finally {
      release.resolve();
      await line;
    }
    await emit('GAME_ASK', { message: 'Next question?', gameView: view(0) });
    const receipt = await call('wait_for_decision', { gameId, commandId, timeoutMs: 300 });
    assert.equal(receipt.appliedDecisions, 1);
    assert.equal(receipt.requestedCursor, state.cursor);
    assert.equal(receipt.cursor, receipt.state.cursor);
    assert.ok(receipt.cursor > receipt.requestedCursor);
    const last = receipt.lastSubmission;
    assert.equal(last.acknowledged, true);
    assert.ok(last.acknowledgedAtEpochMs >= last.dispatchedAtEpochMs);
    assert.equal(actions.length, 1);
  },
);

test(
  'a submitted sideboard window waits for the next game without sending a second deck',
  { timeout: 5000 },
  async (t) => {
    const { call, emit, engine } = await fixture(t);
    await emit('SIDEBOARD', { currentTableId: roomId, deck: { main: [], sideboard: [] }, time: 0 });
    const window = await call('get_sideboard_state', { gameId });
    let sends = 0;
    engine.api.deckSubmit = async () => {
      sends++;
      return true;
    };
    await engine.submitSideboard({ gameId, decisionId: window.decisionId, deck: window.deck });
    await emit('SIDEBOARD', { currentTableId: roomId, deck: { main: [], sideboard: [] }, time: 0 });
    const repeated = await call('get_sideboard_state', { gameId });
    assert.equal(repeated.decisionId, window.decisionId);
    assert.equal(repeated.submitted, true);
    const during = await call('get_game_state', { gameId });
    const expired = await call('wait_for_decision', { gameId, afterCursor: during.cursor, timeoutMs: 100 });
    assert.equal(expired.event, 'timeout');
    assert.equal(expired.state.sideboard.submitted, true);
    const nextId = '44444444-4444-4444-8444-444444444444';
    const listening = Promise.withResolvers();
    const subscribe = engine.subscribe.bind(engine);
    engine.subscribe = (callback) => {
      const stop = subscribe(callback);
      listening.resolve();
      return stop;
    };
    const waiting = call('wait_for_decision', { gameId, afterCursor: during.cursor, timeoutMs: 1000 });
    await listening.promise;
    await emit('START_GAME', { gameId: nextId, playerId });
    const next = await waiting;
    assert.equal(next.state.gameId, nextId);
    assert.equal(sends, 1);
  },
);

test(
  'an uncertain sideboard acknowledgement can be read without submitting the same window twice',
  { timeout: 5000 },
  async (t) => {
    const { call, emit, engine } = await fixture(t);
    await emit('SIDEBOARD', { currentTableId: roomId, deck: { main: [], sideboard: [] }, time: 0 });
    const window = await call('get_sideboard_state', { gameId });
    const started = Promise.withResolvers(),
      lost = Promise.withResolvers();
    let sends = 0;
    engine.api.deckSubmit = async () => {
      sends++;
      started.resolve();
      await lost.promise;
      throw Error('synthetic transport interruption');
    };
    const args = { gameId, decisionId: window.decisionId, deck: window.deck };
    const first = engine.submitSideboard(args);
    try {
      await started.promise;
      const pending = await call('get_sideboard_state', { gameId });
      assert.equal(pending.submitted, false);
      assert.equal(pending.submissionStatus, 'sending');
    } finally {
      lost.resolve();
      await assert.rejects(first);
    }
    const uncertain = await call('get_sideboard_state', { gameId });
    assert.equal(uncertain.submissionStatus, 'uncertain');
    assert.equal(uncertain.submitted, false);
    await assert.rejects(engine.submitSideboard(args), { code: 'uncertain_ack' });
    assert.equal(sends, 1);
  },
);

test(
  'the last submission records no dispatch or acceptance without a usable engine prompt guard',
  { timeout: 5000 },
  async (t) => {
    const { actions, call, emit } = await fixture(t);
    await emit('GAME_ASK', { message: 'Synthetic choice?', gameView: view(0) }, 2.5);
    const state = await call('get_game_state', { gameId });
    const receipt = await call('play_line', {
      gameId,
      commandId: 'not-dispatched',
      cursor: state.cursor,
      waitMs: 200,
      actions: [{ kind: 'choose', decisionId: state.decision.id, choiceId: state.decision.choices[0].id }],
    });
    assert.equal(receipt.appliedDecisions, 0);
    assert.equal(receipt.lastSubmission.dispatchedAtEpochMs, null);
    assert.equal(receipt.lastSubmission.acknowledgedAtEpochMs, null);
    assert.equal(receipt.lastSubmission.acknowledged, false);
    assert.equal(actions.length, 0);
  },
);

test(
  'an explicit sideboard refusal keeps this window open for one corrected submission',
  { timeout: 5000 },
  async (t) => {
    const { call, emit, engine } = await fixture(t);
    await emit('SIDEBOARD', { currentTableId: roomId, deck: { main: [], sideboard: [] }, time: 0 });
    const window = await call('get_sideboard_state', { gameId });
    let sends = 0;
    engine.api.deckSubmit = async () => ++sends > 1;
    const args = { gameId, decisionId: window.decisionId, deck: window.deck };
    await assert.rejects(engine.submitSideboard(args), { code: 'sideboard_refused' });
    assert.equal((await call('get_sideboard_state', { gameId })).submissionStatus, 'open');
    assert.equal((await engine.submitSideboard(args)).submitted, true);
    await assert.rejects(engine.submitSideboard(args), { code: 'stale_decision' });
    assert.equal(sends, 2);
  },
);

test(
  'a native refusal records dispatch and finish with zero acknowledged decisions',
  { timeout: 5000 },
  async (t) => {
    const { actions, call, emit } = await fixture(t, async (method) =>
      method === 'sendPlayerBoolean' ? false : undefined,
    );
    await emit('GAME_ASK', { message: 'Fixture question?', gameView: view(0) });
    const state = await call('get_game_state', { gameId });
    const result = await call('play_line', {
      gameId,
      commandId: 'native-refusal',
      cursor: state.cursor,
      waitMs: 300,
      actions: [{ kind: 'choose', decisionId: state.decision.id, choiceId: state.decision.choices[0].id }],
    });
    assert.equal(result.appliedDecisions, 0);
    assert.equal(result.lastSubmission.acknowledged, false);
    assert.ok(Number.isFinite(result.lastSubmission.dispatchedAtEpochMs));
    assert.ok(result.lastSubmission.finishedAtEpochMs >= result.lastSubmission.dispatchedAtEpochMs);
    assert.equal(result.lastSubmission.acknowledgedAtEpochMs, null);
    assert.equal(actions.length, 1);
  },
);

test(
  'first native prompt observation survives a refresh and a duplicate and belongs only to its original decision',
  { timeout: 5000 },
  async (t) => {
    const { call, emit } = await fixture(t);
    const ask = { message: 'Synthetic question?', gameView: view(0) };
    const before = Date.now();
    await emit('GAME_ASK', ask, 100);
    const first = await call('get_game_state', { gameId });
    const observed = first.decision.firstObservedAtEpochMs;
    assert.ok(Number.isFinite(observed) && observed >= before && observed <= Date.now());
    assert.equal(first.decision.openedAtEpochMs, null);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await emit('GAME_ASK', ask, 100);
    const repeat = await call('get_game_state', { gameId, view: 'compact' });
    assert.equal(repeat.decision.firstObservedAtEpochMs, observed);
    await emit('GAME_UPDATE', view(1), 101);
    assert.equal((await call('get_game_state', { gameId })).decision.firstObservedAtEpochMs, observed);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const beforeNext = Date.now();
    await emit('GAME_ASK', ask, 102);
    const next = await call('get_game_state', { gameId });
    assert.notEqual(next.decision.id, first.decision.id);
    assert.ok(next.decision.firstObservedAtEpochMs >= beforeNext);
    assert.ok(next.decision.firstObservedAtEpochMs > observed);
    const old = await call('play_line', {
      gameId,
      commandId: 'old-observation',
      cursor: first.cursor,
      actions: [{ kind: 'choose', decisionId: first.decision.id, choiceId: first.decision.choices[0].id }],
    });
    assert.equal(old.appliedDecisions, 0);
    assert.equal(old.state.decision.firstObservedAtEpochMs, next.decision.firstObservedAtEpochMs);
    const line = await call('play_line', {
      gameId,
      commandId: 'current-observation',
      cursor: next.cursor,
      waitMs: 100,
      actions: [{ kind: 'choose', decisionId: next.decision.id, choiceId: next.decision.choices[0].id }],
    });
    assert.equal(line.lastSubmission.decisionFirstObservedAtEpochMs, next.decision.firstObservedAtEpochMs);
    assert.equal(line.lastSubmission.decisionOpenedAtEpochMs, null);
    assert.ok(line.lastSubmission.dispatchedAtEpochMs >= line.lastSubmission.decisionFirstObservedAtEpochMs);
  },
);
