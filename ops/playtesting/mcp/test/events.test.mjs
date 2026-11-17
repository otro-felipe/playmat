import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../src/server.mjs';

const actor = { accountId: 'account', engineName: 'Rival', scopes: ['play'] };
const metadata = 'https://example.invalid/.well-known/oauth-protected-resource/mcp';
const gameId = '198a6077-35fc-4a99-9617-69cc59f39418';

async function fixture(t, options = {}) {
  const server = createMcpServer({
    authorize: async token => token === 'fixture-rival' ? actor
      : token === 'fixture-other' ? { ...actor, scopes: ['history'] } : null,
    oauthResourceMetadata: metadata,
    createEngine: () => { throw Error('No engine is needed to subscribe'); },
    ...options,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return async (method, params, token = 'fixture-rival') => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/mcp', {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return { status: response.status, challenge: response.headers.get('www-authenticate'), ...(await response.json()) };
  };
}

test('[PM-AC-17] discover, subscribe and unsubscribe on Streamable HTTP with the OAuth challenge and protocol errors', async t => {
  const forwarded = [];
  const rpc = await fixture(t, { eventRequest: async (token, method, args) => {
    forwarded.push([token, method, args]);
    if (method === 'list') return { events: [{ name: 'game.invitation.created' }] };
    if (method === 'subscribe') throw new McpError(-32015, 'Callback verification failed', { reason: 'challenge_failed' });
    return {};
  } });
  const auth = await rpc('events/list', {}, 'expired');
  assert.equal(auth.status, 401);
  assert.match(auth.challenge, /\/\.well-known\/oauth-protected-resource\/mcp/);
  const initialized = await rpc('initialize', {
    protocolVersion: '2025-03-26', clientInfo: { name: 'fixture', version: '1' }, capabilities: {},
  });
  assert.deepEqual(initialized.result.capabilities.events, {});
  assert.equal((await rpc('events/list', {})).result.events[0].name, 'game.invitation.created');
  assert.deepEqual((await rpc('events/list', {}, 'fixture-other')).result, { events: [] });
  const rejected = await rpc('events/subscribe', { name: 'game.invitation.created' });
  assert.equal(rejected.error.code, -32015);
  assert.equal(rejected.error.data.reason, 'challenge_failed');
  assert.deepEqual((await rpc('events/unsubscribe', { name: 'game.invitation.created' })).result, {});
  assert.deepEqual(forwarded.map(([, method]) => method), ['list', 'subscribe', 'unsubscribe']);
  assert.ok(forwarded.every(([token]) => token === 'fixture-rival'));
});

test('[PM-AC-17] a seated agent gets one notification per actionable decision even while idle, and obsolete notifications are invalidated', async t => {
  const listeners = new Set();
  let snapshot = { status: 'lobby', gameId: null, decision: null };
  const engine = {
    snapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const published = [];
  const rpc = await fixture(t, {
    createEngine: () => engine,
    publishSeatEvent: async (operation, payload) => published.push({ operation, payload }),
  });
  await rpc('tools/call', { name: 'get_game_state', arguments: {} });
  function emit(changes) {
    snapshot = { ...snapshot, ...changes };
    for (const listener of listeners) listener();
  }
  emit({ status: 'active', gameId, cursor: 7, secondsRemaining: 10,
    decision: { id: 'decision-1', kind: 'priority', choices: [{ id: 'one', card: { name: 'Private' } }] } });
  await sleep(20);
  emit({ cursor: 8 });
  await sleep(20);
  emit({ decision: { id: 'no-action', kind: 'waiting', choices: [] } });
  await sleep(20);
  assert.deepEqual(published.map(({ operation, payload }) => [operation, payload.key]), [
    ['enqueue', gameId + ':decision-1'], ['invalidate', gameId + ':decision-1'],
  ]);
  assert.deepEqual(published[0].payload.data, { gameId, decisionId: 'decision-1', cursor: 7, kind: 'priority' });
  assert.equal(published[0].payload.accountId, actor.accountId);
  assert.doesNotMatch(JSON.stringify(published), /Private/);
});
