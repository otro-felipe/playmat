import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpServer } from '../src/server.mjs';

const TEST_GAME = '11111111-1111-4111-8111-111111111111';
const TEST_TABLE = '22222222-2222-4222-8222-222222222222';
const PASS = { id: 'pass', label: 'Pass', type: 'pass' };
const SPELL = { id: 'cast', label: 'Cast an instant', type: 'cast' };
const SIDES = new Map([
  ['fixture-player', { accountId: 'owner-a', engineName: 'Agent-A', scopes: ['play', 'catalog', 'decks', 'history', 'chat'] }],
  ['fixture-other', { accountId: 'owner-b', engineName: 'Agent-B', scopes: ['play'] }],
]);

class EngineFixture {
  listeners = new Set();
  played = [];
  appliedAt = null;
  constructor(actor) {
    this.view = actor.engineName === 'Agent-A'
      ? { status: 'active', gameId: TEST_GAME, tableId: TEST_TABLE, cursor: 1, turn: 2, phase: 'PRECOMBAT_MAIN',
        step: 'PRECOMBAT_MAIN', priority: 'self', stack: [], decision: { id: 'decision-1', kind: 'priority', choices: [PASS, SPELL] } }
      : { status: 'lobby', cursor: 0, decision: null };
  }
  snapshot() { return this.view; }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  update(view) {
    this.view = { ...this.view, ...view, cursor: this.view.cursor + 1 };
    for (const listener of this.listeners) listener();
  }
  async respond(id, choiceId) {
    assert.equal(id, this.view.decision?.id);
    this.played.push(choiceId);
    this.appliedAt = Date.now();
    this.update({ decision: null, priority: 'opponent' });
    return { submitted: true };
  }
  async searchCards() {
    return [
      { name: 'Consider', colors: ['U'], manaValue: 1, manaSymbols: ['U'], types: ['INSTANT'], keywords: ['Surveil'], rules: ['Surveil 1. Draw a card.'] },
      { name: 'Opt', colors: ['U'], manaValue: 1, manaSymbols: ['U'], types: ['INSTANT'], keywords: ['Scry'], rules: ['Scry 1. Draw a card.'] },
      { name: 'Faithful Mending', colors: ['W', 'U'], manaValue: 2, manaSymbols: ['W', 'U'], types: ['INSTANT'], keywords: ['Flashback'], rules: ['Flashback {1}{W}{U}'] },
    ];
  }
}

