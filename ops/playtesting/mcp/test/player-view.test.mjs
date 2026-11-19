import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpServer } from '../src/server.mjs';

const gameId = '00000000-0000-4000-8000-000000000091';
const rules = ['{T}: Add {B} or {G}.', '{2}{B}{G}: Restless Cottage becomes a 4/4 creature.'];
const cottage = {
  id: 'cottage', cardId: 'printed-cottage', name: 'Restless Cottage', controllerId: 'rival',
  types: ['LAND', 'CREATURE'], rules, hints: ['Mana ability'], setCode: 'WOE', cardNumber: '258',
  power: '4', toughness: '4', tapped: true, damage: 4,
};
const sheoldred = {
  id: 'sheoldred', cardId: 'printed-sheoldred', name: 'Sheoldred, the Apocalypse', controllerId: 'pilot',
  types: ['CREATURE'], rules: ['Deathtouch', 'Whenever an opponent draws a card, they lose 2 life.'],
  manaCost: '{2}{B}{B}', hints: [], setCode: 'DMU', cardNumber: '107', power: '4', toughness: '5', tapped: false,
};
const push = {
  id: 'push', cardId: 'printed-push', name: 'Fatal Push', controllerId: 'pilot', types: ['INSTANT'],
  manaCost: '{B}', rules: ['Destroy target creature if it has mana value 2 or less.'],
  hints: ['Revolt condition met'], setCode: 'AER', cardNumber: '57',
};
const lingeringAbility = {
  id: 'stack-ability', name: 'Activated ability', controllerId: 'rival', abilityType: 'ACTIVATED_NONMANA',
  sourceId: 'equipment', abilityText: 'Target creature gets +2/+0 until end of turn.', targets: [cottage.id],
};
const pushChoiceCard = { ...push, setCode: 'MUL', cardNumber: '16' };
const priority = {
  id: 'priority-42', kind: 'priority', instruction: 'Play spells and abilities',
  choices: [{ id: 'cast-push', label: push.name, type: 'object', objectId: push.id, card: pushChoiceCard },
    { id: 'pass', label: 'Pass', type: 'pass' }],
};
const target = {
  id: 'target-43', kind: 'target', instruction: 'Select target creature',
  choices: [
    { id: 'target-cottage', label: cottage.name, type: 'object', objectId: cottage.id, card: cottage },
    { id: 'target-sheoldred', label: sheoldred.name, type: 'object', objectId: sheoldred.id, card: sheoldred },
  ],
};

async function fixture(t, overrides = {}) {
  let state = {
    gameId, cursor: 42, epoch: 1, turn: 10, status: 'active', activePlayerId: 'rival',
    phase: 'COMBAT', step: 'DECLARE_BLOCKERS', priority: 'self', decision: priority,
    ownHand: [push], stack: [lingeringAbility], combat: [{ attackers: [cottage], blockers: [sheoldred] }],
    players: [
      { id: 'pilot', yourSeat: true, life: 13, manaPool: { B: 1 }, battlefield: [sheoldred] },
      { id: 'rival', yourSeat: false, life: 9, handCount: 2, battlefield: [cottage] },
    ],
    ...overrides,
  };
  const listeners = new Set();
  const applied = [];
  const update = (patch) => {
    state = { ...state, cursor: state.cursor + 1, ...patch };
    for (const listener of listeners) listener();
  };
  const engine = {
    snapshot: () => state,
    subscribe: (handler) => { listeners.add(handler); return () => listeners.delete(handler); },
    async respond(decisionId, choiceId, value) {
      applied.push({ decisionId, choiceId, value });
      if (decisionId === priority.id) update({ decision: target });
      else update({ decision: {
        id: 'pay-44', kind: 'payMana', instruction: 'Pay {B}', choices: [{ id: 'confirm', type: 'button', label: 'Pay {B}' }],
      } });
      return { submitted: true, gameId, cursor: state.cursor };
    },
  };
  const server = createMcpServer({
    authorize: async (token) => token === 'fixture'
      ? { accountId: 'fixture', engineName: 'pilot', scopes: ['play'] } : null,
    createEngine: () => engine,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new Client({ name: 'player-view-fixture', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer fixture' } },
  }));
  t.after(async () => { await client.close(); server.closeAllConnections(); server.close(); });
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    const body = response.content[0].text;
    return { isError: response.isError === true, payload: JSON.parse(body), bytes: Buffer.byteLength(body, 'utf8') };
  };
  return { call, applied, update, listTools: () => client.listTools() };
}

