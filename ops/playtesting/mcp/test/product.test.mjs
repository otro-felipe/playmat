import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createProductClient } from '../src/product.mjs';

test('MCP list and create operations reuse the account opponent library', async (t) => {
  const calls = [];
  const product = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url, method: req.method, auth: req.headers.authorization, ...(raw ? { body: JSON.parse(raw) } : {}) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ decks: [] }));
  });
  product.listen(0, '127.0.0.1');
  await once(product, 'listening');
  t.after(() => product.close());
  const client = createProductClient(`http://127.0.0.1:${product.address().port}`);
  await client.operation('library-fixture', 'list_decks', {});
  const deckId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const deck = { cards: [{ name: 'Forest', quantity: 60 }], sideboard: [] };
  await client.operation('library-fixture', 'update_deck', { deckId, expectedRevision: 2, name: 'Rival', format: 'Pioneer', deck });
  assert.deepEqual(calls, [
    { path: '/api/playtesting/decks?library=agent', method: 'GET', auth: 'Bearer library-fixture' },
    { path: `/api/playtesting/decks/${deckId}`, method: 'PUT', auth: 'Bearer library-fixture', body: { name: 'Rival', format: 'Pioneer', data: deck, expectedRevision: 2 } },
  ]);
});

test('[PM-AC-08] Railway library and play grants authorize the corresponding MCP tools', async (t) => {
  const product = createServer((req, res) => {
    assert.equal(req.url, '/internal/verify');
    const scopes = req.headers.authorization === 'Bearer play-fixture' ? ['play'] : ['library', 'history'];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ accountId: 'fixture', engineName: 'TestAgent', scopes }));
  });
  product.listen(0, '127.0.0.1');
  await once(product, 'listening');
  t.after(() => product.close());

  const client = createProductClient(`http://127.0.0.1:${product.address().port}`);
  const play = await client.authorize('play-fixture');
  assert.deepEqual(play.scopes, ['play', 'catalog']);
  const library = await client.authorize('library-fixture');
  assert.deepEqual(library.scopes, ['library', 'history', 'catalog', 'decks']);
});
