import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createProductClient } from '../src/product.mjs';
import { createMcpServer } from '../src/server.mjs';

const studyId = '11111111-1111-4111-8111-111111111111';
const study = {
  seed: 7, trials: 1, horizon: 1, onPlay: true,
  cards: [{ id: 'Mountain', count: 7, land: { colors: ['R'] } }], policies: [{ id: 'default' }], queries: [],
};
const graph = { objective: 'lethal_this_turn', rootId: 'root', maxDepth: 1, budget: 1, nodes: { root: { kind: 'terminal', scored: true } } };

const combat = {
  attackers: [{ id: 'bear', power: 2 }], blockers: [], defendingLife: 2,
  completeLegalActions: true, completeReplies: true, budget: 100,
};

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('[PM-THEORY-6] native MCP forwards authenticated study operations without opening a game seat', async t => {
  const requests = [];
  const productUrl = await listen(t, createServer(async (req, res) => {
    const actor = req.headers.authorization?.slice('Bearer '.length);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/internal/verify') {
      return res.end(JSON.stringify({ accountId: actor, engineName: actor, scopes: [actor === 'play' ? 'play' : 'history'] }));
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ actor, path: req.url, method: req.method, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null });
    if (actor === 'outsider') {
      res.statusCode = 404;
      return res.end('{}');
    }
    res.end(JSON.stringify({ studyId }));
  }));
  const { authorize, operation } = createProductClient(productUrl);
  const mcp = await listen(t, createMcpServer({
    authorize, product: operation,
    createEngine: () => assert.fail('Theory tools do not open a game seat'),
  }));
  async function connect(actor) {
    const client = new Client({ name: 'theory-fixture', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', mcp), {
      requestInit: { headers: { Authorization: `Bearer ${actor}` } },
    }));
    t.after(() => client.close());
    return client;
  }
  const [owner, outsider, play] = await Promise.all(['owner', 'outsider', 'play'].map(connect));
  const { tools } = await owner.listTools();
  assert.equal(tools.find(tool => tool.name === 'run_theory_study')?.annotations?.readOnlyHint, false);
  assert.equal(tools.find(tool => tool.name === 'get_theory_study')?.annotations?.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'search_theory_tactics')?.annotations?.readOnlyHint, true);
  async function call(client, name, args) {
    const reply = await client.callTool({ name, arguments: args });
    return JSON.parse(reply.content[0].text);
  }
  assert.equal((await call(play, 'run_theory_study', { study })).code, 'forbidden');
  assert.equal((await call(outsider, 'get_theory_study', { studyId })).code, 'not_found');
  assert.deepEqual(await call(owner, 'run_theory_study', { study }), { studyId });
  assert.deepEqual(await call(owner, 'get_theory_study', { studyId }), { studyId });
  assert.deepEqual(await call(owner, 'search_theory_tactics', { graph }), { studyId });
  assert.deepEqual(await call(owner, 'search_theory_tactics', { combat }), { studyId });
  assert.deepEqual(requests.filter(request => request.actor === 'owner'), [
    { actor: 'owner', path: '/api/playtesting/theory/studies', method: 'POST', body: { study } },
    { actor: 'owner', path: `/api/playtesting/theory/studies/${studyId}`, method: 'GET', body: null },
    { actor: 'owner', path: '/api/playtesting/theory/tactics', method: 'POST', body: { graph } },
    { actor: 'owner', path: '/api/playtesting/theory/tactics', method: 'POST', body: { combat } },
  ]);
  assert.equal(requests.some(request => request.actor === 'play'), false);
});