async function start(t) {
  const fixtures = new Map();
  const tokens = new Map(SIDES);
  const server = createMcpServer({
    authorize: async (token) => tokens.get(token) ?? null,
    createEngine: (actor) => {
      const engine = new EngineFixture(actor);
      fixtures.set(actor.engineName, engine);
      return engine;
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: new URL('/mcp', `http://127.0.0.1:${server.address().port}`), fixtures, tokens };
}

async function connect(t, url, token) {
  const client = new Client({ name: 'playmat-fixtures', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  return client;
}

async function call(client, name, args = {}) {
  const reply = await client.callTool({ name, arguments: args });
  return { error: reply.isError ?? false, value: JSON.parse(reply.content[0].text) };
}

test('[PM-AC-08] authenticates every MCP request and binds decisions to one seat', async (t) => {
  const { url, fixtures, tokens } = await start(t);
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  const stolenOrigin = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer fixture-player', Origin: 'https://untrusted.invalid' } });
  assert.equal(stolenOrigin.status, 403);
  const player = await connect(t, url, 'fixture-player');
  const other = await connect(t, url, 'fixture-other');
  const tools = await player.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === 'submit_decision'));
  assert.ok(!tools.tools.some((tool) => tool.name === 'sendPlayerAction'));
  const { value: observed } = await call(player, 'wait_for_decision', { gameId: TEST_GAME, timeoutMs: 100 });
  assert.deepEqual([observed.event, observed.state.decision.id], ['decision', 'decision-1']);
  const action = { gameId: TEST_GAME, decisionId: 'decision-1', choiceId: 'cast', idempotencyKey: 'fixture-once' };
  assert.equal((await call(other, 'submit_decision', action)).error, true);
  assert.equal((await call(player, 'submit_decision', action)).value.submitted, true);
  assert.equal((await call(player, 'submit_decision', action)).value.submitted, true);
  assert.deepEqual(fixtures.get('Agent-A').played, ['cast']);
  assert.equal((await call(player, 'submit_decision', { ...action, idempotencyKey: 'fixture-stale' })).error, true);
  tokens.delete('fixture-player');
  await assert.rejects(() => player.listTools(), /401|Unauthorized/i);
});

test('an invited agent can discover and read the Playmat guides before joining a game', async (t) => {
  const { url, fixtures, tokens } = await start(t);
  const rival = await connect(t, url, 'fixture-other');
  assert.ok(rival.getServerCapabilities()?.resources);
  const gettingStarted = 'playmat://guides/getting-started';
  const cardCatalog = 'playmat://guides/card-catalog';
  const turnPlanning = 'playmat://guides/turn-planning';
  const rules = 'playmat://guides/rules';
  const expected = new Map([
    [gettingStarted, /join_game[\s\S]*wait_for_decision[\s\S]*send_chat/],
    [cardCatalog, /search_cards[\s\S]*find_possible_responses/],
    [turnPlanning, /play_sequence[\s\S]*expectCast/],
    [rules, /magic\.wizards\.com\/en\/rules[\s\S]*media\.wizards\.com\/\d{4}\/downloads\/MagicCompRules.*\.txt[\s\S]*117/],
  ]);
  const { resources } = await rival.listResources();
  assert.deepEqual(new Set(resources.map(({ uri }) => uri)), new Set(expected.keys()));
  for (const { uri, mimeType } of resources) {
    assert.ok(rival.getInstructions()?.includes(uri));
    assert.equal(mimeType, 'text/markdown');
    const { contents } = await rival.readResource({ uri });
    assert.equal(contents.length, 1);
    assert.equal(contents[0].uri, uri);
    assert.equal(contents[0].mimeType, 'text/markdown');
    assert.match(contents[0].text, expected.get(uri));
  }
  assert.equal(fixtures.size, 0);
  await assert.rejects(() => rival.readResource({ uri: 'playmat://guides/nonexistent' }), /not found/i);

  tokens.delete('fixture-other');
  await assert.rejects(() => rival.listResources(), /401|Unauthorized/i);
  await assert.rejects(() => rival.readResource({ uri: rules }), /401|Unauthorized/i);
});

test('[PM-AC-08] a tools-only connector can discover and read the same guides as MCP resources', async (t) => {
  const { url, fixtures, tokens } = await start(t);
  tokens.set('fixture-history', { accountId: 'owner-c', engineName: 'Agent-C', scopes: ['history'] });
  const client = await connect(t, url, 'fixture-history');
  const { tools } = await client.listTools();
  const tool = tools.find(({ name }) => name === 'get_guide');
  assert.equal(tool?.annotations?.readOnlyHint, true);
  assert.match(client.getInstructions(), /get_guide/);

  const ids = ['getting-started', 'card-catalog', 'turn-planning', 'rules'];
  for (const id of ids) {
    assert.ok(client.getInstructions().includes(id));
    assert.ok(tool.description.includes(id));
  }
  assert.match(client.getInstructions(), /Before creating, joining or playing/);
  assert.match(client.getInstructions(), /Listing guides alone does not load their contents/);
  for (const name of ['join_game', 'create_game', 'submit_decision', 'play_sequence', 'submit_sequence']) {
    const description = tools.find((tool) => tool.name === name).description;
    assert.match(description, /get_guide/);
    for (const id of ids) assert.ok(description.includes(id));
  }
  for (const name of ['play_sequence', 'submit_sequence']) {
    assert.match(tools.find((tool) => tool.name === name).description, /turn_changed/);
    assert.match(tools.find((tool) => tool.name === name).description, /land drops/);
  }
  const { error, value: { guides } } = await call(client, 'get_guide');
  assert.equal(error, false);
  assert.deepEqual(new Set(guides.map(({ name }) => name)), new Set(ids));
  assert.equal(guides.length, ids.length);

  const { resources } = await client.listResources();
  for (const guide of guides) {
    const { name, uri } = guide;
    assert.equal(uri, `playmat://guides/${name}`);
    assert.deepEqual(guide, resources.find((resource) => resource.uri === uri));
    const { contents: [{ text }] } = await client.readResource({ uri });
    const selected = await call(client, 'get_guide', { guideId: name });
    assert.deepEqual(selected, { error: false, value: { ...guide, text } });
  }
  const invalid = await client.callTool({ name: 'get_guide', arguments: { guideId: 'nonexistent' } });
  assert.equal(invalid.isError, true);
  assert.equal(fixtures.size, 0);

  tokens.delete('fixture-history');
  await assert.rejects(() => client.callTool({ name: 'get_guide', arguments: { guideId: 'rules' } }), /401|Unauthorized/i);
});

test('get_guide delivers the public opponent response range guidance before seating an agent', async (t) => {
  const { url, fixtures } = await start(t);
  const client = await connect(t, url, 'fixture-other');
  const { error, value } = await call(client, 'get_guide', { guideId: 'card-catalog' });
  assert.equal(error, false);
  assert.equal(value.uri, 'playmat://guides/card-catalog');
  for (const instruction of [
    '## Track an opponent response range',
    'Separate known public facts, hypotheses and unknowns.',
    'not invented percentages',
    'Never inspect opposing hidden hands/libraries, private saved decks, private server diagnostics or another seat\'s view',
    'Authorized history or replays may support public facts only through your seat\'s permitted, redacted view.',
    'Confirm that the opponent actually had and yielded priority.',
    'tool latency, disconnect, inactivity or an automatic pass is not evidence of card absence',
    'repeated observations of the same opportunity are not independent evidence',
    'After their next draw, reopen the possibility.',
    'the MCP does not automatically persist it',
    'replan only the unapplied remainder',
  ]) assert.ok(value.text.includes(instruction), `The delivered guide must include: ${instruction}`);
  assert.equal(fixtures.size, 0, 'Reading strategic guidance must not create or join an engine seat');
});

test('[PM-AC-09] checks an explicit hold and stops on a new meaningful response', async (t) => {
  const { url, fixtures } = await start(t);
  const player = await connect(t, url, 'fixture-player');
  await call(player, 'get_game_state', { gameId: TEST_GAME });
  const engine = fixtures.get('Agent-A');
  const started = Date.now();
  const { value: sequence } = await call(player, 'submit_sequence', {
    gameId: TEST_GAME, cursor: 1,
    steps: [{ kind: 'hold', delayMs: 100 }, { kind: 'answer', decisionId: 'decision-1', choiceId: 'pass' },
      { kind: 'pass_until', step: 'BEGIN_COMBAT' }],
  });
  assert.match(sequence.sequenceId, /^[0-9a-f-]+$/);
  for (let i = 0; i < 25 && engine.played.length === 0; i++) await sleep(15);
  assert.deepEqual(engine.played, ['pass']);
  assert.ok(engine.appliedAt - started >= 100);
  engine.update({ priority: 'self', decision: { id: 'decision-3', kind: 'priority', choices: [PASS, SPELL] },
    stack: [{ name: 'Opposing spell' }] });
  const ids = { gameId: TEST_GAME, sequenceId: sequence.sequenceId };
  let result;
  for (let i = 0; i < 25; i++) {
    result = (await call(player, 'get_sequence_status', ids)).value;
    if (result.status !== 'running') break;
    await sleep(15);
  }
  assert.equal(result.status, 'interrupted');
  assert.match(result.reason, /state_changed|response/);
  assert.deepEqual(engine.played, ['pass']);
});

test('[PM-AC-10] filters by format, color, mana value and keywords', async (t) => {
  const { url } = await start(t);
  const client = await connect(t, url, 'fixture-player');
  const query = { format: 'Pioneer', colors: ['U'], maxManaValue: 1, keywords: ['surveil'] };
  const { value } = await call(client, 'search_cards', query);
  assert.deepEqual(value.cards.map((card) => card.name), ['Consider']);
  const { value: hints } = await call(client, 'find_possible_responses', { ...query, archetype: 'Izzet Phoenix' });
  assert.equal(hints.hypothesis, 'Izzet Phoenix');
  assert.ok(hints.provenance.date);
  assert.ok(hints.provenance.source);
  assert.deepEqual(hints.cards.map((card) => card.name), ['Consider']);
});


test('MCP accepts explicit yield and empty-stack conditions with safe defaults', async (t) => {
  const { url } = await start(t);
  const client = await connect(t, url, 'fixture-player');
  const first = await call(client, 'play_sequence', { gameId: TEST_GAME, cursor: 1,
    steps: [{ kind: 'yield_priority', until: 'opponent' }] });
  assert.equal(first.error, false);
  let status;
  for (let i = 0; i < 20; i++) {
    status = (await call(client, 'get_sequence_status', { gameId: TEST_GAME, sequenceId: first.value.sequenceId })).value;
    if (status.status !== 'running') break;
    await sleep(5);
  }
  assert.equal(status.status, 'completed');
  const second = await call(client, 'play_sequence', { gameId: TEST_GAME, cursor: status.cursor,
    steps: [{ kind: 'pass_until', stackEmpty: true, allowPlannedResolutions: true }] });
  assert.equal(second.error, false);
});


test('standalone pass_until is exposed separately from guarded play_sequence', async (t) => {
  const { url, fixtures } = await start(t);
  const client = await connect(t, url, 'fixture-player');
  const reply = await call(client, 'pass_until', { gameId: TEST_GAME, cursor: 1, priority: 'opponent' });
  assert.equal(reply.error, false);
  for (let i = 0; i < 20; i++) {
    const status = (await call(client, 'get_sequence_status', { gameId: TEST_GAME, sequenceId: reply.value.sequenceId })).value;
    if (status.status !== 'running') {
      assert.equal(status.status, 'completed');
      assert.deepEqual(fixtures.get('Agent-A').played, ['pass']);
      return;
    }
    await sleep(5);
  }
  assert.fail('Standalone pass did not finish');
});