function choose(state, choice, commandId) {
  return {
    gameId: state.gameId, cursor: state.cursor, commandId,
    actions: [{ kind: 'choose', decisionId: state.decision.id, choiceId: choice.id }],
  };
}

function measure(t, name, full, compact) {
  assert.equal(full.isError, false);
  assert.equal(compact.isError, false);
  assert.ok(compact.bytes < full.bytes, `${name} should use fewer MCP text bytes`);
  t.diagnostic(`${name} UTF-8 text bytes: full=${full.bytes} compact=${compact.bytes}`);
}

test('[PM-VIEW-01] compact state, line and wait carry the same actionable combat and target choices', async (t) => {
  const { call, applied } = await fixture(t);
  const full = await call('get_game_state', { gameId });
  const compact = await call('get_game_state', { gameId, view: 'compact' });
  measure(t, 'priority state', full, compact);
  assert.deepEqual(full.payload.decision.choices[0].card, pushChoiceCard);
  const explicitFull = await call('get_game_state', { gameId, view: 'full' });
  assert.deepEqual(explicitFull, full);
  assert.equal(compact.payload.decision.choices[0].card, undefined);
  assert.equal(compact.payload.decision.choices[0].cardRef, push.id);
  assert.equal(compact.payload.ownHand[0].manaCost, '{B}');
  assert.equal(compact.payload.ownHand[0].setCode, undefined);
  assert.deepEqual(compact.payload.ownHand[0].hints, push.hints);
  assert.deepEqual(full.payload.players[0].battlefield[0].hints, []);
  assert.equal(compact.payload.players[0].battlefield[0].hints, undefined);

  const selection = (state) => {
    const choice = state.decision.choices.find(({ objectId }) => objectId === push.id);
    const card = choice.card ?? state.ownHand.find(({ id }) => id === choice.cardRef);
    assert.equal(card.name, push.name);
    assert.equal(card.manaCost, push.manaCost);
    return choose(state, choice, 'cast');
  };
  const cast = selection(compact.payload);
  assert.deepEqual(cast, selection(full.payload));
  const fullLine = await call('play_line', cast);
  const compactLine = await call('play_line', { ...cast, view: 'compact' });
  measure(t, 'target line receipt', fullLine, compactLine);
  assert.equal(fullLine.payload.status, 'completed');
  assert.equal(compactLine.payload.sequenceId, fullLine.payload.sequenceId);
  assert.equal(compactLine.payload.commandId, cast.commandId);
  assert.equal(compactLine.payload.appliedDecisions, 1);
  assert.equal(applied.length, 1);

  const wait = { gameId, commandId: compactLine.payload.commandId, timeoutMs: 500 };
  const fullWait = await call('wait_for_decision', wait);
  const compactWait = await call('wait_for_decision', { ...wait, view: 'compact' });
  measure(t, 'target command wait', fullWait, compactWait);
  assert.equal(compactWait.payload.event, 'line_stopped');
  assert.equal(compactWait.payload.planOwnsExecution, false);
  assert.equal(compactWait.payload.needsAgent, true);
  assert.deepEqual(compactWait.payload.state, compactLine.payload.state);

  const targetSelection = (state) => {
    const blocker = state.combat[0].blockers[0];
    const attacker = state.combat[0].attackers[0];
    assert.deepEqual([attacker.power, attacker.damage, blocker.toughness], ['4', 4, '5']);
    assert.deepEqual(state.stack[0].targets, [cottage.id]);
    assert.equal(state.stack[0].sourceId, lingeringAbility.sourceId);
    assert.equal(state.stack[0].abilityText, lingeringAbility.abilityText);
    assert.deepEqual([state.phase, state.step, state.priority], ['COMBAT', 'DECLARE_BLOCKERS', 'self']);
    assert.equal(state.players[0].manaPool.B, 1);
    assert.equal(state.decision.instruction, target.instruction);
    const choice = state.decision.choices.find(({ objectId }) => objectId === attacker.id);
    const card = choice.card ?? state.players[1].battlefield.find(({ id }) => id === choice.cardRef);
    assert.deepEqual(card.rules, cottage.rules);
    assert.equal(choice.label, cottage.name);
    return choose(state, choice, 'target');
  };
  assert.equal(compactWait.payload.state.decision.choices[0].card, undefined);
  assert.equal(compactWait.payload.state.decision.choices[0].cardRef, cottage.id);
  const next = targetSelection(compactWait.payload.state);
  assert.deepEqual(next, targetSelection(fullWait.payload.state));
  const resumed = await call('play_line', { ...next, view: 'compact', waitMs: 0 });
  assert.equal(resumed.isError, false);
  const response = await call('wait_for_decision', { gameId, commandId: next.commandId, view: 'compact', timeoutMs: 500 });
  assert.equal(response.payload.appliedDecisions, 1);
  assert.equal(response.payload.state.decision.instruction, 'Pay {B}');
  assert.deepEqual(applied.map(({ decisionId, choiceId }) => [decisionId, choiceId]), [
    [priority.id, priority.choices[0].id], [target.id, target.choices[0].id],
  ]);
});

