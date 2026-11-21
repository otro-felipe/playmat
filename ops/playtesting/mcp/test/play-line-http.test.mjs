import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
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

test('[PM-LINE-MCP-2] the turn guide examples pass the published native MCP input contracts', async (t) => {
  const guide = await readFile(new URL('../guides/turn-planning.md', import.meta.url), 'utf8');
  const examples = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map(([, body]) => JSON.parse(body));
  const lines = examples.filter(({ actions }) => actions);
  for (const id of ['rage-lethal-001', 'animate-and-attack-001', 'burn-and-land-001',
    'order-triggers-001', 'land-cast-attack-001', 'burst-at-own-nemesis-001', 'rage-valiant-001']) {
    assert.ok(lines.some((line) => line.commandId === id), `Missing guide example ${id}`);
  }
  assert.equal(lines[0].actions[0].select.objectId, '<rage-object-id>', 'The lethal is the first copyable example');
  const f = await fixture(t);
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

const landActivations = [
  { name: 'Mutavault', text: "{1}: Mutavault becomes a 2/2 creature with all creature types until end of turn. It's still a land." },
  { name: "Mishra's Factory", text: "{1}: Mishra's Factory becomes a 2/2 Assembly-Worker artifact creature until end of turn. It's still a land." },
];

async function activationFixture(t, { name, text }, variant) {
  const land = { id: 'creature-land', name, types: ['LAND'], rules: ['{T}: Add {C}.', text] };
  const mana = { id: 'mana-source', name: 'Mountain', types: ['LAND'] };
  const own = { id: 'pilot', yourSeat: true, battlefield: [land, mana] };
  const rival = { id: 'rival', yourSeat: false, battlefield: [], life: 20 };
  const pass = { id: 'pass', label: 'Pass', type: 'pass' };
  const animation = { id: 'animate', label: text, type: 'option', abilityType: 'ACTIVATED_NONMANA', abilityId: 'animation-id' };
  const activation = { id: 'animation-on-stack', sourceId: land.id, abilityType: animation.abilityType,
    abilityText: text, controllerId: own.id };
  const first = { id: 'priority-before', kind: 'priority', choices: [pass, {
    id: 'open-land', type: 'object', objectId: land.id, card: land,
    nonManaAbilities: [{ abilityId: variant === 'unavailable-ability' ? 'other-ability-id' : animation.abilityId, label: text }],
  }] };
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
  const requestAction = { kind: 'activate', sourceId: land.id, abilityId: animation.abilityId, abilityText: text,
    ...(targeted ? { targets: [{ select: { objectId: 'public-creature' }, targetZone: 'BATTLEFIELD', role: 0 }] } : {}),
    ...(variant === 'unwitnessed-activation' ? {} : { payWith: [{ sourceId: mana.id, color: 'R' }] }) };
  const f = await fixture(t, {
    first, initial: { players: [own, rival] },
    onResponse: ({ decisionId, choiceId }, update, state) => {
      if (decisionId === first.id) {
        assert.equal(choiceId, 'open-land');
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
    const f = await activationFixture(t, land);
    const { isError, result } = await f.call('play_line', { ...f.request, actions: f.actions, view: 'compact' });
    assert.equal(isError, false, JSON.stringify(result));
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.state.decision.id, 'after-animation');
    assert.deepEqual(result.state.players[0].battlefield.map(({ types, tapped }) => [types, tapped]),
      [[['LAND', 'CREATURE'], undefined], [['LAND'], true]]);
    assert.deepEqual(f.applied.map(({ choiceId }) => choiceId), ['open-land', 'animate', 'tap-source', 'pass']);
  });
}

for (const [variant, applied] of [
  ['direct', ['open-land', 'tap-source', 'pass']],
  ['targeted-ability', ['open-land', 'animate', 'choose-creature', 'tap-source', 'pass']],
]) {
  test(`[PM-LINE-SEM-5] native activation handles ${variant}`, async (t) => {
    const input = variant === 'direct' ? landActivations[0] : {
      name: 'Targeted fixture permanent', text: '{1}: Target creature gets +1/+1 until end of turn.',
    };
    const f = await activationFixture(t, input, variant);
    const { result } = await f.call('play_line', { ...f.request, actions: f.actions });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.deepEqual(f.applied.map(({ choiceId }) => choiceId), applied);
  });
}

for (const [variant, expected, applied] of [
  ['unavailable-ability', 'illegal_choice', []],
  ['unwitnessed-activation', 'response_available', ['open-land']],
  ['changed-option', 'illegal_choice', ['open-land']],
  ['changed-stack', 'state_changed', ['open-land', 'animate']],
  ['changed-payment', 'response_available', ['open-land', 'animate']],
  ['rival-response', 'opponent_action', ['open-land', 'animate', 'tap-source', 'pass']],
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
