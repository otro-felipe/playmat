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
  const closed = [];
  let race;

  const server = createMcpServer({
    maxSeats: 4,
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
      if (op === 'get_deck') {
        if (race && identity.playerId === identities[0].playerId) {
          if (token === 'fixture-racing-grant') {
            race.contenderRead();
            await race.hostReserved;
          } else {
            await race.contenderAtDeck;
          }
        }
        return { id: 'shared', library: 'agent', data: deck };
      }
      if (op === 'player_reservation') {
        const lease = leases.get(identity.playerId);
        assert.equal(args.playerId, identity.playerId);
        if (lease && (lease.reservationId !== args.reservationId || lease.connectionId !== identity.connectionId)) {
          throw new ToolError('player_busy', 'Reserved by another connection');
        }
        if (race && token === identities[0].token && args.operation === 'reserve') race.hostAcquired();
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
      let ended = false;
      const listeners = new Set();
      const engine = {
        profileId: actor.playerId, profileConnectionId: actor.connectionId,
        open: async () => {}, close() { closed.push(actor.connectionId); },
        subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        async respond() {
          ended = true;
          for (const listener of listeners) listener();
          return { submitted:true };
        },
        matchesPlayerGrant: current => current.connectionId === actor.connectionId && (current.activeTableId ?? null) === tableId,
        async createGame(args, register, lease) {
          assert.deepEqual(args.deck, { ...deck, libraryDeckId: 'shared' });
          tableId = randomUUID();
          await lease?.bind(tableId);
          await register({ tableId, roomId: randomUUID(), format: args.format });
          return { tableId };
        },
        async joinGame(args, invitation, claim, lease) {
          assert.deepEqual(args.deck, { ...deck, libraryDeckId: 'shared' });
          await lease?.bind(args.tableId);
          await claim();
          tableId = invitation.tableId;
          return { tableId };
        },
        snapshot: () => ({ gameId: tables.get(tableId)?.gameId, tableId, ownHand: [actor.engineName],
          cursor: ended ? 2 : 1, status: ended ? 'match_over' : 'active', stack: [], players: [], priority:'self', turn:1, epoch:'test', decision: ended ? null : { id: 'choice', kind: 'priority', choices: [{ id: 'pass', type: 'pass' }] } }),
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
    const listed = (await client.listTools()).tools;
    assert.deepEqual(listed.find(t => t.name === 'create_game').inputSchema.properties.spectatorVisibility.enum, ['public-board','both-hands']);
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
    const create = { playerId: host.playerId, name: 'Fixture', format: 'Pioneer',
      deckId: 'shared', guestEngineName: guest.engineName, ...(i===2 ? {spectatorVisibility:'both-hands'} : {}) };
    let created;
    if (i === 0) {
      const rivalGrant = { ...host, connectionId: randomUUID() };
      grants.set('fixture-racing-grant', rivalGrant);
      const contender = await connect('fixture-racing-grant');
      const read = Promise.withResolvers(), acquired = Promise.withResolvers();
      race = { contenderAtDeck: read.promise, contenderRead: read.resolve, hostReserved: acquired.promise, hostAcquired: acquired.resolve };
      const [winner, rejected] = await Promise.all([calls[i]('create_game', create), contender('create_game', create)]);
      race = null;
      assert.equal(rejected.code, 'player_busy', 'The losing grant must fail its database reservation');
      assert.ok(!closed.includes(host.connectionId), 'The losing request must never close the winning connection');
      created = winner;
    } else {
      created = await calls[i]('create_game', create);
    }
    assert.ok(created.tableId, JSON.stringify(created));
    assert.equal(tables.get(created.tableId).spectatorVisibility, i===2 ? 'both-hands' : undefined);
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
    assert.equal((await call('get_replay', { gameId })).code, 'history_account_only');
    assert.equal((await call('list_human_decks')).code, 'player_forbidden');
  }
  const otherGrant = { ...identities[0], connectionId: randomUUID() };
  grants.set('fixture-second-grant', otherGrant);
  const second = await connect('fixture-second-grant');
  assert.equal((await second('get_game_state')).code, 'player_busy');
  assert.equal((await second('get_card', { name: 'Forest' })).code, 'player_busy');
  assert.equal((await second('get_deck', { deckId: 'shared' })).id, 'shared');
  const gameId = tables.get(tableIds[0]).gameId;
  const commandId = 'end-match';
  const line = await calls[0]('play_line',{ gameId, cursor:1, commandId, waitMs:100,
    actions:[{kind:'choose',decisionId:'choice',choiceId:'pass'}] });
  assert.equal(line.state?.status, 'match_over');
  leases.delete(identities[0].playerId); // Product archived the match before receipt recovery.
  const recover = () => calls[0]('wait_for_decision',{gameId,commandId});
  assert.equal((await recover()).event,'match_over');
  assert.equal((await second('wait_for_decision',{gameId,commandId})).state,undefined);
  const fifth = { ...identities[0], token:'fixture-fifth', playerId:randomUUID(), connectionId:randomUUID(), engineName:'Fixture5' };
  grants.set(fifth.token,fifth);
  const newPilot = await connect(fifth.token);
  const next=await newPilot('create_game',{name:'Next',format:'Pioneer',deckId:'shared',guestEngineName:identities[1].engineName,spectatorVisibility:'public-board'});
  assert.equal(tables.get(next.tableId).spectatorVisibility,'public-board');
  assert.equal((await recover()).event,'match_over','The connection still recovers its terminal receipt after eviction');
  assert.ok(!('ownHand' in (await recover()).state));
  assert.equal((await calls[1]('get_game_state')).ownHand[0], identities[1].engineName);
});
