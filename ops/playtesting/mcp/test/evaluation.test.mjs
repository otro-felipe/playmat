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
