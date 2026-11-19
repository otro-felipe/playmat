import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpServer } from '../src/server.mjs';

const gameId = '00000000-0000-4000-8000-000000000001';
const otherGame = '00000000-0000-4000-8000-000000000002';
const choice = (id, kind = 'amount', instruction = 'Choose an amount') => ({
  id, kind, instruction, choices: [{ id: `${id}-answer`, type: 'number', label: `Answer for ${id}` }],
});

async function fixture(t, { first = choice('first'), onResponse = () => {}, evidence = true, initial = {} } = {}) {
  const listeners = new Set();
  const applied = [];
  const players = [
    { id: 'pilot', yourSeat: true, battlefield: [] },
    { id: 'rival', yourSeat: false, battlefield: [] },
  ];
  let state = {
    gameId, cursor: 42, epoch: 1, turn: 3, status: 'active', activePlayerId: 'pilot',
    phase: 'PRECOMBAT_MAIN', step: 'PRECOMBAT_MAIN', priority: 'self', decision: first,
    stack: [], players, ownHand: [],
    ...(evidence ? { sequenceEvidence: {
      epoch: 'fixture', resolutionRevision: 0, resolutions: {}, publicActions: { pilot: 0, rival: 0 },
      informationRevision: 0, combatRevision: 0, combatDamage: [],
    } } : {}),
    ...initial,
  };
  const update = (patch) => {
    state = { ...state, cursor: state.cursor + 1, ...patch };
    for (const listener of listeners) listener();
  };
  const engine = {
    snapshot: () => state,
    subscribe: (handler) => { listeners.add(handler); return () => listeners.delete(handler); },
    async respond(decisionId, choiceId, value) {
      const answer = { decisionId, choiceId, value };
      applied.push(answer);
      await onResponse(answer, update, state);
      return { submitted: true, gameId, cursor: state.cursor };
    },
  };
  const server = createMcpServer({
    authorize: async (token) => token === 'fixture' ? { accountId: 'fixture', engineName: 'pilot', scopes: ['play'] } : null,
    createEngine: () => engine,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new Client({ name: 'isolated-line-fixture', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer fixture' } },
  }));
  t.after(async () => { await client.close(); server.closeAllConnections(); server.close(); });
  const call = async (name, args, options) => {
    const r = await client.callTool({ name, arguments: args }, undefined, options);
    return { isError: r.isError === true, result: JSON.parse(r.content[0].text), structured: r.structuredContent };
  };
  const request = {
    gameId, cursor: state.cursor, commandId: 'round-1', actions: [
      { kind: 'choose', decisionId: first.id, choiceId: first.choices[0].id, value: 2 },
    ],
  };
  return { call, request, applied, update, listTools: () => client.listTools() };
}

test('[PM-LINE-MCP-1] a cross-field schema rejection returns the failing action without starting the line', async (t) => {
  const f = await fixture(t);
  const { isError, result, structured } = await f.call('play_line', { ...f.request, view: 'compact', actions: [
    ...f.request.actions, { kind: 'pass_until', destination: 'current_turn' },
  ] });
  assert.equal(isError, false);
  assert.deepEqual(structured, result);
  assert.equal(result.code, 'invalid_line_arguments');
  assert.equal(result.status, 'rejected');
  assert.equal(result.stage, 'schema');
  assert.equal(result.actionIndex, 1);
  assert.deepEqual(result.issues[0].path, ['actions', 1]);
  assert.match(result.issues[0].message, /current_turn/);
  assert.equal(result.cursor, f.request.cursor);
  assert.equal(result.appliedDecisions, 0);
  assert.equal(result.planOwnsExecution, false);
  assert.equal(result.commandId, f.request.commandId);
  assert.deepEqual(f.applied, []);
});

test('[PM-LINE-MCP-1] native stale line transport preserves the preflight rejection and safe retry details', async (t) => {
  const f = await fixture(t);
  f.update({ decision: choice('new') });
  const { isError, result, structured } = await f.call('play_line', { ...f.request, view: 'compact' });
  assert.equal(isError, false);
  assert.deepEqual(structured, result);
  assert.equal(result.code, 'stale_decision');
  assert.equal(result.status, 'rejected');
  assert.equal(result.stage, 'preflight');
  assert.equal(result.cursor, f.request.cursor);
  assert.equal(result.appliedDecisions, 0);
  assert.equal(result.gameId, f.request.gameId);
  assert.equal(result.state.cursor, f.request.cursor + 1);
  assert.equal(result.recovery, 'replan_from_state');
  assert.deepEqual(f.applied, []);
});

test('[PM-LINE-MCP-2] native tool discovery advertises both compact and full player views', async (t) => {
  const f = await fixture(t);
  const { tools } = await f.listTools();
  for (const name of ['get_game_state', 'play_line', 'wait_for_decision']) {
    const { inputSchema } = tools.find((tool) => tool.name === name);
    assert.deepEqual(inputSchema.properties.view.enum, ['full', 'compact']);
    assert.ok(!inputSchema.required?.includes('view'));
  }
});

test('[PM-LINE-01/03] one call applies the complete declared line and returns the next decision', async (t) => {
  const f = await fixture(t, {
    onResponse: ({ decisionId }, update) => {
      update({ decision: decisionId === 'first' ? choice('second', 'amount', 'Choose the next amount') : choice('next') });
    },
  });
  const request = { ...f.request, actions: [...f.request.actions, {
    kind: 'choose', guard: { kind: 'amount', instruction: 'Choose the next amount' },
    select: { label: 'Answer for second' }, value: [1, 0],
  }] };
  const { isError, result } = await f.call('play_line', request);
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.appliedDecisions, 2);
  assert.equal(result.planOwnsExecution, false);
  assert.equal(result.state.decision.id, 'next');
  assert.deepEqual(f.applied.map(({ value }) => value), [2, [1, 0]]);
});

