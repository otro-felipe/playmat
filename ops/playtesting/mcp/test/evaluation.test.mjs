import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createProductClient } from '../src/product.mjs';
import { createMcpServer } from '../src/server.mjs';

const GAME = '11111111-1111-4111-8111-111111111111';
const MATCH = '22222222-2222-4222-8222-222222222222';
const PATH = `/api/playtesting/evaluations/${GAME}`;
const replay = {
  gameId: GAME, matchId: MATCH, format: 'Pioneer', perspective: 'Owner', partialReplay: false,
  total: 6, next: 4,
  positions: [{ index: 12, action: { kind: 'play_land', card: 'Island' },
    before: { turn: 2, step: 'PRECOMBAT_MAIN', hand: [{ name: 'Island' }], players: [], stack: [] } }],
};
const review = { index: 12, played: 65, best: 90, confidence: 'high', alternative: 'Keep blue mana open', reason: 'Preserves the available response.' };
const report = { gameId: GAME, matchId: MATCH, method: 'llm_relative_quality_v1', accuracy: 75, reviewed: 1, scored: 1, total: 6 };

function respond(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function start(t) {
  const access = { owner: ['history'], outsider: ['history'], rival: ['play'] };
  const requests = [];
  const product = await listen(t, createServer(async (req, res) => {
    const actor = req.headers.authorization?.slice('Bearer '.length);
    if (!access[actor]) return respond(res, 401, {});
    if (req.url === '/internal/verify') {
      return respond(res, 200, { accountId: actor, engineName: actor, scopes: access[actor] });
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ actor, method: req.method, path: req.url, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null });
    if (actor === 'owner' && req.url.startsWith('/api/playtesting/review/')) {
      return respond(res, 200, { gameId: GAME, matchId: MATCH, archiveRevision: 'fixture-revision', entries: [] });
    }
    if (actor !== 'owner' || req.url.split('?')[0] !== PATH) return respond(res, 404, {});
    return respond(res, 200, req.method === 'POST' ? report : replay);
  }));
  const { authorize, operation } = createProductClient(product);
  const mcp = await listen(t, createMcpServer({
    authorize, product: operation, createEngine: () => assert.fail('Replay review does not open an engine seat'),
  }));
  return { mcp, requests };
}