test('[PM-VIEW-02] compact choices keep inline cards when a visible reference would lose information', async (t) => {
  const altered = { ...cottage, damage: 0 };
  const hidden = { id: 'facedown', name: 'Face-down card', faceDown: true, tapped: false };
  const revealed = { ...push, id: 'revealed-push' };
  const conflicting = { ...sheoldred, controllerId: 'rival' };
  const cardWithoutId = { name: 'Unindexed option', types: ['LAND'], rules: ['{T}: Add {G}.'] };
  const choices = [
    { id: 'different-card', label: cottage.name, type: 'object', objectId: cottage.id, card: altered },
    { id: 'ambiguous-id', label: sheoldred.name, type: 'object', objectId: sheoldred.id, card: sheoldred },
    { id: 'prompt-only', label: hidden.name, type: 'object', objectId: hidden.id, card: hidden },
    { id: 'pile', label: 'Choose pile 1', type: 'pile', cards: [revealed, hidden] },
    { id: 'ability-1', label: '−3: Destroy target creature.', type: 'option' },
    { id: 'ability-2', label: '+1: Add {B}.', type: 'option' },
    { id: 'no-id', label: cardWithoutId.name, type: 'object', card: cardWithoutId },
  ];
  const { call } = await fixture(t, {
    decision: { id: 'picker', kind: 'panel', instruction: 'Choose an option', choices },
    revealed: [{ name: 'Same ID, different representation', cards: [conflicting] }],
  });
  const result = await call('get_game_state', { gameId, view: 'compact' });
  assert.equal(result.isError, false);
  const options = result.payload.decision.choices;
  assert.equal(options[0].cardRef, undefined);
  assert.equal(options[0].card.damage, 0);
  assert.equal(options[1].cardRef, undefined);
  assert.equal(options[1].card.controllerId, 'pilot');
  assert.deepEqual(options[2].card, hidden);
  assert.deepEqual(options[3].cards.map(({ id }) => id), [revealed.id, hidden.id]);
  assert.equal(options[3].cards[0].manaCost, push.manaCost);
  assert.equal(options[3].cards[0].setCode, undefined);
  assert.deepEqual(options.slice(4), choices.slice(4));
});

test('[PM-VIEW-03] compact wait keeps rollback state and rejects incompatible command filters', async (t) => {
  const { call, update, applied, listTools } = await fixture(t);
  const { tools } = await listTools();
  const waitInput = tools.find(({ name }) => name === 'wait_for_decision').inputSchema.properties;
  assert.match(waitInput.commandId.description, /gameId/);
  for (const filter of ['afterCursor', 'afterDecisionId']) {
    assert.match(waitInput.commandId.description, new RegExp(filter));
    assert.match(waitInput[filter].description, /Omit with commandId/);
  }
  const commandId = 'missing-line';
  for (const args of [{ commandId }, { gameId, commandId, afterCursor: 0 }, { gameId, commandId, afterDecisionId: priority.id }]) {
    const invalid = await call('wait_for_decision', { ...args, view: 'compact' });
    assert.equal(invalid.isError, false);
    assert.equal(invalid.payload.code, 'invalid_line_wait');
    assert.equal(invalid.payload.stage, 'schema');
    assert.match(invalid.payload.message, /gameId.*commandId/i);
  }
  const rollbackRequest = { id: 'rewind-42', message: 'Return to previous turn?' };
  update({ decision: null, rollbackRequest });
  const full = await call('wait_for_decision', { gameId, timeoutMs: 500 });
  const compact = await call('wait_for_decision', { gameId, view: 'compact', timeoutMs: 500 });
  measure(t, 'rollback decision wait', full, compact);
  assert.equal(compact.payload.event, 'rollback');
  assert.deepEqual(compact.payload.state.rollbackRequest, rollbackRequest);
  assert.equal(compact.payload.state.cursor, full.payload.state.cursor);
  assert.equal(compact.payload.state.decision, null);
  assert.deepEqual(applied, []);
});