test('[PM-LINE-01/03] an exact observed choice waits for the new callback without implying another move', async (t) => {
  const f = await fixture(t, { evidence: false, onResponse: (_answer, update) => {
    setTimeout(() => update({ decision: choice('later') }), 25);
  } });
  const { isError, result } = await f.call('play_line', f.request);
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.state.decision.id, 'later');
  assert.equal(f.applied.length, 1);
});

test('[PM-LINE-03] same-key retry recovers a pending line and one wait returns its fresh decision', async (t) => {
  const sent = Promise.withResolvers();
  const f = await fixture(t, { onResponse: (_answer, update) => {
    update({ priority: 'opponent', decision: null });
    sent.resolve();
  } });
  const { result: running } = await f.call('play_line', { ...f.request, waitMs: 0 });
  assert.equal(running.status, 'running');
  assert.equal(running.planOwnsExecution, true);
  await sent.promise;
  const { result: retry } = await f.call('play_line', { ...f.request, waitMs: 1 });
  assert.equal(retry.sequenceId, running.sequenceId);
  const conflict = await f.call('play_line', { ...f.request, actions: [{ ...f.request.actions[0], value: 3 }] });
  assert.equal(conflict.isError, false);
  assert.equal(conflict.result.code, 'key_conflict');
  assert.equal(conflict.result.recovery, 'recover_original_command');
  assert.equal((await f.call('wait_for_decision', { gameId: otherGame, commandId: f.request.commandId })).isError, true);
  assert.equal((await f.call('wait_for_decision', { gameId, commandId: 'unknown' })).result.code, 'unknown_command');
  const next = f.call('wait_for_decision', { gameId, commandId: f.request.commandId, timeoutMs: 1000 });
  f.update({ priority: 'self', decision: choice('returned') });
  const { result: stopped } = await next;
  assert.equal(stopped.sequenceId, running.sequenceId);
  assert.equal(stopped.event, 'line_stopped');
  assert.equal(stopped.state.decision.id, 'returned');
  assert.equal(stopped.appliedDecisions, 1);
  const { result: afterStop } = await f.call('play_line', f.request);
  assert.equal(afterStop.sequenceId, running.sequenceId);
  assert.equal(f.applied.length, 1);
});

test('[PM-LINE-03] losing the response after an accepted choice leaves a recoverable line', async (t) => {
  const sent = Promise.withResolvers();
  const f = await fixture(t, { onResponse: (_answer, update) => {
    update({ priority: 'opponent', decision: null });
    sent.resolve();
  } });
  const controller = new AbortController();
  const lost = assert.rejects(f.call('play_line', f.request, { signal: controller.signal }));
  await sent.promise;
  controller.abort();
  await lost;

  f.update({ priority: 'self', decision: choice('returned') });
  const { result } = await f.call('play_line', f.request);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.state.decision.id, 'returned');
  assert.equal(f.applied.length, 1);
});

