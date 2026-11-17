import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.PLAYMAT_MCP_URL;
const token = process.env.PLAYMAT_MCP_TOKEN;
if (!url || !token) throw new Error('Configure PLAYMAT_MCP_URL and PLAYMAT_MCP_TOKEN before running the smoke check.');

let client;
try {
  const endpoint = new URL(url);
  assert.equal((await fetch(endpoint, { method: 'POST', redirect: 'manual' })).status, 401);
  client = new Client({ name: 'playmat-deployment-smoke', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === 'wait_for_decision'));
  assert.ok(tools.some((tool) => tool.name === 'submit_sideboard'));
  const response = await client.callTool({ name: 'search_cards', arguments: { format: 'Pioneer', query: 'Forest', limit: 5 } });
  assert.equal(response.isError ?? false, false);
  const result = JSON.parse(response.content[0].text);
  assert.ok(result.cards.some((card) => card.name === 'Forest'));
  console.log(JSON.stringify({ mcp: 'ready', tools: tools.length, catalog: 'verified', unauthenticated: 'rejected' }));
} catch {
  console.error('The MCP smoke check did not verify all assertions.');
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
}