test('[PM-VIEW-03] timeout and stale-line recovery keep the current cursor in compact state', async (t) => {
  const { call, update, applied } = await fixture(t);
  const snapshot = await call('get_game_state', { gameId });
  const cursor = snapshot.payload.cursor;
  const argumentsForWait = { gameId, afterCursor: cursor, timeoutMs: 100 };
  const full = await call('wait_for_decision', argumentsForWait);
  const compact = await call('wait_for_decision', { ...argumentsForWait, view: 'compact' });
  measure(t, 'same-cursor decision timeout', full, compact);
  assert.equal(full.payload.event, 'timeout');
  assert.equal(full.payload.cursor, cursor);
  assert.equal(compact.payload.event, 'timeout');
  assert.equal(compact.payload.cursor, undefined);
  assert.equal(compact.payload.state.cursor, cursor);
  assert.equal(compact.payload.state.decision.id, priority.id);

  const staleRequest = choose(snapshot.payload, priority.choices[0], 'stale');
  update({ decision: target });
  const staleFull = await call('play_line', staleRequest);
  const staleCompact = await call('play_line', { ...staleRequest, view: 'compact' });
  for (const receipt of [staleFull, staleCompact]) {
    assert.equal(receipt.isError, false);
    assert.equal(receipt.payload.code, 'stale_decision');
    assert.equal(receipt.payload.state.cursor, cursor + 1);
    assert.equal(receipt.payload.state.decision.id, target.id);
  }
  assert.deepEqual(staleFull.payload.state.decision.choices[0].card, cottage);
  assert.equal(staleCompact.payload.state.decision.choices[0].card, undefined);
  assert.equal(staleCompact.payload.state.decision.choices[0].cardRef, cottage.id);
  assert.deepEqual(applied, []);
});

test('[PM-VIEW-04] an ambiguous ability label can be recovered with the observed choice ID', async (t) => {
  const decision = {
    id: 'order-triggers', kind: 'target', instruction: 'Choose a triggered ability',
    choices: [
      { id: 'trigger-drain', label: 'Ability', type: 'object', card: lingeringAbility },
      { id: 'trigger-food', label: 'Ability', type: 'object', card: {
        ...lingeringAbility, id: 'cottage-food', abilityText: 'Create a Food token.',
      } },
    ],
  };
  const { call, applied } = await fixture(t, {
    decision, stack: [], sequenceEvidence: { epoch: 'trigger-order', publicActions: {}, resolutions: {},
      resolutionRevision: 0, informationRevision: 0, combatRevision: 0, combatDamage: [] },
  });
  const { payload: state } = await call('get_game_state', { gameId, view: 'compact' });
  const ambiguous = await call('play_line', {
    gameId, cursor: state.cursor, commandId: 'ambiguous-trigger', view: 'compact',
    actions: [{ kind: 'choose', decisionId: decision.id, select: { label: 'Ability' } }],
  });
  assert.equal(ambiguous.payload.reason, 'ambiguous_choice');
  assert.match(ambiguous.payload.error.message, /decisionId.*choiceId/);
  assert.deepEqual(applied, []);
  const current = ambiguous.payload.state;
  const choice = current.decision.choices.find(({ card }) => card.abilityText === 'Create a Food token.');
  const recovered = await call('play_line', { ...choose(current, choice, 'exact-trigger'), view: 'compact' });
  assert.equal(recovered.payload.appliedDecisions, 1);
  assert.equal(applied[0].choiceId, 'trigger-food');
});
