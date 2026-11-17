import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createProductClient } from '../src/product.mjs';

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
