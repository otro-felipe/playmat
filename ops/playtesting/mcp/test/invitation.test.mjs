import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpServer } from '../src/server.mjs';

test('[PM-AC-08] join_game uses a private Playmat link, validates before claim, and conveys an optional alias', async (t) => {
  const origin = 'https://playmat.example';
  const tableId = '22222222-2222-4222-8222-222222222222';
  const deck = { name: 'Fixture deck', cards: [{ cardName: 'Forest', amount: 60 }] };
  const access = { tableId, format: 'Pioneer', mode: 'mcp' };
  const inspected = [];
  const claimed = [];
  const server = createMcpServer({
    allowedOrigins: [origin],
    authorize: async (token) => token === 'fixture' ? { accountId: 'owner', engineName: 'FixtureAgent', scopes: ['play'] } : null,
    createEngine: ({ engineName }) => ({
      async joinGame(input, invite, claim) {
        assert.equal(engineName, 'FixtureAgent');
        assert.deepEqual(invite, access);
        assert.equal(input.tableId, tableId);
        assert.equal(input.deck.cards[0].cardName, 'Forest');
        assert.equal(claimed.length, 0);
        assert.deepEqual(await claim(), { ...access, guestDisplayName: 'Angels', password: 'synthetic-table-fixture' });
        return { state: 'seated' };
      },
    }),
    product: async (_token, name, input) => {
      if (name === 'inspect_game_invite') {
        inspected.push(input);
        return access;
      }
      assert.equal(name, 'get_game_invite');
      claimed.push(input);
      return { ...access, guestDisplayName: input.displayName, password: 'synthetic-table-fixture' };
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new Client({ name: 'invitation-fixture', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer fixture' } },
  });
  await client.connect(transport);
  t.after(() => client.close());
  const join = args => client.callTool({ name: 'join_game', arguments: { deck, ...args } });
  assert.equal((await join({ inviteLink: `https://wrong.invalid/join/${tableId}` })).isError, true);
  assert.equal(inspected.length, 0);
  const result = await join({ inviteLink: `${origin}/join/${tableId}`, displayName: 'Angels' });
  assert.deepEqual(JSON.parse(result.content[0].text), { state: 'seated' });
  assert.deepEqual(inspected, [{ tableId }]);
  assert.deepEqual(claimed, [{ tableId, displayName: 'Angels' }]);
});