test('[PM-LINE-03] an information interruption includes its next actionable callback within the original wait', async (t) => {
  const f = await fixture(t, { onResponse: (_answer, update, state) => {
    update({
      decision: null,
      ownHand: [{ id: 'fresh-card', name: 'Drawn card' }],
      sequenceEvidence: { ...state.sequenceEvidence, informationRevision: 1 },
    });
    setTimeout(() => update({ decision: choice('after-draw') }), 25);
  } });
  const { result } = await f.call('play_line', f.request);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.reason, 'new_information');
  assert.equal(result.state.decision.id, 'after-draw');
  assert.equal(result.state.ownHand[0].id, 'fresh-card');
  assert.equal(result.needsAgent, true);
  assert.equal(f.applied.length, 1);
});

test('[PM-LINE-03] a decision wait can return a rollback vote without a gameplay prompt', async (t) => {
  const f = await fixture(t);
  const next = f.call('wait_for_decision', { gameId, afterCursor: f.request.cursor, timeoutMs: 1000 });
  f.update({ decision: null, rollbackRequest: { id: 'rewind-1' } });
  const { result } = await next;
  assert.equal(result.event, 'rollback');
  assert.equal(result.state.rollbackRequest.id, 'rewind-1');
});

test('[PM-LINE-03] a rollback callback invalidates a running line and returns the pending vote', async (t) => {
  const submitted = Promise.withResolvers();
  const f = await fixture(t, { onResponse: (_answer, update) => {
    update({ priority: 'opponent', decision: null });
    submitted.resolve();
  } });
  const { result: running } = await f.call('play_line', { ...f.request, waitMs: 0 });
  assert.equal(running.planOwnsExecution, true);
  await submitted.promise;

  const invalidWait = await f.call('wait_for_decision', {
    gameId, commandId: f.request.commandId, afterCursor: f.request.cursor,
  });
  assert.equal(invalidWait.result.code, 'invalid_line_wait');

  const next = f.call('wait_for_decision', { gameId, commandId: f.request.commandId, timeoutMs: 1000 });
  // EngineSeat invalidates the epoch when it publishes USER_REQUEST_DIALOG.
  f.update({ epoch: 2, rollbackRequest: { id: 'rewind-1' } });
  const { result } = await next;
  assert.equal(result.sequenceId, running.sequenceId);
  assert.equal(result.event, 'rollback');
  assert.equal(result.reason, 'invalidated');
  assert.equal(result.planOwnsExecution, false);
  assert.equal(result.needsAgent, true);
  assert.equal(result.state.rollbackRequest.id, 'rewind-1');
  assert.equal(f.applied.length, 1);
});

test('[PM-LINE-03] a rollback wakes a command wait even while its engine acknowledgement is pending', async (t) => {
  const submitted = Promise.withResolvers();
  const acknowledge = Promise.withResolvers();
  const f = await fixture(t, { onResponse: async () => {
    submitted.resolve();
    await acknowledge.promise;
  } });
  t.after(() => acknowledge.resolve());
  const { result: running } = await f.call('play_line', { ...f.request, waitMs: 0 });
  assert.equal(running.planOwnsExecution, true);
  await submitted.promise;
  const next = f.call('wait_for_decision', { gameId, commandId: f.request.commandId, timeoutMs: 200 });
  f.update({ epoch: 2, decision: null, rollbackRequest: { id: 'rewind-2' } });
  const { result } = await next;
  assert.equal(result.event, 'rollback');
  assert.equal(result.needsAgent, true);
  assert.equal(result.state.rollbackRequest.id, 'rewind-2');
  assert.equal(f.applied.length, 1);
  acknowledge.resolve();
});

test('[PM-LINE-03] a pending rollback takes priority over filters and gameplay', async (t) => {
  const f = await fixture(t, { initial: { rollbackRequest: { id: 'pending' } } });
  const { result } = await f.call('wait_for_decision', { gameId, afterCursor: f.request.cursor });
  assert.equal(result.event, 'rollback');
  assert.equal((await f.call('play_line', f.request)).result.code, 'rollback_pending');
  assert.equal((await f.call('submit_decision', {
    gameId, cursor: f.request.cursor, decisionId: 'first', choiceId: 'first-answer', idempotencyKey: 'pending-choice',
  })).result.code, 'rollback_pending');
  assert.deepEqual(f.applied, []);
});