async function connect(t, mcp, actor) {
  const client = new Client({ name: 'review-fixture', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', mcp), { requestInit: { headers: { Authorization: `Bearer ${actor}` } } });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

async function call(client, name, args) {
  const reply = await client.callTool({ name, arguments: args });
  return { error: reply.isError ?? false, data: JSON.parse(reply.content[0].text) };
}

test('[PM-AC-15] MCP forwards only authorized evidence pages and bounded scoring requests', async (t) => {
  const { mcp, requests } = await start(t);
  const [owner, outsider, rival] = await Promise.all(['owner', 'outsider', 'rival'].map(actor => connect(t, mcp, actor)));
  const { tools } = await owner.listTools();
  assert.equal(tools.find(tool => tool.name === 'evaluate_match')?.annotations?.readOnlyHint, true);
  assert.equal((await call(rival, 'evaluate_match', { gameId: GAME })).data.code, 'forbidden');
  assert.equal((await call(rival, 'score_match_evaluation', { gameId: GAME, positions: [review] })).data.code, 'forbidden');
  assert.equal(requests.length, 0);
  assert.equal((await call(outsider, 'evaluate_match', { gameId: GAME })).data.code, 'not_found');
  assert.equal((await call(outsider, 'score_match_evaluation', { gameId: GAME, positions: [review] })).data.code, 'not_found');

  assert.deepEqual(await call(owner, 'evaluate_match', { gameId: GAME }), { error: false, data: replay });
  assert.deepEqual(await call(owner, 'evaluate_match', { gameId: GAME, start: 4, count: 2 }), { error: false, data: replay });
  assert.deepEqual(await call(owner, 'score_match_evaluation', { gameId: GAME, positions: [review] }), { error: false, data: report });
  assert.deepEqual(requests.filter(request => request.actor === 'owner'), [
    { actor: 'owner', method: 'GET', path: `${PATH}?start=0&count=4`, body: null },
    { actor: 'owner', method: 'GET', path: `${PATH}?start=4&count=2`, body: null },
    { actor: 'owner', method: 'POST', path: PATH, body: { positions: [review] } },
  ]);

  const requestCount = requests.length;
  for (const args of [
    { gameId: GAME, positions: [{ ...review, reason: ' ' }] },
    { gameId: GAME, positions: [{ ...review, best: 60 }] },
    { gameId: GAME, positions: [{ ...review, alternative: undefined }] },
    { gameId: GAME, positions: Array.from({ length: 41 }, (_, index) => ({ ...review, index })) },
  ]) {
    assert.equal((await owner.callTool({ name: 'score_match_evaluation', arguments: args })).isError, true);
  }
  assert.equal((await owner.callTool({ name: 'evaluate_match', arguments: { gameId: GAME, count: 5 } })).isError, true);
  assert.equal(requests.length, requestCount);
});

test('[PM-REVIEW-API-5] native MCP discovers and forwards scoped review and annotation tools', async (t) => {
  const { mcp, requests } = await start(t);
  const [owner, rival] = await Promise.all(['owner', 'rival'].map(actor => connect(t, mcp, actor)));
  const { tools } = await owner.listTools();
  for (const name of ['get_match_review', 'read_review_evidence', 'list_review_annotations', 'save_review_annotations']) {
    assert.ok(tools.some(tool => tool.name === name), 'Native schema should advertise ' + name);
  }
  assert.equal(tools.find(tool => tool.name === 'save_review_annotations').annotations?.readOnlyHint, false);
  assert.equal((await call(rival, 'read_review_evidence', { gameId: GAME })).data.code, 'forbidden');
  assert.equal(requests.length, 0);
  await call(owner, 'get_match_review', { matchId: MATCH });
  await call(owner, 'read_review_evidence', { gameId: GAME, purpose: 'analysis', scope: 'seat', turn: 2, cursor: 4, count: 3 });
  await call(owner, 'list_review_annotations', { gameId: GAME, cursor: 4, count: 3 });
  const entry = { cursor: 4, seatId: 'owner', confidence: 'medium', assessment: 'sound',
    rationale: 'Supports development.', benefit: 'Makes mana.', risk: 'Uses the land drop.' };
  await call(owner, 'save_review_annotations', { gameId: GAME, archiveRevision: 'fixture-revision', entries: [entry] });
  const paths = requests.map(({ path }) => new URL(path, 'http://product.local'));
  assert.equal(paths[0].pathname, `/api/playtesting/review/matches/${MATCH}`);
  assert.equal(paths[1].pathname, `/api/playtesting/review/games/${GAME}/evidence`);
  assert.equal(paths[1].searchParams.get('purpose'), 'analysis');
  assert.equal(paths[1].searchParams.get('cursor'), '4');
  assert.equal(paths[2].pathname, `/api/playtesting/review/games/${GAME}/annotations`);
  assert.deepEqual(requests[3].body, { archiveRevision: 'fixture-revision', entries: [entry] });
});

test('[PM-REVIEW-API-11] native MCP forwards the explicit boolean quality verdict and archive revision', async t => {
  const { mcp, requests } = await start(t);
  const [owner, rival] = await Promise.all(['owner', 'rival'].map(actor => connect(t, mcp, actor)));
  const name = 'save_game_quality';
  const { tools } = await owner.listTools();
  assert.equal(tools.find(tool => tool.name === name)?.annotations?.readOnlyHint, false);
  const args = { gameId: GAME, archiveRevision: 'a'.repeat(64), goodQuality: false };
  assert.equal((await call(rival, name, args)).data.code, 'forbidden');
  assert.equal((await owner.callTool({ name, arguments: { ...args, goodQuality: 'false' } })).isError, true);
  assert.equal(requests.length, 0);
  assert.equal((await call(owner, name, args)).error, false);
  assert.deepEqual(requests, [{
    actor: 'owner', method: 'PUT', path: `/api/playtesting/review/games/${GAME}/quality`,
    body: { archiveRevision: args.archiveRevision, goodQuality: false },
  }]);
});

test('[PM-AC-15] the review prompt teaches the connected model to compare plausible counterfactuals', async (t) => {
  const { mcp, requests } = await start(t);
  const owner = await connect(t, mcp, 'owner');
  const rival = await connect(t, mcp, 'rival');
  const name = 'review_playmat_match';
  const { prompts } = await owner.listPrompts();
  assert.deepEqual(prompts.find(prompt => prompt.name === name)?.arguments?.map(({ name, required }) => [name, required]), [['gameId', true]]);
  const prompt = await owner.getPrompt({ name, arguments: { gameId: GAME } });
  const content = prompt.messages.map(message => message.content.text).join('\n');
  for (const evidence of [GAME, 'evaluate_match', 'score_match_evaluation', 'pre-action', 'two legal', 'two credible', 'worst plausible', 'future', 'low', 'coverage']) {
    assert.ok(content.includes(evidence), `Includes guidance about ${evidence}`);
  }
  await assert.rejects(() => owner.getPrompt({ name, arguments: { gameId: 'another game' } }));
  await assert.rejects(() => rival.getPrompt({ name, arguments: { gameId: GAME } }));
  assert.equal(requests.length, 0);
});
