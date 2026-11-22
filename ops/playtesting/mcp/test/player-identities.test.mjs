import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpServer } from '../src/server.mjs';
import { ToolError } from '../src/game-seat.mjs';

const deck = { name: 'Fixture basics', cards: [{ cardName: 'Forest', amount: 60 }], sideboard: [] };

test('four profile-bound pilot connections share a library and keep two simultaneous table projections separate', async t => {
  const accountId = randomUUID();
  const identities = Array.from({ length: 4 }, (_, index) => ({
    accountId, playerId: randomUUID(), connectionId: randomUUID(), engineName: 'Fixture' + index,
    agent: true, scopes: ['play', 'chat', 'decks', 'catalog'], token: 'fixture-seat-' + index,
  }));
  const grants = new Map(identities.map(identity => [identity.token, identity]));
  const seats = new Map(), leases = new Map(), tables = new Map();
  const server = createMcpServer({
    authorize: async token => {
      const identity = grants.get(token);
      if (!identity) return null;
      const lease = leases.get(identity.playerId);
      const ownsReservation = !lease || lease.connectionId === identity.connectionId;
      return { ...identity, ownsReservation, reservationId: ownsReservation ? lease?.reservationId : null,
        activeTableId: ownsReservation ? lease?.tableId : null };
    },
    product: async (token, op, args) => {
      const identity = grants.get(token);
      if (op === 'list_players') return { players: [{ playerId: identity.playerId, engineName: identity.engineName }] };
      if (op === 'get_deck') return { id: 'shared', library: 'agent', data: deck };
      if (op === 'player_reservation') {
        const lease = leases.get(identity.playerId);
        assert.equal(args.playerId, identity.playerId);
        if (lease && (lease.reservationId !== args.reservationId || lease.connectionId !== identity.connectionId)) {
          throw new ToolError('player_busy', 'Reserved by another connection');
        }
        if (args.operation === 'release') leases.delete(identity.playerId);
        else leases.set(identity.playerId, { connectionId: identity.connectionId, reservationId: args.reservationId,
          tableId: args.tableId ?? lease?.tableId ?? null });
        return { playerId: identity.playerId, ...leases.get(identity.playerId) };
      }
      if (op === 'create_game_invite' || op === 'get_game_invite') {
        assert.equal(leases.get(identity.playerId)?.tableId, args.tableId, 'Invitation writes require a bound lease');
      }
      if (op === 'create_game_invite') { tables.set(args.tableId, { ...args, gameId: randomUUID() }); return {}; }
      if (op === 'inspect_game_invite' || op === 'get_game_invite') return tables.get(args.tableId);
      throw Error('Unexpected product request: ' + op);
    },
    createEngine: actor => {
      let tableId = actor.activeTableId ?? null;
      const engine = {
        open: async () => {}, close() {}, subscribe: () => () => {},
        matchesPlayerGrant: current => current.connectionId === actor.connectionId && (current.activeTableId ?? null) === tableId,
        async createGame(args, register, lease) {
          assert.deepEqual(args.deck, { ...deck, libraryDeckId: 'shared' });
          await lease?.reserve();
          tableId = randomUUID();
          await lease?.bind(tableId);
          await register({ tableId, roomId: randomUUID(), format: args.format });
          return { tableId };
        },
        async joinGame(args, invitation, claim, lease) {
          assert.deepEqual(args.deck, { ...deck, libraryDeckId: 'shared' });
          await lease?.reserve();
          await lease?.bind(args.tableId);
          await claim();
          tableId = invitation.tableId;
          return { tableId };
        },
        snapshot: () => ({ gameId: tables.get(tableId)?.gameId, tableId, ownHand: [actor.engineName],
          cursor: 1, status: 'active', decision: { id: 'choice', kind: 'priority', choices: [{ id: 'pass', type: 'pass' }] } }),
        listChat: async gameId => ({ gameId, reader: actor.playerId }),
      };
      seats.set(actor.playerId, engine);
      return engine;
    },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); server.closeAllConnections(); server.close(); });
  async function connect(token) {
    const client = new Client({ name: 'profile-fixture', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + server.address().port + '/mcp'), {
      requestInit: { headers: { authorization: 'Bearer ' + token } },
    }));
    clients.push(client);
    return async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return JSON.parse(r.content[0].text);
    };
  }
  const calls = await Promise.all(identities.map(p => connect(p.token)));
  const tableIds = [];
  for (const i of [0, 2]) {
    const host = identities[i], guest = identities[i+1];
    assert.deepEqual((await calls[i]('list_players')).players.map(p => p.playerId), [host.playerId]);
    const created = await calls[i]('create_game', { playerId: host.playerId, name: 'Fixture', format: 'Pioneer',
      deckId: 'shared', guestEngineName: guest.engineName });
    assert.ok(created.tableId, JSON.stringify(created));
    tableIds.push(created.tableId);
    const joined = await calls[i+1]('join_game', { playerId: guest.playerId, tableId: created.tableId, deckId: 'shared' });
    assert.equal(joined.tableId, created.tableId);
  }
  assert.equal(new Set(tableIds).size, 2);
  assert.equal(leases.size, 4);
  for (let i=0;i<identities.length;i++) {
    const { playerId, engineName } = identities[i];
    const gameId = tables.get(tableIds[Math.floor(i/2)]).gameId;
    const call = calls[i];
    assert.deepEqual((await call('get_game_state', { playerId, gameId })).ownHand, [engineName]);
    assert.deepEqual((await call('wait_for_decision', { gameId, timeoutMs: 100 })).state.ownHand, [engineName]);
    assert.equal((await call('list_chat', { playerId, gameId })).reader, playerId);
    assert.equal((await call('get_game_state', { playerId: identities[i^1].playerId })).code, 'player_forbidden');
    assert.equal((await call('get_game_state', { humanTableId: tableIds[Math.floor(i/2)] })).code, 'player_forbidden');
    assert.equal((await call('get_replay', { gameId })).code, 'forbidden');
    assert.equal((await call('list_human_decks')).code, 'player_forbidden');
  }
  const otherGrant = { ...identities[0], connectionId: randomUUID() };
  grants.set('fixture-second-grant', otherGrant);
  const second = await connect('fixture-second-grant');
  assert.equal((await second('get_game_state')).code, 'player_busy');
  assert.equal((await second('get_card', { name: 'Forest' })).code, 'player_busy');
  assert.equal((await second('get_deck', { deckId: 'shared' })).id, 'shared');
});
