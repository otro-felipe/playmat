import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpServer } from '../src/server.mjs';

const deck = { name: 'Basics', cards: [{ cardName: 'Forest', amount: 60 }], sideboard: [] };

test('the human host can launch all modes and only opted-in tables expose their own player projection', async t => {
  const settings = new Map(), opens = [], invitations = [];
  const accountId = randomUUID(), gameId = randomUUID();
  const actor = { accountId, username: 'Owner', engineName: 'mcp_Owner', accountAgent: true, connectionId: randomUUID(), scopes: ['play', 'library', 'chat'] };
  const server = createMcpServer({
    authorize: async () => actor,
    product: async (_, name, args) => {
      if (name === 'human_seat_settings') return settings.get(args.tableId);
      if (name === 'create_human_invitation') { invitations.push(args.mode); return {}; }
      throw Error('Unexpected product operation');
    },
    createEngine: opts => {
      opens.push(opts.engineName);
      let tableId = opts.humanTableId;
      return {
        async createGame(args, register) {
          assert.equal(opts.engineName, 'Owner');
          assert.deepEqual(args.deck, deck);
          tableId = randomUUID();
          settings.set(tableId, { tableId, humanName: 'Owner', humanMcpAllowed: args.humanMcpAllowed, createdViaMcp: true });
          await register?.({ tableId, roomId: randomUUID(), format: args.format, password: 'synthetic-fixture' });
          return { tableId, state: ['bot','practice'].includes(args.mode) ? 'started' : 'waiting' };
        },
        open: async () => {},
        listChat: async () => ({ owner:opts.engineName }),
        sideboardState: () => ({ owner:opts.engineName }),
        requestRollback: async () => ({ owner:opts.engineName }),
        recoveryList: async () => ({ owner:opts.engineName }),
        recoveryStatus: async () => ({ owner:opts.engineName }),
        recoveryJoin: async () => ({ owner:opts.engineName }),
        startMatch: async id => ({ tableId: id, started: true }),
        snapshot: () => ({ tableId, gameId, ownHand: [opts.engineName], cursor: 1 }),
        close: () => {},
      };
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new Client({ name: 'human-seat-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+server.address().port+'/mcp'), {
    requestInit: { headers: { authorization: 'Bearer synthetic-fixture' } },
  }));
  t.after(async () => { await client.close(); server.closeAllConnections(); server.close(); });
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    return JSON.parse(response.content[0].text);
  };
  const { tools } = await client.listTools();
  const live = tools.filter(tool => 'gameId' in (tool.inputSchema.properties ?? {})
    && tool._meta?.securitySchemes?.some(scheme => scheme.scopes.some(scope => ['play','chat'].includes(scope))));
  assert.ok(live.length >= 18);
  for (const tool of live) {
    assert.ok(tool.inputSchema.properties.humanTableId, tool.name + ' supports the human seat');
    assert.ok(!tool.inputSchema.required?.includes('humanTableId'), tool.name + ' preserves MCP Player calls');
    if (tool.inputSchema.properties.actions) {
      assert.ok(!JSON.stringify(tool.inputSchema.properties.actions).includes('humanTableId'), 'Seat selected once per line');
    }
  }
  let allowed;
  for (const mode of ['mcp','friend','practice','bot']) {
    for (const humanMcpAllowed of [false,true]) {
      const host = await call('create_human_match', { name: 'Test', format: 'Pioneer', mode, deck, humanMcpAllowed });
      assert.ok(host.tableId, JSON.stringify(host));
      const owned = await call('get_game_state', { gameId, humanTableId: host.tableId, view: 'full' });
      if (humanMcpAllowed) {
        assert.deepEqual(owned.ownHand, ['Owner']);
        allowed = host.tableId;
      }
      else assert.equal(owned.code, 'human_seat_forbidden');
      if (mode === 'mcp' || mode === 'friend') assert.equal((await call('start_match', { humanTableId: host.tableId })).started, true);
    }
  }
  assert.deepEqual(invitations, ['mcp', 'mcp', 'friend', 'friend']);
  assert.deepEqual((await call('get_game_state', { gameId, view: 'full' })).ownHand, ['mcp_Owner']);
  for (const [tool, extra] of [['list_chat',{}], ['get_sideboard_state',{}], ['request_rollback',{ turnsBack:0 }]]) {
    assert.equal((await call(tool,{ gameId,...extra })).owner, 'mcp_Owner');
    assert.equal((await call(tool,{ gameId,humanTableId:allowed,...extra })).owner, 'Owner');
  }
  const matchId = randomUUID();
  for (const [tool, args] of [['list_recoverable_matches', {}], ['get_recovery_status', { matchId }], ['recover_match', { matchId, revision:1, agree:true }]]) {
    assert.ok(tools.find(t => t.name === tool).inputSchema.properties.humanTableId, tool);
    assert.equal((await call(tool,args)).owner, 'mcp_Owner');
    assert.equal((await call(tool,{ ...args,humanTableId:allowed })).owner, 'Owner');
  }
  const before = opens.length;
  assert.equal((await call('wait_for_decision', {humanTableId: randomUUID(),gameId,commandId:'lost'})).code, 'human_seat_forbidden');
  assert.equal(opens.length, before);
});
