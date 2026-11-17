import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpServer } from '../src/server.mjs';

const engineUrl = process.env.PLAYMAT_LIVE_ENGINE_URL;
const runId = randomBytes(3).toString('hex');
const NAME_ONE = `MCPA${runId}`;
const NAME_TWO = `MCPB${runId}`;
const DECK = {
  name: 'Pioneer fixture',
  cards: [{ cardName: 'Forest', amount: 60 }],
  sideboard: [{ cardName: 'Mountain', amount: 1 }],
};
const SIDEBOARDED = {
  name: 'Pioneer fixture',
  cards: [{ cardName: 'Forest', amount: 59 }, { cardName: 'Mountain', amount: 1 }],
  sideboard: [{ cardName: 'Forest', amount: 1 }],
};

test('[PM-AC-08] joins a private real XMage Bo3 through two authenticated MCP clients', { skip: !engineUrl, timeout: 120_000 }, async (t) => {
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
      if (token === 'fixture-two' && operation === 'get_game_invite' && args.tableId === invitation?.tableId) return invitation;
      return null;
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    server.closeAllConnections();
    server.close();
  });
  for (const token of ['fixture-one', 'fixture-two']) {
    const client = new Client({ name: 'playmat-mcp-live-fixture', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    clients.push(client);
  }

  async function call(client, name, args = {}) {
    const response = await client.callTool({ name, arguments: args });
    const result = JSON.parse(response.content[0].text);
    if (response.isError) throw new Error(`${name}: ${JSON.stringify(result)}`);
    return result;
  }

  const [host, guest] = clients;
  const { tableId } = await call(host, 'create_game', {
    name: 'MCP Bo3 integration fixture', format: 'Pioneer', deck: DECK, guestEngineName: NAME_TWO,
  });
  await call(guest, 'join_game', { tableId, deck: DECK });
  await call(host, 'start_match', { tableId });
  const read = (client) => call(client, 'get_game_state');
  const until = async (predicate, description, deadlineMs = 15_000) => {
    const end = Date.now() + deadlineMs;
    while (Date.now() < end) {
      const result = await predicate();
      if (result) return result;
      await sleep(50);
    }
    const states = await Promise.all(clients.map(read));
    throw new Error(`Timed out: ${description}; ${JSON.stringify(states.map(({ gameId, status, decision, step, turn, score }) => ({ gameId, status, decision: decision?.kind, step, turn, score })))}`);
  };

  async function playOpenDecision(client, landPlayed) {
    const state = await read(client);
    const decision = state.decision;
    if (!state.gameId || !decision) return false;
    const pick = (pattern) => decision.choices.find((choice) => pattern.test(choice.label));
    const land = !landPlayed.value && decision.kind === 'priority' && decision.choices.find((choice) =>
      choice.card?.types.includes('LAND') && state.ownHand.some((card) => card.id === choice.card.id));
    const chosen = land || pick(/^Keep\b|^Play first\b/) || decision.choices.find((choice) => choice.type === 'pass')
      || decision.choices.find((choice) => choice.type === 'button') || decision.choices[0];
    if (!chosen) return false;
    const result = await call(client, 'submit_decision', { gameId: state.gameId, decisionId: decision.id, choiceId: chosen.id, idempotencyKey: decision.id });
    assert.equal(result.submitted, true);
    if (land) landPlayed.value = true;
    return state;
  }

  async function playUntilLand(excludedId) {
    const landPlayed = { value: false };
    let playedDuringOpponentTurn = false;
    const gameId = await until(async () => {
      const [first, second] = await Promise.all(clients.map(read));
      if (!first.gameId || first.gameId === excludedId || first.gameId !== second.gameId) return false;
      for (const [index, client] of clients.entries()) {
        const action = await playOpenDecision(client, landPlayed);
        if (action?.decision?.kind === 'priority' && action.activePlayer !== [NAME_ONE, NAME_TWO][index]) playedDuringOpponentTurn = true;
      }
      if (!landPlayed.value || !playedDuringOpponentTurn) return false;
      return first.gameId;
    }, 'typed choice and ordinary priority on an opponent turn in new game', 30_000);
    return gameId;
  }

  const firstGameId = await playUntilLand();
  await call(guest, 'send_chat', { gameId: firstGameId, message: 'BDD fixture greeting' });
  await until(async () => (await call(host, 'list_chat', { gameId: firstGameId })).messages.some((m) => m.message === 'BDD fixture greeting'),
    'game chat received');
  await call(host, 'concede', { gameId: firstGameId, entireMatch: false });
  const sideboards = await until(async () => {
    for (const client of clients) {
      const state = await read(client);
      if (state.status === 'active') await playOpenDecision(client, { value: true });
    }
    const states = await Promise.all(clients.map(read));
    return states.every(({ status }) => status === 'sideboarding') && states;
  }, 'both seats enter sideboarding');
  for (const [index, client] of clients.entries()) {
    const sideboard = await call(client, 'get_sideboard_state', { gameId: firstGameId });
    assert.equal(sideboard.decisionId, sideboards[index].sideboard.decisionId);
    const submitted = await call(client, 'submit_sideboard', { gameId: firstGameId, decisionId: sideboard.decisionId, deck: index ? DECK : SIDEBOARDED });
    assert.equal(submitted.submitted, true);
  }

  const secondGameId = await playUntilLand(firstGameId);
  assert.notEqual(firstGameId, secondGameId);
  await call(host, 'concede', { gameId: secondGameId, entireMatch: false });
  await until(async () => {
    for (const client of clients) {
      const state = await read(client);
      if (state.status === 'active') await playOpenDecision(client, { value: true });
    }
    const result = await read(guest);
    return result.status === 'match_over' && result.score?.wins === 2;
  }, '2–0 match result');
});
