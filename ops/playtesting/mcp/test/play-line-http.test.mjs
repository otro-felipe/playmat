import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describeAgentDecision, projectedChoices } from '../dist/engine-core.mjs';
import { createMcpServer } from '../src/server.mjs';

const gameId = '00000000-0000-4000-8000-000000000001';
const otherGame = '00000000-0000-4000-8000-000000000002';
const choice = (id, kind = 'amount', instruction = 'Choose an amount') => ({
  id, kind, instruction, choices: [{ id: `${id}-answer`, type: 'number', label: `Answer for ${id}` }],
});

async function fixture(t, { first = choice('first'), onResponse = () => {}, evidence = true, initial = {}, authorized = () => true } = {}) {
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
    async respond(decisionId, choiceId, value, line) {
      const answer = { decisionId, choiceId, value, ...(line && { line }) };
      applied.push(answer);
      await onResponse(answer, update, state);
      return { submitted: true, gameId, cursor: state.cursor };
    },
  };
  const server = createMcpServer({
    authorize: async (token) => token === 'fixture' && authorized() ? { accountId: 'fixture', engineName: 'pilot', scopes: ['play'] } : null,
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
  return { call, request, applied, update, listTools: () => client.listTools(),
    rawCall: (name, args) => client.callTool({ name, arguments: args }) };
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

test('[PM-LINE-MCP-2] the turn guide examples pass the published native MCP input contracts', async (t) => {
  const f = await fixture(t);
  const { result: { text: guide } } = await f.call('get_guide', { guideId: 'turn-planning' });
  const examples = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map(([, body]) => JSON.parse(body));
  const lines = examples.filter(({ actions }) => actions);
  const commandIds = new Set(lines.map(line => line.commandId));
  for (const id of ['rage-lethal-001', 'skip-unavailable-land-001', 'resolve-visible-response-001',
    'animate-and-attack-001', 'burn-and-land-001', 'order-triggers-001',
    'land-cast-attack-001', 'burst-at-own-nemesis-001', 'rage-valiant-001', 'saga-entry-001', 'opening-land-after-bottom', 'pass-to-own-draw-001', 'opening-upkeep-draw-001', 'shock-to-combat-001']) {
    assert.ok(commandIds.has(id), `Missing guide example ${id}`);
  }
  assert.equal(examples[0].commandId, 'rage-lethal-001', 'The XMage fixture binds the first JSON example');
  assert.equal(examples[0].actions[0].select.objectId, '<rage-object-id>');
  const passToEnd = [{ kind: 'pass_until', destination: 'end_step', policy: 'if_no_play' }];
  const combat = lines.find(line => line.commandId === 'shock-to-combat-001');
  assert.deepEqual(combat.actions.map(action => action.kind), ['play', 'pass_until']);
  assert.deepEqual(combat.actions[1], { kind: 'pass_until', destination: 'current_turn', step: 'BEGIN_COMBAT', priority: 'self', policy: 'if_no_play' });
  assert.ok(combat.actions[0].targets?.length === 1 && combat.actions[0].payWith?.length === 1);
  const withoutLand = lines.find(line => line.commandId === 'skip-unavailable-land-001');
  assert.deepEqual(withoutLand.actions, passToEnd, 'Recover from an unavailable land without queuing it again');
  const continuation = lines.find(line => line.commandId === 'resolve-visible-response-001');
  assert.deepEqual(continuation.expectedStackIds.toSorted(),
    ['<burst-lightning-stack-id>', '<fatal-push-stack-id>', '<prowess-trigger-stack-id>'],
    'Adopt both the opposing response and the two previously visible friendly objects');
  assert.deepEqual(continuation.actions, passToEnd);
  for (const args of lines) {
    const { isError, result } = await f.call('play_line', args);
    assert.equal(isError, false, args.commandId);
    assert.equal(result.stage, 'preflight', JSON.stringify(result.issues));
    assert.equal(result.code, 'stale_decision', args.commandId);
    assert.equal(result.appliedDecisions, 0);
  }
  const recover = examples.find(({ timeoutMs }) => timeoutMs);
  assert.equal(recover.commandId, lines[0].commandId);
  assert.equal(recover.gameId, lines[0].gameId);
  const { result } = await f.call('wait_for_decision', recover);
  assert.equal(result.code, 'unknown_command');
  assert.deepEqual(f.applied, []);
});

test('[PM-LINE-WAIT-1] published command waits and skipped opening draw run through native HTTP', async t => {
  const openingPhase = { turn: 1, phase: 'BEGINNING', step: 'UPKEEP', priority: 'self' };
  const f = await fixture(t, {
    first: readyToPass('upkeep'), initial: openingPhase,
    onResponse: (_answer, update) => update({ phase: 'PRECOMBAT_MAIN', step: 'PRECOMBAT_MAIN', decision: readyToPass('main') }),
  });
  const { result: { text } } = await f.call('get_guide', { guideId: 'turn-planning' });
  const examples = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(([, json]) => JSON.parse(json));
  const opening = examples.find(args => args.commandId === 'opening-upkeep-draw-001');
  const { result: skipped } = await f.call('play_line', { ...opening, cursor: f.request.cursor });
  assert.equal(skipped.reason, 'destination_skipped');
  assert.equal(skipped.lastDestination.step, 'PRECOMBAT_MAIN');
  assert.equal(skipped.needsAgent, true);
  assert.equal(f.applied.length, 1);
  const [line, wait] = examples.filter(args => args.commandId === 'pass-to-own-draw-001');
  assert.equal(line.waitMs, 0);
  assert.deepEqual(wait, { gameId: line.gameId, commandId: line.commandId, timeoutMs: 25000, view: 'compact' });
  f.update({ priority: 'opponent', decision: null });
  const { result: first } = await f.call('play_line', { ...line, cursor: skipped.state.cursor + 1 });
  assert.equal(first.waitingFor, 'opponent');
  const bad = await f.rawCall('wait_for_decision', { ...wait, timeoutMs: 45000 });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /timeoutMs/);
  assert.match(bad.content[0].text, /25000/);
  const pending = f.call('wait_for_decision', wait);
  f.update({ sequenceEvidence: { epoch: 'fixture', resolutionRevision: 0, resolutions: {},
    publicActions: { pilot: 0, rival: 1 }, informationRevision: 0, combatRevision: 0, combatDamage: [] } });
  const { result: stopped } = await pending;
  assert.equal(stopped.sequenceId, first.sequenceId);
  assert.equal(stopped.reason, 'opponent_action');
  assert.equal(stopped.needsAgent, false);
  const cursorWait = examples.find(args => args.afterCursor === 982);
  f.update({ priority: 'self', decision: readyToPass('fresh') });
  const { result: fresh } = await f.call('wait_for_decision', { ...cursorWait, afterCursor: stopped.state.cursor });
  assert.equal(fresh.state.decision.id, 'fresh');
  assert.equal(f.applied.length, 1);
});

test('the London guide answers each observed decision with the current cursor and choice', async (t) => {
  const guide = await readFile(new URL('../guides/turn-planning.md', import.meta.url), 'utf8');
  const examples = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map(([, body]) => JSON.parse(body))
    .filter(({ commandId }) => ['london-redraw-001', 'london-bottom-002', 'london-keep-003'].includes(commandId));
  const hand = Array.from({ length: 7 }, (_, index) => ({ id: 'card-' + index, name: 'Forest', types: ['LAND'] }));
  const openingHand = hand.map(card => ({ ...card, id: 'opening-' + card.id }));
  const prompts = [
    { id: 'opening-decision', kind: 'mulligan', choices: [{ id: 'take-mulligan', label: 'Mulligan' }] },
    { id: 'bottom-decision', kind: 'mulliganBottom', choices: [{ id: 'bottom-forest', card: hand[0] }] },
    { id: 'redrawn-decision', kind: 'mulligan', choices: [{ id: 'keep-six', label: 'Keep' }] },
  ];
  assert.equal(examples.length, prompts.length, 'Show Mulligan, the bottom-card choice and Keep as separate calls');
  const cursor = examples[0].cursor;
  const f = await fixture(t, { first: prompts[0], initial: { cursor, turn: 0, ownHand: openingHand, step: null },
    onResponse: ({ decisionId }, update) => {
      const index = prompts.findIndex(prompt => prompt.id === decisionId);
      update({ decision: prompts[index + 1] ?? choice('next'), ownHand: index === 0 ? hand : hand.slice(1) });
    },
  });
  for (const [index, args] of examples.entries()) {
    assert.equal(args.actions.length, 1, 'Leave the next decision to its observed prompt');
    const { result } = await f.call('play_line', args);
    assert.equal(result.appliedDecisions, 1, args.commandId);
    assert.equal(result.state.decision.id, prompts[index + 1]?.id ?? 'next');
  }
  assert.deepEqual(f.applied.map(({ decisionId, choiceId }) => [decisionId, choiceId]),
    prompts.map(({ id, choices }) => [id, choices[0].id]));
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

for (const status of ['game_over', 'match_over', 'sideboarding']) {
  test(`an observed ${status} ends a line without claiming its queued decisions or replaying its last answer`, async t => {
    const ack = Promise.withResolvers();
    const sent = Promise.withResolvers();
    const f = await fixture(t, { onResponse: async (_answer, update) => {
      update({ status, decision: null, ...(status === 'sideboarding' && { epoch: 2, sideboard: { submitted: false } }) });
      sent.resolve();
      await ack.promise;
    } });
    const line = { ...f.request, actions: [...f.request.actions, { kind: 'choose', guard: { kind: 'amount', instruction: 'Choose the next amount' }, select: { label: 'Answer for second' }, value: 1 }] };
    const { result: running } = await f.call('play_line', { ...line, waitMs: 0 });
    assert.equal(running.planOwnsExecution, true, JSON.stringify(running));
    await sent.promise;
    ack.resolve();
    const args = { gameId, commandId: line.commandId };
    for (const reply of [await f.call('wait_for_decision', args), await f.call('play_line', line)]) {
      assert.equal(reply.result.status, 'ended');
      assert.equal(reply.result.reason, status);
      assert.equal(reply.result.event, status);
      assert.equal(reply.result.appliedDecisions, 1);
      assert.equal(reply.result.planOwnsExecution, false);
      assert.equal(reply.result.needsAgent, status === 'sideboarding');
      assert.ok(!reply.result.error);
    }
    assert.equal(f.applied.length, 1);
  });
}

test('a terminal callback does not hide a rejected answer or an invalidated plan', async t => {
  for (const cause of ['rejected', 'rollback']) {
    const f = await fixture(t, { onResponse: (_answer, update) => {
      if (cause === 'rollback') update({ epoch: 2, decision: null, rollbackRequest: { id: 'rewind' } });
      update({ status: 'game_over', decision: null, rollbackRequest: null });
      if (cause === 'rejected') throw new Error('Engine did not acknowledge the response');
    } });
    let { result } = await f.call('play_line', f.request);
    if (result.planOwnsExecution) ({ result } = await f.call('wait_for_decision', { gameId, commandId: f.request.commandId }));
    assert.equal(result.status, 'interrupted');
    assert.equal(result.reason, cause === 'rollback' ? 'invalidated' : 'action_failed');
    assert.equal(result.appliedDecisions, cause === 'rollback' ? 1 : 0);
  }
});

test('a grant that expires at the terminal callback cannot read the outcome', async t => {
  let allowed = true;
  const f = await fixture(t, { authorized: () => allowed, onResponse: (_answer, update) => {
    allowed = false;
    update({ status: 'match_over', decision: null });
  } });
  const { result } = await f.call('play_line', f.request);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.reason, 'authorization_expired');
  assert.equal(result.state, null);
  assert.equal(result.appliedDecisions, 1);
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

test('[PM-LINE-MCP-3] the native catalog describes when a land and a terminal pass can execute', async (t) => {
  const f = await fixture(t);
  const { tools } = await f.listTools();
  const { properties } = tools.find(tool => tool.name === 'play_line').inputSchema;
  assert.match(properties.actions.description, /at most one.*pass_priority.*pass_until.*last/i);
  const play = properties.actions.items.anyOf.find(action => action.properties.kind?.const === 'play');
  assert.match(play.properties.playAs.description, /canPlayLand:true/);
});

for (const variant of ['absent-choice', 'unmatched-selector', 'ambiguous-selector', 'unavailable-spell']) {
  test(`[PM-LINE-SEM-7] an unavailable play stops before its queued pass: ${variant}`, async (t) => {
    const mountain = { id: 'mountain-1', name: 'Mountain', types: ['LAND'] };
    const other = { ...mountain, id: 'mountain-2' };
    const legalChoices = variant === 'ambiguous-selector' ? [mountain, other]
      : variant === 'unmatched-selector' ? [other] : [];
    const first = { id: 'main', kind: 'priority', choices: [
      { id: 'pass', type: 'pass' },
      ...legalChoices.map(card => ({ id: card.id, card, type: 'object', canPlayLand: true })),
    ] };
    const f = await fixture(t, { first, initial: { ownHand: [mountain, other] } });
    const play = variant === 'unavailable-spell' ? { kind: 'play', select: { objectId: 'missing-spell' } }
      : { kind: 'play', playAs: 'land', select: variant === 'ambiguous-selector'
        ? { cardName: 'Mountain', zone: 'hand' } : { objectId: mountain.id, zone: 'hand' } };
    const { result } = await f.call('play_line', { ...f.request, actions: [play, { kind: 'pass_priority' }] });
    const expected = { 'ambiguous-selector': 'ambiguous_choice', 'unavailable-spell': 'illegal_choice' };
    assert.equal(result.reason, expected[variant] ?? 'land_play_unavailable');
    if (result.reason === 'land_play_unavailable') assert.match(result.error.message, /canPlayLand:true/);
    assert.equal(result.status, 'interrupted');
    assert.equal(result.stage, 'execution');
    assert.equal(result.error.actionIndex, 0);
    assert.equal(result.appliedDecisions, 0);
    assert.deepEqual(f.applied, []);
  });
}

for (const actions of [
  [{ kind: 'pass_priority' }, { kind: 'pass_until', destination: 'my_draw' }],
  [{ kind: 'pass_until', destination: 'end_step' }, { kind: 'pass_priority' }],
  [{ kind: 'pass_priority' }, { kind: 'attack', attackers: [] }],
]) {
  test(`[PM-LINE-MCP-3] preflight explains a premature ${actions[0].kind} before ${actions[1].kind}`, async (t) => {
    const f = await fixture(t);
    const { result } = await f.call('play_line', { ...f.request, actions });
    assert.equal(result.status, 'rejected');
    assert.equal(result.stage, 'preflight');
    assert.equal(result.code, 'bad_sequence');
    assert.equal(result.actionIndex, 0);
    assert.match(result.message, /at most one.*pass_priority.*pass_until.*last/i);
    assert.equal(result.appliedDecisions, 0);
    assert.deepEqual(f.applied, []);
  });
}

for (const newResponse of [false, true]) {
  test(`[PM-LINE-FLOW-3] adopted response stack ${newResponse ? 'stops for a later opposing spell' : 'resolves to the end step'}`, async (t) => {
    const stack = [
      { id: 'push', name: 'Fatal Push', controllerId: 'rival' },
      { id: 'prowess', abilityText: 'Prowess', abilityType: 'TRIGGERED_NONMANA', controllerId: 'pilot' },
      { id: 'burst', name: 'Burst Lightning', controllerId: 'pilot' },
    ];
    const priority = id => ({ id, kind: 'priority', choices: [{ id: 'pass', type: 'pass' }] });
    const f = await fixture(t, { first: priority('after-response'), initial: { stack },
      onResponse: ({ choiceId }, update, state) => {
        assert.equal(choiceId, 'pass');
        const evidence = state.sequenceEvidence;
        if (newResponse && state.stack.length === 2) {
          update({ stack: [{ id: 'new-spell', name: 'Shock', controllerId: 'rival' }, ...state.stack],
            sequenceEvidence: { ...evidence, publicActions: { pilot: 0, rival: 1 } }, decision: priority('new-response') });
          return;
        }
        const [resolved, ...remaining] = state.stack;
        const revision = evidence.resolutionRevision + 1;
        update({ stack: remaining, decision: priority('after-' + resolved.id),
          sequenceEvidence: { ...evidence, resolutionRevision: revision, resolutions: { ...evidence.resolutions, [resolved.id]: revision } },
          ...(remaining.length === 0 && { phase: 'END', step: 'END_TURN' }) });
      },
    });
    const { result } = await f.call('play_line', { ...f.request, expectedStackIds: stack.map(card => card.id),
      actions: [{ kind: 'pass_until', destination: 'end_step', policy: 'if_no_play' }] });
    assert.equal(result.status, newResponse ? 'interrupted' : 'completed', JSON.stringify(result));
    if (newResponse) {
      assert.equal(result.reason, 'opponent_action');
      assert.equal(result.state.stack[0].id, 'new-spell');
    } else {
      assert.equal(result.state.step, 'END_TURN');
      assert.deepEqual(result.state.stack, []);
    }
    assert.deepEqual(f.applied.map(answer => answer.decisionId), newResponse
      ? ['after-response', 'after-push'] : ['after-response', 'after-push', 'after-prowess']);
  });
}

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
      assert.equal(result.reason, 'land_play_unavailable');
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

const landActivations = [
  { name: 'Mutavault', text: "{1}: Mutavault becomes a 2/2 creature with all creature types until end of turn. It's still a land." },
  { name: "Mishra's Factory", text: "{1}: Mishra's Factory becomes a 2/2 Assembly-Worker artifact creature until end of turn. It's still a land." },
];

function priorityWithActivations(land, abilities, hasManaAbility = true) {
  const prompt = { kind: 'priority', text: 'Play spells and abilities', options: {} };
  const view = { step: 'PRECOMBAT_MAIN', players: [{ playerId: 'pilot', battlefield: { [land.id]: land } }],
    canPlayObjects: { objects: { [land.id]: {
      basicManaAbilities: hasManaAbility ? [{ id: 'mana-id', abilityType: 'ACTIVATED_MANA', value: '{T}: Add {C}.' }] : [],
      other: abilities,
    } } } };
  return describeAgentDecision(projectedChoices({ playerId: 'pilot', view, prompt,
    interaction: { mode: 'priority', prompt, headline: prompt.text, mainButton: null, secondaryButtons: [],
      clickable: new Map([[land.id, { type: 'uuid', id: land.id }]]) } }, 'priority-before'));
}

async function activationFixture(t, { name, text }, variant) {
  const land = { id: 'creature-land', name, types: ['LAND'], rules: ['{T}: Add {C}.', text] };
  const mana = { id: 'mana-source', name: 'Mountain', types: ['LAND'] };
  const own = { id: 'pilot', yourSeat: true, battlefield: [land, mana] };
  const rival = { id: 'rival', yourSeat: false, battlefield: [], life: 20 };
  const pass = { id: 'pass', label: 'Pass', type: 'pass' };
  const animation = { id: 'animate', label: text, type: 'option', abilityType: 'ACTIVATED_NONMANA', abilityId: 'animation-id' };
  const activation = { id: 'animation-on-stack', sourceId: land.id, abilityType: animation.abilityType,
    abilityText: text, controllerId: own.id };
  const template = text.replaceAll(name, '{this}');
  const summary = template.length > 50 ? template.slice(0, 49) + '...' : template;
  const ambiguous = variant === 'ambiguous-summary' || variant === 'ambiguous-full-rule';
  if (ambiguous) land.rules.push(text.replace('until end of turn', 'until your next turn'));
  const legalId = variant === 'unavailable-ability' ? 'other-ability-id' : animation.abilityId;
  const first = priorityWithActivations(land, [
    { id: legalId, abilityType: animation.abilityType, value: summary },
    ...(ambiguous ? [{ id: 'other-animation', abilityType: animation.abilityType, value: summary }] : []),
  ], variant !== 'direct');
  const [projected] = first.choices[0].nonManaAbilities;
  assert.equal(projected.abilityText, ambiguous ? undefined : text);
  if (variant === 'legacy-unique-summary') delete projected.abilityText;
  const second = { id: 'picker', kind: 'panel', sourceObjectId: land.id, choices: [
    { id: 'make-mana', type: 'option', label: '{T}: Add {C}.', abilityType: 'ACTIVATED_MANA', abilityId: 'mana-id' },
    variant === 'changed-option' ? { ...animation, abilityId: 'different-ability-id' } : animation,
  ] };
  const targeted = variant === 'targeted-ability';
  const target = { id: 'target', kind: 'target', targetSourceId: land.id, targetRole: 0, targetZone: 'BATTLEFIELD',
    choices: [{ id: 'choose-creature', type: 'object', objectId: 'public-creature' }] };
  const pay = { id: 'cost', kind: 'payMana', paymentSourceId: variant === 'changed-payment' ? 'other' : land.id,
    choices: [{ id: 'tap-source', type: 'manaAbility', objectId: mana.id, card: mana,
      manaAbilities: [{ abilityId: 'mountain-id', manaColors: ['R'] }] }] };
  const afterPay = { id: 'resolve', kind: 'priority', choices: [pass] };
  let abilityText = text;
  if (variant === 'from-priority') abilityText = projected.abilityText;
  if (variant === 'ambiguous-full-rule') abilityText = land.rules.at(-1);
  if (variant === 'copied-summary' || variant === 'ambiguous-summary') abilityText = projected.label;
  const requestAction = { kind: 'activate', sourceId: first.choices[0].objectId,
    abilityId: variant === 'unavailable-ability' ? animation.abilityId : projected.abilityId, abilityText,
    ...(targeted ? { targets: [{ select: { objectId: 'public-creature' }, targetZone: 'BATTLEFIELD', role: 0 }] } : {}),
    ...(variant === 'unwitnessed-activation' ? {} : { payWith: [{ sourceId: mana.id, color: 'R' }] }) };
  const f = await fixture(t, {
    first, initial: { players: [own, rival] },
    onResponse: ({ decisionId, choiceId }, update, state) => {
      if (decisionId === first.id) {
        assert.equal(choiceId, 'object-creature-land');
        if (variant === 'direct') update({ decision: pay });
        else if (variant === 'unwitnessed-activation') update({ decision: afterPay });
        else update({ decision: second });
      } else if (decisionId === second.id) {
        assert.equal(choiceId, 'animate');
        update({ decision: targeted ? target : pay, stack: [{ ...activation, unpaid: true,
          abilityText: variant === 'changed-stack' ? 'An unintended activation' : text }] });
      } else if (decisionId === target.id) {
        assert.equal(choiceId, 'choose-creature');
        update({ decision: pay, stack: [{ ...activation, unpaid: true, targets: ['public-creature'] }] });
      } else if (decisionId === pay.id) {
        assert.equal(choiceId, 'tap-source');
        update({ decision: afterPay, stack: [activation], players: [{ ...own, battlefield: [land, { ...mana, tapped: true }] }, rival] });
      } else if (decisionId === afterPay.id) {
        assert.equal(choiceId, 'pass');
        if (variant === 'rival-response') {
          update({ sequenceEvidence: { ...state.sequenceEvidence, publicActions: { pilot: 0, rival: 1 } },
            stack: [activation, { id: 'rival-spell', controllerId: rival.id, name: 'Lightning Bolt' }],
            decision: { id: 'respond-to-rival', kind: 'priority', choices: [pass] } });
        } else {
          update({ sequenceEvidence: { ...state.sequenceEvidence, resolutionRevision: 1, resolutions: { [activation.id]: 1 } },
            decision: { id: 'after-animation', kind: 'priority', choices: [pass] }, stack: [],
            players: [{ ...own, battlefield: [{ ...land, types: ['LAND', 'CREATURE'] }, { ...mana, tapped: true }] }, rival] });
        }
      } else assert.fail('The fixture received an unplanned decision');
    },
  });
  return { ...f, actions: variant === 'unwitnessed-activation'
    ? [requestAction, { kind: 'choose', select: { label: 'Pass' }, guard: { kind: 'priority' } }]
    : [requestAction] };
}

test('[PM-LINE-SEM-5] a summary truncated inside its source marker can identify only a unique full rule', () => {
  const name = 'Card $&';
  const template = '{1}: Choose a color. Until end of turn, target {this} becomes that color.';
  const label = template.slice(0, 49) + '...';
  assert.ok(label.endsWith('{t...'));
  const text = template.replace('{this}', () => name);
  const card = { id: 'fixture', name, rules: [text] };
  const ability = { id: 'color', abilityType: 'ACTIVATED_NONMANA', value: label };
  const projected = (abilities) => priorityWithActivations(card, abilities).choices[0].nonManaAbilities;
  assert.equal(projected([ability])[0].abilityText, text);
  assert.ok(projected([ability, { ...ability, id: 'another' }]).every(option => !option.abilityText));
});

test('[PM-LINE-SEM-5] native tool discovery publishes a typed activation action', async (t) => {
  const f = await fixture(t);
  const { tools } = await f.listTools();
  const schema = tools.find(({ name }) => name === 'play_line').inputSchema;
  const activation = schema.properties.actions.items.anyOf.find(({ properties }) => properties.kind?.const === 'activate');
  assert.deepEqual(activation?.required, ['kind', 'sourceId', 'abilityId', 'abilityText']);
  assert.ok(activation.properties.payWith);
  assert.ok(activation.properties.targets);
  const choose = schema.properties.actions.items.anyOf.find(({ properties }) => properties.kind?.const === 'choose');
  assert.ok(choose.properties.expectAbility, 'Existing guarded ability selections remain discoverable');
});

for (const land of landActivations) {
  test(`[PM-LINE-SEM-5] native line activates ${land.name}, pays the exact source and follows its resolution`, async (t) => {
    const f = await activationFixture(t, land, 'from-priority');
    const { isError, result } = await f.call('play_line', { ...f.request, actions: f.actions, view: 'compact' });
    assert.equal(isError, false, JSON.stringify(result));
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.state.decision.id, 'after-animation');
    assert.deepEqual(result.state.players[0].battlefield.map(({ types, tapped }) => [types, tapped]),
      [[['LAND', 'CREATURE'], undefined], [['LAND'], true]]);
    assert.deepEqual(f.applied.map(({ choiceId }) => choiceId), ['object-creature-land', 'animate', 'tap-source', 'pass']);
  });
}

for (const [variant, applied] of [
  ['direct', ['object-creature-land', 'tap-source', 'pass']],
  ['legacy-unique-summary', ['object-creature-land', 'animate', 'tap-source', 'pass']],
  ['targeted-ability', ['object-creature-land', 'animate', 'choose-creature', 'tap-source', 'pass']],
]) {
  test(`[PM-LINE-SEM-5] native activation handles ${variant}`, async (t) => {
    const input = variant !== 'targeted-ability' ? landActivations[0] : {
      name: 'Targeted fixture permanent', text: '{1}: Target creature gets +1/+1 until end of turn.',
    };
    const f = await activationFixture(t, input, variant);
    const { result } = await f.call('play_line', { ...f.request, actions: f.actions });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.deepEqual(f.applied.map(({ choiceId }) => choiceId), applied);
  });
}

for (const [variant, expected, applied] of [
  ['copied-summary', 'illegal_choice', []],
  ['ambiguous-summary', 'illegal_choice', []],
  ['ambiguous-full-rule', 'illegal_choice', []],
  ['unavailable-ability', 'illegal_choice', []],
  ['unwitnessed-activation', 'response_available', ['object-creature-land']],
  ['changed-option', 'illegal_choice', ['object-creature-land']],
  ['changed-stack', 'state_changed', ['object-creature-land', 'animate']],
  ['changed-payment', 'response_available', ['object-creature-land', 'animate']],
  ['rival-response', 'opponent_action', ['object-creature-land', 'animate', 'tap-source', 'pass']],
]) {
  test(`[PM-LINE-SEM-5] native activation stops at ${variant}`, async (t) => {
    const f = await activationFixture(t, landActivations[0], variant);
    const { result } = await f.call('play_line', { ...f.request, actions: f.actions });
    assert.equal(result.reason, expected, JSON.stringify(result));
    assert.deepEqual(f.applied.map(({ choiceId }) => choiceId), applied);
  });
}

for (const variant of ['exact', 'wrong-assignment', 'unexpected-prompt', 'mixed-selectors', 'duplicate-attacker']) {
  test(`[PM-LINE-COMBAT-2] native play_line binds the defender to the intended attacker: ${variant}`, async (t) => {
    const attacker = { id: 'attacker', controllerId: 'pilot' };
    const walker = { id: 'walker', controllerId: 'rival', types: ['PLANESWALKER'] };
    const declare = (id) => ({ id, kind: 'declareAttackers', choices: [
      { id: 'toggle-attacker', card: attacker, objectId: attacker.id },
      { id: 'confirm', intent: 'confirm_attack' }, { id: 'attack-all', intent: 'attack_all' },
    ] });
    const f = await fixture(t, { first: declare('declare'),
      initial: { step: 'DECLARE_ATTACKERS', combat: [], players: [
        { id: 'pilot', yourSeat: true, battlefield: [attacker] }, { id: 'rival', life: 20, battlefield: [walker] },
      ] },
      onResponse({ choiceId }, update) {
        if (choiceId === 'toggle-attacker') {
          update({ decision: { id: 'pick-destination', kind: 'target',
            instruction: variant === 'unexpected-prompt' ? 'Select target planeswalker' : 'Select a player, planeswalker, or battle to attack',
            choices: [{ id: 'wrong', objectId: 'rival' }, { id: 'right', objectId: walker.id, card: walker }] } });
        } else if (choiceId === 'right') {
          update({ decision: declare('confirm-selection'), combat: [{ defenderId: variant === 'wrong-assignment' ? 'rival' : walker.id,
            attackers: [attacker], blockers: [], isBlocked: false }] });
        } else {
          assert.equal(choiceId, 'confirm');
          update({ decision: { id: 'declared', kind: 'priority', choices: [{ id: 'pass', type: 'pass' }] } });
        }
      },
    });
    const { tools } = await f.listTools();
    const actions = tools.find(({ name }) => name === 'play_line').inputSchema.properties.actions;
    assert.ok(JSON.stringify(actions).includes('"defenderId"'), 'Native tool discovery exposes the exact defender');
    const attack = { kind: 'attack', assignments: [{ attackerId: attacker.id, defenderId: walker.id }] };
    if (variant === 'mixed-selectors') attack.attackers = 'all';
    if (variant === 'duplicate-attacker') attack.assignments.push({ attackerId: attacker.id, defenderId: 'rival' });
    const { isError, result } = await f.call('play_line', { ...f.request, actions: [attack] });
    assert.equal(isError, false);
    const expectedAnswerIds = {
      exact: ['toggle-attacker', 'right', 'confirm'], 'wrong-assignment': ['toggle-attacker', 'right'],
      'unexpected-prompt': ['toggle-attacker'], 'mixed-selectors': [], 'duplicate-attacker': [],
    };
    assert.equal(result.status, variant === 'exact' ? 'completed' : expectedAnswerIds[variant].length ? 'interrupted' : 'rejected',
      JSON.stringify(result));
    if (!expectedAnswerIds[variant].length) assert.equal(result.code, 'invalid_line_arguments');
    assert.deepEqual(f.applied.map(({ choiceId }) => choiceId), expectedAnswerIds[variant]);
  });
}

test('[PM-LINE-SEM-3] native MCP accepts the exact own-hand Ward discard guard', async (t) => {
  const card = { id: 'kumano', cardId: 'kumano', name: 'Kumano Faces Kakkazan' };
  const ward = { id: 'discard-cost', kind: 'target', targetZone: 'HAND', targetSourceId: 'trespasser',
    instruction: 'Select a card (discard cost)', choices: [{ id: 'discard-kumano', card, objectId: card.id }] };
  const f = await fixture(t, { first: ward, initial: { ownHand: [card] }, onResponse: (_choice, update) => {
    update({ ownHand: [], decision: choice('next', 'priority') });
  } });
  const { result } = await f.call('play_line', { ...f.request, actions: [{
    kind: 'choose', guard: { kind: 'target', targetZone: 'HAND', targetSourceId: 'trespasser',
      instruction: 'Select a card (discard cost)' }, select: { objectId: card.id, zone: 'hand' },
  }] });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.state.ownHand.length, 0);
  assert.deepEqual(f.applied.map(({ choiceId }) => choiceId), ['discard-kumano']);
});


test('[PM-LINE-REPLAY-1] one authored explanation reaches the first decision and survives receipt recovery', async t => {
  const f = await fixture(t, { onResponse: (_, update) => update({ decision: null, status: 'ended' }) });
  const args = { ...f.request, reasoning: 'Save removal for the creature that can block next turn.' };
  await f.call('play_line', args);
  await f.call('play_line', args);
  assert.equal(f.applied.length, 1);
  assert.deepEqual(f.applied[0].line, { commandId: args.commandId, reasoning: args.reasoning });
  const conflict = await f.call('play_line', { ...args, reasoning: 'Different objective' });
  assert.equal(conflict.result.code, 'key_conflict');
});

const readyToPass = (id) => ({ id, kind: 'priority', choices: [{ id: 'pass', type: 'pass' }] });
const button = (id, label, answer) => ({ id, type: 'button', label, answer });

for (const label of ['Even', 'Odd', 'changed instruction']) {
  test(`[PM-AC-09-RESPONSES] the guide preselects the Extinction Event question: ${label}`, async (t) => {
    const guide = await readFile(new URL('../guides/turn-planning.md', import.meta.url), 'utf8');
    const example = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map(([, body]) => JSON.parse(body))
      .find(({ commandId }) => commandId === 'extinction-even-001');
    assert.ok(example, 'Supply a copyable cast and labeled question');
    const spell = { id: 'event', cardId: 'event', name: 'Extinction Event', types: ['SORCERY'],
      rules: ['Choose odd or even. Exile each creature with mana value of the chosen quality.'] };
    const initial = readyToPass('cast');
    initial.choices.push({ id: 'cast-event', type: 'object', objectId: spell.id, card: spell });
    const parity = { id: 'parity', kind: 'question', instruction: label === 'changed instruction' ? 'Another question?' : 'Odd or even?',
      choices: [button('button-0', 'Even', false), button('button-1', 'Odd', true)] };
    const f = await fixture(t, { first: initial, initial: { ownHand: [spell] },
      onResponse: ({ decisionId }, update, state) => {
        if (decisionId === 'cast') {
          update({ ownHand: [], stack: [{ ...spell, id: 'stack-event', controllerId: 'pilot' }], decision: readyToPass('resolve') });
        } else if (decisionId === 'resolve') {
          update({ decision: parity, sequenceEvidence: { ...state.sequenceEvidence, resolutions: { 'stack-event': 1 }, resolutionRevision: 1 } });
        } else {
          assert.equal(decisionId, 'parity');
          update({ stack: [], decision: readyToPass('after') });
        }
      } });
    const actions = example.actions;
    actions[0].select.objectId = spell.id;
    assert.equal(actions[1].select.label, 'Even');
    if (label === 'Odd') actions[1].select.label = label;
    const { result } = await f.call('play_line', { ...example, cursor: f.request.cursor, actions });
    const choices = f.applied.map(({ choiceId }) => choiceId);
    if (label === 'changed instruction') {
      assert.equal(result.reason, 'response_available');
      assert.equal(result.state.decision.id, 'parity');
      assert.deepEqual(choices, ['cast-event', 'pass']);
    } else {
      assert.equal(result.status, 'completed', JSON.stringify(result.error));
      assert.deepEqual(choices, ['cast-event', 'pass', label === 'Odd' ? 'button-1' : 'button-0']);
    }
  });
}

test('[PM-AC-09-RESPONSES] a Yes/No question accepts its boolean answer', async (t) => {
  const first = { id: 'kicker', kind: 'question', instruction: 'Pay Kicker {4} ?',
    choices: [button('kicker-yes', 'Yes', true), button('kicker-no', 'No', false)] };
  const f = await fixture(t, { first, onResponse: (_answer, update) => update({ decision: readyToPass('after') }) });
  const { result } = await f.call('play_line', { ...f.request, actions: [
    { kind: 'choose', guard: { kind: 'question', instruction: first.instruction }, select: { answer: false } },
  ] });
  assert.equal(result.status, 'completed');
  assert.deepEqual(f.applied.map(({ choiceId }) => choiceId), ['kicker-no']);
});

test('[PM-AC-09-RESPONSES] a Liliana discard rejects the tail and teaches the exact observed-choice recovery', async (t) => {
  const ownCard = { id: 'own-land', name: 'Mountain', types: ['LAND'] };
  const stackObject = { id: 'loyalty-stack', controllerId: 'rival', abilityType: 'ACTIVATED_NONMANA',
    abilityText: '+1: Each player discards a card.' };
  const first = { id: 'discard', kind: 'target', instruction: 'Select a card to discard', targetZone: 'HAND',
    choices: [{ id: 'discard-land', type: 'object', objectId: ownCard.id, card: ownCard }] };
  const f = await fixture(t, { first, initial: { stack: [stackObject], ownHand: [ownCard] },
    onResponse: (_answer, update, state) => update({ stack: [], ownHand: [], decision: readyToPass('after'),
      players: state.players.map(player => player.yourSeat ? player : { ...player, graveyard: [{ id: 'shown', name: 'Forest' }] }) }) });
  const choose = { kind: 'choose', decisionId: first.id, choiceId: first.choices[0].id };
  const { result } = await f.call('play_line', { ...f.request, expectedStackIds: [stackObject.id], actions: [choose, { kind: 'pass_priority' }] });
  assert.equal(result.code, 'reevaluation_required');
  assert.equal(result.stage, 'preflight');
  assert.equal(result.appliedDecisions, 0);
  assert.deepEqual(f.applied, []);
  assert.match(result.message, /only.*decisionId.*choiceId.*inspect/i);
  const observed = result.state.decision;
  const { result: recovered } = await f.call('play_line', { gameId, cursor: result.state.cursor, commandId: 'discard-only',
    actions: [{ kind: 'choose', decisionId: observed.id, choiceId: observed.choices[0].id }] });
  assert.equal(recovered.reason, 'opponent_state_changed');
  assert.equal(recovered.appliedDecisions, 1);
  assert.deepEqual(f.applied.map(({ choiceId }) => choiceId), ['discard-land']);
});

test('[PM-AC-09-RESPONSES] an observed numeric decision includes its requested value in recovery', async (t) => {
  const first = choice('pay-life');
  const f = await fixture(t, { first, initial: { stack: [{ id: 'draw', controllerId: 'pilot', types: ['SORCERY'],
    rules: ['Draw a card.'] }] }, onResponse: (_answer, update) => update({ stack: [], decision: readyToPass('after') }) });
  const { result } = await f.call('play_line', { ...f.request, actions: [...f.request.actions, { kind: 'pass_priority' }] });
  assert.equal(result.code, 'reevaluation_required');
  assert.equal(result.appliedDecisions, 0);
  assert.match(result.message, /value/i);
  const { result: recovered } = await f.call('play_line', { ...f.request, commandId: 'pay-only' });
  assert.equal(recovered.appliedDecisions, 1);
  assert.deepEqual(f.applied.map(({ choiceId, value }) => [choiceId, value]), [['pay-life-answer', 2]]);
});

for (const boundary of ['reached', 'rival', 'information', 'mandatory', 'missed-step', 'changed-turn', 'unavailable']) {
  test(`[PM-LINE-WINDOW] one command reaches postcombat and plays there, or returns at ${boundary}`, async (t) => {
    const land = { id: 'mountain', cardId: 'mountain', name: 'Mountain', types: ['LAND'], rules: ['{T}: Add {R}.'] };
    const shock = { id: 'shock', cardId: 'shock', name: 'Shock', controllerId: 'pilot', types: ['INSTANT'] };
    const firstMountain = { ...land, id: 'first-mountain' },
      secondMountain = { ...land, id: 'second-mountain' };
    const mage = { id: 'mage', cardId: 'mage', name: 'Soul-Scar Mage', controllerId: 'pilot', types: ['CREATURE'] };
    const swift = { id: 'swift', name: 'Monastery Swiftspear', controllerId: 'pilot', types: ['CREATURE'] };
    const option = (card, id) => ({ id, type: 'object', objectId: card.id, card });
    const priority = (id, ...options) => ({ id, kind: 'priority', choices: [{ id: 'pass', type: 'pass' }, ...options] });
    const first = priority('land', { ...option(land, 'land-choice'), canPlayLand: true });
    const own = { id: 'pilot', yourSeat: true, battlefield: [swift, firstMountain, secondMountain] },
      other = { id: 'rival', life: 20, battlefield: [] };
    const evidence = {
      epoch: 'fixture',
      publicActions: { pilot: 0, rival: 0 },
      resolutionRevision: 0,
      resolutions: {},
      informationRevision: 0,
      combatRevision: 0,
      combatDamage: [],
    };
    const triggered = { id: 'prowess', abilityType: 'TRIGGERED_NONMANA', sourceId: 'swift', abilityText: 'Prowess', controllerId: 'pilot' };
    const stackShock = { ...shock, id: 'stack-shock' };
    const guide = await readFile(new URL('../guides/turn-planning.md', import.meta.url), 'utf8');
    const json = [...guide.matchAll(/```json\s*([\s\S]*?)```/g)]
      .map((hit) => hit[1])
      .find((example) => example.includes('"red-full-turn-001"'));
    assert.ok(json, 'The actual published full-turn example is required');
    const ids = {
      '<mountain-in-hand-id>': land.id,
      '<shock-id>': shock.id,
      '<opponent-id>': 'rival',
      '<first-mountain-id>': firstMountain.id,
      '<swiftspear-id>': swift.id,
      '<full-visible-prowess-text>': 'Prowess',
      '<soul-scar-mage-id>': mage.id,
      '<second-mountain-id>': secondMountain.id,
    };
    const request = JSON.parse(
      json.replace(/<[^>]+>/g, (token) => {
        assert.ok(Object.hasOwn(ids, token));
        return ids[token];
      }),
    );
    const played = [];
    const f = await fixture(t, {
      first,
      initial: { cursor: request.cursor, players: [own, other], ownHand: [land, shock, mage], sequenceEvidence: evidence },
      onResponse({ decisionId, choiceId }, update, state) {
        played.push([state.step, choiceId]);
        switch (decisionId) {
          case 'land':
            return update({
              ownHand: [shock, mage],
              players: [{ ...own, battlefield: [swift, firstMountain, secondMountain, land] }, other],
              decision: priority('cast', option(shock, 'cast-shock')),
            });
          case 'cast':
            return update({
              ownHand: [mage],
              stack: [stackShock],
              decision: {
                id: 'target',
                kind: 'target',
                targetSourceId: shock.id,
                targetRole: 0,
                choices: [{ id: 'opponent', type: 'object', objectId: 'rival' }],
              },
            });
          case 'target':
            return update({
              decision: { id: 'pay', kind: 'payMana', choices: [{ ...option(firstMountain, 'tap'), type: 'manaAbility' }] },
            });
          case 'pay':
            return update({ stack: [stackShock, triggered], decision: priority('resolve-trigger') });
          case 'resolve-trigger':
            return update({
              stack: [stackShock],
              sequenceEvidence: { ...evidence, resolutionRevision: 1, resolutions: { prowess: 1 } },
              decision: priority('resolve-shock'),
            });
          case 'resolve-shock':
            return update({
              stack: [],
              sequenceEvidence: { ...evidence, resolutionRevision: 2, resolutions: { prowess: 1, 'stack-shock': 2 } },
              players: [{ ...own, battlefield: [swift, { ...firstMountain, tapped: true }, secondMountain, land] }, other],
              decision: priority('beginning'),
            });
          case 'beginning':
            return update({
              step: 'DECLARE_ATTACKERS',
              decision: { id: 'attack', kind: 'declareAttackers', choices: [option(swift, 'attack-swift')] },
            });
          case 'attack':
            return update({
              combat: [{ attackers: [swift], blockers: [] }],
              decision: { id: 'confirm', kind: 'declareAttackers', choices: [{ id: 'confirm-attack', intent: 'confirm_attack' }] },
            });
          case 'confirm':
            return update({ step: 'END_COMBAT', decision: priority('end-combat') });
          case 'end-combat': {
            const frame = {
              step: 'POSTCOMBAT_MAIN',
              phase: 'POSTCOMBAT_MAIN',
              decision: priority('postcombat', option(mage, 'cast-mage')),
            };
            if (boundary === 'rival') frame.sequenceEvidence = { ...state.sequenceEvidence, publicActions: { pilot: 0, rival: 1 } };
            if (boundary === 'information') frame.ownHand = [mage, { id: 'unseen', name: 'New card' }];
            if (boundary === 'mandatory') frame.decision = { id: 'mandatory', kind: 'target', choices: [{ id: 'unknown-target' }] };
            if (boundary === 'missed-step') frame.step = 'END_TURN';
            if (boundary === 'changed-turn') Object.assign(frame, { turn: 4, activePlayerId: 'rival' });
            if (boundary === 'unavailable') frame.decision = priority('postcombat');
            return update(frame);
          }
          case 'postcombat':
            return update({
              ownHand: [],
              stack: [{ ...mage, id: 'stack-mage' }],
              decision: { id: 'post-pay', kind: 'payMana', choices: [{ ...option(secondMountain, 'tap-other'), type: 'manaAbility' }] },
            });
          case 'post-pay':
            return update({ decision: priority('resolve-mage') });
          case 'resolve-mage':
            return update({
              stack: [],
              sequenceEvidence: {
                ...state.sequenceEvidence,
                resolutionRevision: 3,
                resolutions: { ...state.sequenceEvidence.resolutions, 'stack-mage': 3 },
              },
              decision: priority('advance'),
            });
          case 'advance':
            return update({ turn: 4, activePlayerId: 'rival', decision: priority('rival-turn') });
          case 'rival-turn':
            return update({
              turn: 5,
              activePlayerId: 'pilot',
              step: 'DRAW',
              phase: 'BEGINNING',
              ownHand: [{ id: 'drawn', name: 'New draw' }],
              sequenceEvidence: { ...state.sequenceEvidence, informationRevision: 1 },
              decision: priority('draw'),
            });
          default:
            assert.fail('Unexpected engine callback');
        }
      },
    });
    const { result } = await f.call('play_line', request);
    assert.equal(
      result.status,
      boundary === 'reached' ? 'completed' : 'interrupted',
      JSON.stringify({ code: result.code, reason: result.reason, actionIndex: result.actionIndex }),
    );
    const reasons = {
      rival: 'opponent_action',
      information: 'new_information',
      mandatory: 'response_available',
      'missed-step': 'destination_skipped',
      'changed-turn': 'destination_skipped',
      unavailable: 'illegal_choice',
    };
    if (boundary !== 'reached') assert.equal(result.reason, reasons[boundary]);
    assert.deepEqual(
      played.filter(([, id]) => id === 'cast-mage'),
      boundary === 'reached' ? [['POSTCOMBAT_MAIN', 'cast-mage']] : [],
    );
    assert.deepEqual(
      played.slice(0, 10).map(([, id]) => id),
      ['land-choice', 'cast-shock', 'opponent', 'tap', 'pass', 'pass', 'pass', 'attack-swift', 'confirm-attack', 'pass'],
    );
    const applied = played.length;
    const replay = await f.call('wait_for_decision', { gameId, commandId: request.commandId });
    assert.equal(replay.result.appliedDecisions, applied);
    assert.equal(played.length, applied);
    if (boundary === 'reached') assert.equal(result.lastDestination.step, 'DRAW');
  });
}

for (const variant of ['declared', 'ambiguous', 'announced-question', 'unannounced-question']) {
  const ambiguous = variant === 'ambiguous';
  const question = variant.endsWith('-question');
  test(`[PM-LINE-PAY] four declared sources and mana pickers: ${variant}`, async (t) => {
    const card = { id: 'four-mana-spell', cardId: 'four-mana-spell', name: 'Fixture creature', types: ['CREATURE'], controllerId: 'pilot' };
    const colors = ['B', 'G', 'B', 'G'];
    const sources = colors.map((color, i) => ({ id: 'source-' + i, name: 'Land ' + i, types: ['LAND'] }));
    const option = (id, color) => ({ abilityId: id, abilityType: 'ACTIVATED_MANA', manaColors: [color] });
    const options = (i) => [
      option('black-' + i, 'B'),
      option('green-' + i, 'G'),
      ...(ambiguous && i === 2 ? [option('second-black', 'B')] : []),
    ];
    const pay = (i) => ({
      id: 'pay-' + i,
      kind: 'payMana',
      paymentSourceId: card.id,
      choices: sources.slice(i).map((land, k) => ({
        id: 'tap-' + land.id,
        type: 'manaAbility',
        objectId: land.id,
        card: land,
        manaAbilities: options(i + k),
      })),
    });
    const picker = (i) => ({
      id: 'picker-' + i,
      kind: 'panel',
      sourceObjectId: sources[i].id,
      choices: options(i).map((ability) => ({ id: 'use-' + ability.abilityId, type: 'option', ...ability })),
    });
    const first = {
      id: 'initial',
      kind: 'priority',
      choices: [
        { id: 'cast', objectId: card.id, type: 'object', card },
        { id: 'pass', type: 'pass' },
      ],
    };
    const priority = (id) => ({ id, kind: 'priority', choices: [{ id: 'pass', type: 'pass' }] });
    const f = await fixture(t, {
      first,
      initial: {
        ownHand: [card],
        players: [
          { id: 'pilot', yourSeat: true, battlefield: sources },
          { id: 'rival', battlefield: [] },
        ],
      },
      onResponse({ decisionId }, update, state) {
        if (decisionId === 'initial') return update({ ownHand: [], stack: [{ ...card, id: 'on-stack' }], decision: pay(0) });
        if (decisionId.startsWith('pay-')) return update({ decision: picker(Number(decisionId.slice(-1))) });
        if (decisionId.startsWith('picker-')) {
          const i = Number(decisionId.slice(-1));
          const afterPayment = question
            ? {
                id: 'question',
                kind: 'question',
                instruction: 'Use the optional effect?',
                choices: [
                  { id: 'yes', type: 'button', label: 'Yes', answer: true },
                  { id: 'no', type: 'button', label: 'No', answer: false },
                ],
              }
            : priority('resolve');
          return update({ decision: i === 3 ? afterPayment : pay(i + 1) });
        }
        if (decisionId === 'question') return update({ decision: priority('resolve') });
        assert.equal(decisionId, 'resolve');
        return update({
          decision: priority('finished'),
          stack: [],
          sequenceEvidence: { ...state.sequenceEvidence, resolutionRevision: 1, resolutions: { 'on-stack': 1 } },
        });
      },
    });
    const { result } = await f.call('play_line', {
      ...f.request,
      actions: [
        {
          kind: 'play',
          select: { objectId: card.id, zone: 'hand' },
          payWith: sources.map((land, i) => ({ sourceId: land.id, color: colors[i], ...(i === 3 ? { abilityId: 'green-3' } : {}) })),
        },
        ...(variant === 'announced-question'
          ? [{ kind: 'choose', guard: { kind: 'question', instruction: 'Use the optional effect?' }, select: { answer: false } }]
          : []),
      ],
    });
    assert.equal(
      result.status,
      ambiguous || variant === 'unannounced-question' ? 'interrupted' : 'completed',
      JSON.stringify([result.reason, result.actionIndex, result.appliedDecisions]),
    );
    const paid = ['cast', 'tap-source-0', 'use-black-0', 'tap-source-1', 'use-green-1', 'tap-source-2'];
    if (ambiguous) assert.equal(result.reason, 'ambiguous_choice');
    else {
      paid.push('use-black-2', 'tap-source-3', 'use-green-3');
      if (variant === 'unannounced-question') assert.equal(result.reason, 'response_available');
      else {
        if (question) paid.push('no');
        paid.push('pass');
      }
    }
    assert.deepEqual(
      f.applied.map((a) => a.choiceId),
      paid,
    );
    assert.equal((await f.call('wait_for_decision', { gameId, commandId: f.request.commandId })).result.appliedDecisions, paid.length);
    assert.equal(f.applied.length, paid.length);
  });
}
