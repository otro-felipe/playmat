import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'

const databaseUrl = process.env.PLAYMAT_TEST_DATABASE_URL
const password = 'synthetic-fixture-credential'

async function fixture(t, store = new Map()) {
  const { createProduct } = await import('./product.mjs')
  const replayDirectory = await mkdtemp(join(tmpdir(), 'playmat-replays-'))
  const schema = `test_${randomUUID().replaceAll('-', '')}`
  const product = await createProduct({ databaseUrl, schema, replayDirectory, store, insecureCookie: true, enableInternal: true })
  const server = product.server
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.close()
    await product.dropTestSchema()
    await product.close()
    await rm(replayDirectory, { recursive: true, force: true })
  })
  const endpoint = `http://127.0.0.1:${server.address().port}`
  return { product, replayDirectory, endpoint, path: (route, init) => fetch(endpoint + route, init) }
}

async function signIn(f, name) {
  await f.product.provisionHuman(name, password)
  const response = await f.path('/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: name, password }),
  })
  assert.equal(response.status, 303)
  return { Cookie: response.headers.get('set-cookie').split(';')[0] }
}

function json(method, headers, body) {
  return { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

test('[PM-AC-04] password sign-in and scoped forward auth reject forged or revoked identities', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  assert.equal((await f.path('/internal/verify', { headers: { 'X-Playmat-User': 'Alice' } })).status, 401)
  assert.equal((await f.path('/register', json('POST', {}, { username: 'guest', password }))).status, 404)
  const alice = await signIn(f, 'Alice')
  const verified = await f.path('/internal/verify', { headers: { ...alice, 'X-Playmat-User': 'Mallory' } })
  assert.equal(verified.headers.get('X-Playmat-User'), 'Alice')
  const grant = await f.product.provisionAgent('Alice', 'AgentAlice', ['play','library','history'])
  const agent = { Authorization: `Bearer ${grant}` }
  const identity = await (await f.path('/internal/verify', { headers: agent })).json()
  assert.equal(identity.engineName, 'AgentAlice')
  assert.notEqual(identity.engineName, 'Alice')
  await f.product.revokeAgent(grant)
  assert.equal((await f.path('/internal/verify', { headers: agent })).status, 401)
  assert.equal((await f.path('/logout', { method: 'POST', headers: alice, redirect: 'manual' })).status, 303)
  assert.equal((await f.path('/internal/verify', { headers: alice })).status, 401)
})

test('[PM-AC-05] browser and delegated agent share immutable owned revisions and reject stale writes', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  const bob = await signIn(f, 'Bob')
  const token = await f.product.provisionAgent('Alice', 'AgentAlice', ['library'])
  const agent = { Authorization: `Bearer ${token}` }
  const deckId = randomUUID()
  const route = `/api/playtesting/decks/${deckId}`
  const deck = { name: 'Mono Red', format: 'Pioneer', cards: [{ name: 'Mountain', set: 'DMU', number: '280', quantity: 60 }], sideboard: [] }
  assert.equal((await f.path(route, json('PUT', alice, { expectedRevision: 0, data: deck }))).status, 200)
  assert.equal((await f.path(route, { headers: bob })).status, 404)
  assert.equal((await (await f.path(route, { headers: agent })).json()).revision, 1)
  const results = await Promise.all([alice, agent].map((headers, i) => f.path(route, json('PUT', headers, {
    expectedRevision: 1, data: { ...deck, name: `Version ${i}` },
  }))))
  assert.deepEqual(results.map(x => x.status).sort(), [200, 409])
  const saved = await (await f.path(route, { headers: alice })).json()
  assert.equal(saved.revision, 2)
  assert.equal((await f.path(route + '?revision=1', { headers: agent })).status, 200)
  assert.equal((await (await f.path(route + '?revision=1', { headers: agent })).json()).data.name, 'Mono Red')
})

async function addReplay(f, matchId, gameId, names) {
  const now = Date.now()
  const info = {
    gameId, matchId, tableId: matchId, startedAt: now - 1000, endedAt: now,
    result: 'Game finished', winner: names[0], turns: 4, events: 2, deckType: 'Constructed - Pioneer',
    players: names.map(name => ({ name, human: true, deck: { cards: [`private:${name}`] } })),
  }
  await writeFile(join(f.replayDirectory, gameId + '.json'), JSON.stringify(info))
  const data = [
    { t: 100, view: { turn: 1, players: names.map(name => ({ name })) }, hands: Object.fromEntries(names.map(name => [name, [`secret:${name}`]])) },
    { t: 105, log: { messageType: 'TALK', message: 'private chat' } },
  ]
  await writeFile(join(f.replayDirectory, gameId + '.ndjson.gz'), gzipSync(data.map(row => JSON.stringify(row)).join('\n')))
}

test('[PM-AC-11] archive outage leaves the game visible and idempotent retry marks one verified artifact ready', { skip: !databaseUrl }, async t => {
  const objects = new Map()
  let shouldFail = true
  const f = await fixture(t, {
    async put(key, body) {
      if (shouldFail) throw Error('fixture archive unavailable')
      objects.set(key, body)
    },
    async get(key) { return objects.get(key) },
  })
  const alice = await signIn(f, 'Alice')
  await signIn(f, 'Bob')
  const match = randomUUID()
  const game = randomUUID()
  await addReplay(f, match, game, ['Alice', 'Bob'])
  await f.product.archiveGames()
  let history = await (await f.path('/api/playtesting/matches', { headers: alice })).json()
  assert.equal(history.matches[0].id, match)
  assert.equal(history.matches[0].games[0].archiveState, 'pending')
  shouldFail = false
  await f.product.archiveGames()
  await f.product.archiveGames()
  history = await (await f.path('/api/playtesting/matches', { headers: alice })).json()
  assert.equal(history.matches[0].games[0].archiveState, 'ready')
  assert.equal(objects.size, 1)
  const response = await f.path(`/api/playtesting/replays/${game}`, { headers: alice })
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.match(text, /secret:Alice/)
  assert.doesNotMatch(text, /secret:Bob|private:Bob|private chat|objectKey/)
})

test('[PM-AC-12] bounded batch export preserves only the requesting seat and rejects mixed ownership', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  const bob = await signIn(f, 'Bob')
  await signIn(f, 'Carol')
  const game1 = randomUUID()
  const game2 = randomUUID()
  const game3 = randomUUID()
  await addReplay(f, randomUUID(), game1, ['Alice', 'Bob'])
  await addReplay(f, randomUUID(), game2, ['Alice', 'Carol'])
  await addReplay(f, randomUUID(), game3, ['Bob', 'Carol'])
  await f.product.archiveGames()
  assert.equal((await f.path(`/api/playtesting/replays/${game2}`, { headers: bob })).status, 404)
  const exportRoute = '/api/playtesting/exports'
  assert.equal((await f.path(exportRoute, json('POST', alice, { gameIds: [game1, game3] }))).status, 404)
  const result = await f.path(exportRoute, json('POST', alice, { gameIds: [game1, game2] }))
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('content-type'), 'application/zip')
  const { unzipSync, strFromU8 } = await import('fflate')
  const archive = unzipSync(new Uint8Array(await result.arrayBuffer()))
  const content = Object.values(archive).map(strFromU8).join('\n')
  assert.match(content, /secret:Alice/)
  assert.doesNotMatch(content, /secret:Bob|secret:Carol|private:Bob|private:Carol|private chat|objectKey/)
  assert.ok(archive['manifest.json'])
  assert.ok(archive['summary.csv'])
})
