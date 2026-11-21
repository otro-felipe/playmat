import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { hostDeck, guestDeck, verifySideboarding, until } from './bo3-sideboard-fixture.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpServer } from '../src/server.mjs';

const engineUrl = process.env.PLAYMAT_LIVE_ENGINE_URL;
const deploymentMcp = process.env.PLAYMAT_LIVE_MCP_URL;
const runId = randomBytes(3).toString('hex');
const NAME_ONE = deploymentMcp ? process.env.PLAYMAT_LIVE_MCP_ENGINE_NAME_1 : `MCPA${runId}`;
const NAME_TWO = deploymentMcp ? process.env.PLAYMAT_LIVE_MCP_ENGINE_NAME_2 : `MCPB${runId}`;
async function liveTarget(t) {
  if (deploymentMcp) {
    const url = new URL(deploymentMcp);
    if (url.protocol !== 'https:' || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) {
      throw new Error('The deployed target must be an HTTPS /mcp URL without credentials, query or fragment.');
    }
    const tokens = [process.env.PLAYMAT_LIVE_MCP_TOKEN_1, process.env.PLAYMAT_LIVE_MCP_TOKEN_2];
    if (!NAME_ONE || !NAME_TWO || NAME_ONE === NAME_TWO || !tokens[0] || !tokens[1] || tokens[0] === tokens[1]) {
      throw new Error('Provide two separately provisioned deployment fixture grants and engine names.');
    }
    return { url, tokens };
  }
  const { PlaymatEngineSeat } = await import('../src/engine-seat.mjs');
  let invitation = null;
  const server = createMcpServer({
    authorize: async (token) => {
      const engineName = token === 'fixture-one' ? NAME_ONE : token === 'fixture-two' ? NAME_TWO : null;
      return engineName ? { accountId: engineName, engineName, scopes: ['play', 'catalog', 'chat', 'decks'] } : null;
    },
    createEngine: ({ engineName }) => new PlaymatEngineSeat({
      engineUrl, engineName, trustedHeader: 'X-Playmat-User',
      guardedPrompts: process.env.PLAYMAT_LIVE_LEGACY_ENGINE !== '1',
    }),
    product: async (token, operation, args) => {
      if (token === 'fixture-one' && operation === 'create_game_invite') {
        assert.equal(args.guestEngineName, NAME_TWO);
        invitation = args;
        return {};
      }
      if (token === 'fixture-two' && ['inspect_game_invite', 'get_game_invite'].includes(operation)
        && args.tableId === invitation?.tableId) return invitation;
      return null;
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url, tokens: ['fixture-one', 'fixture-two'] };
}

test('[PM-AC-08] joins a private real XMage Bo3 through two authenticated MCP clients', {
  skip: !engineUrl && !deploymentMcp, timeout: deploymentMcp ? 300_000 : 180_000,
}, async (t) => {
  const { url, tokens } = await liveTarget(t);
  const clients = [];
  t.after(async () => { await Promise.allSettled(clients.map((client) => client.close())); });
  for (const token of tokens) {
    const client = new Client({ name: 'playmat-mcp-live-fixture', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { redirect: 'error', headers: { Authorization: `Bearer ${token}` } },
    }));
    clients.push(client);
  }

  async function call(client, name, args = {}, retryable = []) {
    const response = await client.callTool({ name, arguments: args });
    const result = JSON.parse(response.content[0].text);
    if (response.isError && retryable.includes(result.code)) return null;
    if (response.isError) {
      const code = /^[a-z0-9_]{1,64}$/.test(result.code) ? result.code : 'tool_error';
      throw new Error(`${name} failed (${code}).`);
    }
    return result;
  }

  const [host, guest] = clients;
  if (deploymentMcp || process.env.PLAYMAT_LIVE_LEGACY_ENGINE !== '1') {
    const prohibited = await call(host, 'get_card', { name: 'Sorin, Imperious Bloodlord', format: 'Pioneer' });
    assert.equal(prohibited.engineAvailable, true);
    assert.equal(prohibited.formatLegal, false);
    const legal = await call(host, 'get_card', { name: 'Forest', format: 'Pioneer' });
    assert.equal(legal.engineAvailable, true);
    assert.equal(legal.formatLegal, true);
  }
  const { tableId } = await call(host, 'create_game', {
    name: 'MCP Bo3 integration fixture', format: 'Pioneer', deck: hostDeck, guestEngineName: NAME_TWO,
  });
  if (deploymentMcp) {
    const { invites } = await call(guest, 'list_joinable_games', { limit: 50 });
    assert.ok(invites.some((entry) => entry.tableId === tableId), 'The intended agent can discover the invitation.');
    const hostInvites = await call(host, 'list_joinable_games', { limit: 50 });
    assert.ok(!hostInvites.invites.some((entry) => entry.tableId === tableId), 'The invitation is scoped to the requested seat.');
  }
  await call(guest, 'join_game', { tableId, deck: guestDeck });
  await call(host, 'start_match', { tableId });
  const [firstGameId, secondGameId, thirdGameId] = await verifySideboarding(
    (name, args, retryable) => call(host, name, args, retryable),
    (name, args, retryable) => call(guest, name, args, retryable),
    [NAME_ONE, NAME_TWO]);

  if (deploymentMcp) {
    const match = await until(async () => {
      const { matches } = await call(guest, 'list_matches', { format: 'Pioneer', limit: 50 });
      return matches.find((entry) => entry.tableId === tableId
        && [firstGameId, secondGameId, thirdGameId].every((gameId) =>
          entry.games.some((game) => game.gameId === gameId && game.replayAvailable)));
    }, 'all three game archives available in the invited seat history', 60_000);
    const detail = await call(guest, 'get_match', { matchId: match.id });
    assert.equal(detail.games.length, 3);
    const replay = await call(guest, 'get_replay', { gameId: firstGameId, start: 0, count: 3 });
    assert.ok(replay.events.length > 0, 'A participant can read events from the stored replay.');
    const bundle = await call(guest, 'export_matches', { gameIds: [firstGameId, secondGameId, thirdGameId] });
    const download = new URL(bundle.downloadUrl ?? bundle.path, url);
    assert.equal(download.origin, url.origin);
    assert.ok(download.pathname.startsWith('/api/playtesting/exports/'));
    const anonymous = await fetch(download, { redirect: 'error' });
    assert.ok([401, 403].includes(anonymous.status), 'An export needs live authorization.');
    const response = await fetch(download, { redirect: 'error', headers: { Authorization: `Bearer ${tokens[1]}` } });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    assert.ok(bytes.includes(Buffer.from('manifest.json')), 'The authenticated download is a replay bundle.');
    console.log('Verified deployed invites, 2–1 Bo3 with sideboarding, replay history and authorized batch export.');
  }
});