test('[PM-LINE-03] an opt-in compact view retains exact options and available state fields', async (t) => {
  const cottage = { id: 'cottage', name: 'Restless Cottage', types: ['LAND', 'CREATURE'], power: '4', toughness: '4',
    hints: ['Use this permanent as a mana source or animate it.'], rules: ['Restless Cottage enters tapped.'], setCode: 'WOE', cardNumber: '258' };
  const first = { id: 'first', kind: 'priority', instruction: 'Play spells and abilities',
    choices: [{ id: 'tap', label: cottage.name, objectId: cottage.id, type: 'manaAbility', card: cottage }] };
  const f = await fixture(t, { first, initial: { ownHand: [cottage] } });
  const { result: full } = await f.call('get_game_state', { gameId });
  const { result: compact } = await f.call('get_game_state', { gameId, view: 'compact' });
  const { setCode, cardNumber, ...playable } = cottage;
  assert.deepEqual(compact.ownHand, [playable]);
  const { card, ...choiceWithoutCard } = first.choices[0];
  assert.deepEqual(compact.decision.choices, [{ ...choiceWithoutCard, cardRef: cottage.id }]);
  assert.equal(compact.cursor, full.cursor);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(full)));
});

for (const variant of ['channel-only', 'land-only', 'land-and-channel', 'different-source', 'two-land-faces']) {
  test(`[PM-LINE-01] Boseiju land intent acts only on a verified land action: ${variant}`, async (t) => {
    const boseiju = { id: 'boseiju', name: 'Boseiju, Who Endures', cardId: 'boseiju', types: ['LAND'] };
    const landPlayable = variant !== 'channel-only';
    const first = { id: 'first', kind: 'priority', choices: [{ id: 'land-object', type: 'object', card: boseiju,
      objectId: boseiju.id, ...(landPlayable ? { canPlayLand: true } : {}) }] };
    const picker = { id: 'picker', kind: 'panel', panelKind: 'chooseAbility', sourceObjectId: variant === 'different-source' ? 'different-land' : boseiju.id,
      choices: [{ id: 'channel', label: 'Channel', abilityType: 'ACTIVATED_NONMANA' },
        { id: 'land', label: 'Play Boseiju, Who Endures', abilityType: 'PLAY_LAND' },
        ...(variant === 'two-land-faces' ? [{ id: 'other-land', label: 'Play the other face', abilityType: 'PLAY_LAND' }] : []),
      ] };
    const f = await fixture(t, { first, initial: { ownHand: [boseiju] }, onResponse: ({ choiceId }, update, state) => {
      assert.notEqual(choiceId, 'channel');
      if (variant !== 'land-only' && choiceId === 'land-object') update({ decision: picker });
      else update({ decision: choice('after', 'priority'), ownHand: [], players: [{ ...state.players[0], battlefield: [boseiju] }, state.players[1]] });
    } });
    const { result } = await f.call('play_line', { ...f.request, actions: [
      { kind: 'play', playAs: 'land', select: { cardId: boseiju.id, zone: 'hand' } },
    ] });
    if (!landPlayable) {
      assert.equal(result.reason, 'illegal_choice');
      assert.deepEqual(f.applied, []);
    } else if (variant === 'different-source' || variant === 'two-land-faces') {
      assert.equal(result.reason, 'response_available');
      assert.equal(result.state.decision.id, picker.id);
      assert.deepEqual(f.applied.map(({ choiceId }) => choiceId), ['land-object']);
    } else {
      assert.equal(result.status, 'completed', JSON.stringify(result));
      assert.deepEqual(f.applied.map(({ choiceId }) => choiceId), variant === 'land-only' ? ['land-object'] : ['land-object', 'land']);
    }
  });
}

test('[PM-LINE-03] a stale request returns the current same-game state without sending an answer', async (t) => {
  const f = await fixture(t);
  f.update({ decision: choice('new') });
  const stale = await f.call('play_line', f.request);
  assert.equal(stale.isError, false);
  assert.equal(stale.result.code, 'stale_decision');
  assert.equal(stale.result.state.decision.id, 'new');
  const foreign = await f.call('play_line', { ...f.request, gameId: otherGame });
  assert.equal(foreign.isError, true);
  assert.equal(foreign.result.state, undefined);
  assert.equal(f.applied.length, 0);
});
