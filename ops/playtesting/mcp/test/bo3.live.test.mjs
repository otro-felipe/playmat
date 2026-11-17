import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpServer } from '../src/server.mjs';

const engineUrl = process.env.PLAYMAT_LIVE_ENGINE_URL;
const deploymentMcp = process.env.PLAYMAT_LIVE_MCP_URL;
const runId = randomBytes(3).toString('hex');
const NAME_ONE = deploymentMcp ? process.env.PLAYMAT_LIVE_MCP_ENGINE_NAME_1 : `MCPA${runId}`;
const NAME_TWO = deploymentMcp ? process.env.PLAYMAT_LIVE_MCP_ENGINE_NAME_2 : `MCPB${runId}`;
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
    name: 'MCP Bo3 integration fixture', format: 'Pioneer', deck: DECK, guestEngineName: NAME_TWO,
  });
  if (deploymentMcp) {
    const { invites } = await call(guest, 'list_joinable_games', { limit: 50 });
    assert.ok(invites.some((entry) => entry.tableId === tableId), 'The intended agent can discover the invitation.');
    const hostInvites = await call(host, 'list_joinable_games', { limit: 50 });
    assert.ok(!hostInvites.invites.some((entry) => entry.tableId === tableId), 'The invitation is scoped to the requested seat.');
  }
  await call(guest, 'join_game', { tableId, deck: DECK });
  await call(host, 'start_match', { tableId });
  const read = (client) => call(client, 'get_game_state');
  const until = async (predicate, description, deadlineMs = 15_000) => {
    const end = Date.now() + deadlineMs;
    while (Date.now() < end) {
      const result = await predicate();
      if (result) return result;
      await sleep(125);
    }
    const states = await Promise.all(clients.map(read));
    throw new Error(`Timed out: ${description}; ${JSON.stringify(states.map(({ status, decision, step, turn, score }) => ({ status, decision: decision?.kind, step, turn, score })))}`);
  };

  async function playOpenDecision(client, landPlayed, state = null) {
    state ??= await read(client);
    const decision = state.decision;
    if (state.status !== 'active' || !state.gameId || !decision) return false;
    const pick = (pattern) => decision.choices.find((choice) => pattern.test(choice.label));
    const land = !landPlayed.value && decision.kind === 'priority' && decision.choices.find((choice) =>
      choice.card?.types.includes('LAND') && state.ownHand.some((card) => card.id === choice.card.id));
    const chosen = land || pick(/^Keep\b|^Play first\b/) || decision.choices.find((choice) => choice.type === 'pass')
      || decision.choices.find((choice) => choice.type === 'button') || decision.choices[0];
    if (!chosen) return false;
    const result = await call(client, 'submit_decision', { gameId: state.gameId, decisionId: decision.id, choiceId: chosen.id, idempotencyKey: decision.id },
      ['not_actionable', 'stale_decision']);
    if (!result) return false;
    assert.equal(result.submitted, true);
    if (land) landPlayed.value = true;
    return state;
  }

  async function playUntilLand(excludedId) {
    const landPlayed = { value: false };
    let playedDuringOpponentTurn = false;
    let lastResync = Date.now();
    const gameId = await until(async () => {
      const states = await Promise.all(clients.map(read));
      const [first, second] = states;
      if (!first.gameId || first.gameId === excludedId || first.gameId !== second.gameId) return false;
      for (const [index, client] of clients.entries()) {
        const action = await playOpenDecision(client, landPlayed, states[index]);
        if (action?.decision?.kind === 'priority' && action.activePlayer !== [NAME_ONE, NAME_TWO][index]) playedDuringOpponentTurn = true;
      }
      if (Date.now() - lastResync > 8_000 && states.every((state) => state.status === 'active' && !state.decision)) {
        lastResync = Date.now();
        await Promise.all(clients.map((client) => call(client, 'resync_game', { gameId: first.gameId }, ['forbidden_game'])));
      }
      if (!landPlayed.value || !playedDuringOpponentTurn) return false;
      return first.gameId;
    }, 'typed choice and ordinary priority on an opponent turn in new game', 60_000);
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

  if (deploymentMcp) {
    const match = await until(async () => {
      const { matches } = await call(guest, 'list_matches', { format: 'Pioneer', limit: 50 });
      return matches.find((entry) => entry.tableId === tableId
        && [firstGameId, secondGameId].every((gameId) =>
          entry.games.some((game) => game.gameId === gameId && game.replayAvailable)));
    }, 'both game archives available in the invited seat history', 60_000);
    const detail = await call(guest, 'get_match', { matchId: match.id });
    assert.equal(detail.games.length, 2);
    const replay = await call(guest, 'get_replay', { gameId: firstGameId, start: 0, count: 3 });
    assert.ok(replay.events.length > 0, 'A participant can read events from the stored replay.');
    const bundle = await call(guest, 'export_matches', { gameIds: [firstGameId, secondGameId] });
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
    console.log('Verified deployed invites, 2–0 Bo3 with sideboarding, replay history and authorized batch export.');
  }
});
