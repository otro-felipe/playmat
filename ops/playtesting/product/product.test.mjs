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

test('[PM-AC-04] the claimed guest and actual table host control admission', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  const bob = await signIn(f, 'Bob')
  const carol = await signIn(f, 'Carol')
  const tableId = randomUUID()
  const roomId = randomUUID()
  const route = '/api/playtesting/invites'
  const invite = await f.path(route, json('POST', alice, {
    tableId, roomId, guestEngineName: 'Bob', format: 'Pioneer', password,
  }))
  assert.equal(invite.status, 201)
  assert.equal(Object.hasOwn(await invite.json(), 'password'), false)
  assert.deepEqual((await (await f.path(route, { headers: alice })).json()).invites, [])
  assert.deepEqual((await (await f.path(route, { headers: carol })).json()).invites, [])
  assert.deepEqual((await (await f.path(route + '?limit=1', { headers: bob })).json()).invites.map(row => row.tableId), [tableId])
  const claim = route + '/' + tableId + '/claim'
  const gate = '/internal/invites/' + tableId + '?host=Alice&guest=Bob'
  assert.equal((await f.path(gate)).status, 404)
  assert.equal((await f.path(claim, { method: 'POST', headers: carol })).status, 404)
  const accepted = await Promise.all([1, 2].map(() => f.path(claim, { method: 'POST', headers: bob })))
  assert.deepEqual(accepted.map(response => response.status), [200, 200])
  assert.deepEqual(await accepted[0].json(), await accepted[1].json())
  assert.equal((await f.path(gate)).status, 200)
  assert.equal((await f.path(gate.replace('=Alice', '=Carol'))).status, 404)
})

test('[PM-AC-04] a prehashed provisioning import is idempotent and cannot rotate an existing identity', { skip: !databaseUrl }, async t => {
  const { newToken, prepareProvisionBundle } = await import('./identity.mjs')
  const f = await fixture(t)
  const grant = newToken()
  const replacement = newToken()
  const first = await prepareProvisionBundle({
    accounts: [{ username: 'Alice', password }],
    agents: [{ owner: 'Alice', engineName: 'AgentAlice', token: grant, scopes: ['play'] }],
  })
  assert.doesNotMatch(JSON.stringify(first), new RegExp(password + '|' + grant))
  await f.product.importProvisionBundle(first)
  await f.product.importProvisionBundle(first)
  await f.product.importProvisionBundle(await prepareProvisionBundle({
    accounts: [{ username: 'alice', password: 'different-synthetic-password' }],
    agents: [{ owner: 'Alice', engineName: 'agentalice', token: replacement, scopes: ['play', 'history'] }],
  }))
  const response = await f.path('/login', {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ username: 'Alice', password }),
  })
  assert.equal(response.status, 303)
  const initial = await f.path('/internal/verify', { headers: { Authorization: 'Bearer ' + grant } })
  assert.deepEqual((await initial.json()).scopes, ['play'])
  assert.equal((await f.path('/internal/verify', { headers: { Authorization: 'Bearer ' + replacement } })).status, 401)
})

test('[PM-AC-04] provisioning revokes only the targeted grant and preserves independently scoped replacements', { skip: !databaseUrl }, async t => {
  const { digest, newToken, prepareProvisionBundle } = await import('./identity.mjs')
  const f = await fixture(t)
  await f.product.provisionHuman('Alice', password)
  const original = await f.product.provisionAgent('Alice', 'AgentAlice', ['play', 'library', 'history', 'chat'])
  const rival = newToken()
  const analyst = newToken()
  const verify = token => f.path('/internal/verify', { headers: { Authorization: 'Bearer ' + token } })
  const provision = await prepareProvisionBundle({
    agents: [
      { owner: 'Alice', engineName: 'AliceRival', token: rival, scopes: ['play', 'chat'] },
      { owner: 'Alice', engineName: 'AliceLab', token: analyst, scopes: ['library', 'history'] },
    ],
    revocations: [{ token: original }],
  })
  assert.equal((await verify(original)).status, 200)
  await f.product.importProvisionBundle(provision)
  assert.equal((await verify(original)).status, 401)
  assert.deepEqual(provision.revocations, [{ tokenDigest: digest(original) }])
  assert.doesNotMatch(JSON.stringify(provision), new RegExp(original))
  await f.product.importProvisionBundle(provision)
  await f.product.importProvisionBundle({ revocations: [{ tokenDigest: digest(newToken()) }] })
  await f.product.importProvisionBundle(await prepareProvisionBundle({
    agents: [{ owner: 'Alice', engineName: 'agentalice', token: original, scopes: ['play'] }],
  }))
  assert.equal((await verify(original)).status, 401)
  assert.deepEqual((await (await verify(rival)).json()).scopes, ['play', 'chat'])
  assert.deepEqual((await (await verify(analyst)).json()).scopes, ['library', 'history'])
  await assert.rejects(prepareProvisionBundle({ revocations: [{ token: 'invalid' }] }), { status: 400 })
  await assert.rejects(f.product.importProvisionBundle({
    revocations: [{ tokenDigest: digest(rival) }, { tokenDigest: 'invalid' }],
  }), { status: 400 })
  assert.equal((await verify(rival)).status, 200)
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

test('[PM-AC-11] restart interrupts sideboarding even after the prior game archive was collected', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  await signIn(f, 'Bob')
  const matchId = randomUUID()
  const gameId = randomUUID()
  const path = '/api/playtesting/matches/' + matchId
  await addReplay(f, matchId, gameId, ['Alice', 'Bob'])
  await f.product.archiveGames()
  let match = await (await f.path(path, { headers: alice })).json()
  assert.equal(match.status, 'active')
  assert.equal(match.games[0].archiveState, 'ready')
  await f.product.archiveGames({ markInterrupted: true })
  match = await (await f.path(path, { headers: alice })).json()
  assert.equal(match.status, 'interrupted')
  assert.equal(match.games[0].status, 'completed')
  assert.equal(match.games[0].archiveState, 'ready')
})

test('[PM-AC-11] startup ingests a finalized match before archiving and keeps its terminal status after retries', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  await signIn(f, 'Bob')
  const finishedMatch = '00000000-0000-0000-0000-000000000001'
  const completedGame = 'ffffffff-ffff-ffff-ffff-fffffffffff1'
  const abandonedMatch = randomUUID()
  const abandonedGame = randomUUID()
  await writeFile(join(f.replayDirectory, finishedMatch + '.match.json'), JSON.stringify({
    matchId: finishedMatch, endedAt: Date.now(), winner: 'Alice',
  }))
  await addReplay(f, finishedMatch, completedGame, ['Alice', 'Bob'])
  await addReplay(f, abandonedMatch, abandonedGame, ['Alice', 'Bob'])
  const abandonedFile = join(f.replayDirectory, abandonedGame + '.json')
  const { readFile } = await import('node:fs/promises')
  const abandoned = JSON.parse(await readFile(abandonedFile, 'utf8'))
  abandoned.result = null
  abandoned.winner = null
  await writeFile(abandonedFile, JSON.stringify(abandoned))

  await f.product.archiveGames({ markInterrupted: true })
  async function matches() {
    const response = await f.path('/api/playtesting/matches', { headers: alice })
    assert.equal(response.status, 200)
    return (await response.json()).matches
  }
  let history = await matches()
  assert.equal(history.find(match => match.id === finishedMatch)?.status, 'completed')
  assert.equal(history.find(match => match.id === abandonedMatch)?.status, 'interrupted')
  await f.product.archiveGames()
  await f.product.archiveGames()
  history = await matches()
  const finished = history.find(match => match.id === finishedMatch)
  assert.equal(finished.status, 'completed')
  assert.equal(finished.games[0].archiveState, 'ready')
  const interrupted = history.find(match => match.id === abandonedMatch)
  assert.equal(interrupted.status, 'interrupted')
  assert.equal(interrupted.games[0].status, 'abandoned')
  assert.equal(interrupted.games[0].archiveState, 'partial')
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
  const response = await f.path(exportRoute, json('POST', alice, { gameIds: [game1, game2], mode: 'handle' }))
  assert.equal(response.status, 201)
  const { path } = await response.json()
  assert.equal((await f.path(path, { headers: alice })).status, 200)
  assert.equal((await f.path(path, { headers: bob })).status, 404)
})

test('[PM-AC-12] grouped stats use finalized games and the requesting player’s deck rather than a global view', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  const carol = await signIn(f, 'Carol')
  await signIn(f, 'Bob')
  const match = randomUUID()
  const first = randomUUID()
  const second = randomUUID()
  await addReplay(f, match, first, ['Alice', 'Bob'])
  await addReplay(f, match, second, ['Bob', 'Alice'])
  for (const [gameId, mulligans] of [[first, 0], [second, 2]]) {
    const file = join(f.replayDirectory, gameId + '.json')
    const { readFile } = await import('node:fs/promises')
    const info = JSON.parse(await readFile(file, 'utf8'))
    info.startPlayer = 'Alice'
    info.players.find(seat => seat.name === 'Alice').mulligans = mulligans
    await writeFile(file, JSON.stringify(info))
  }
  await f.product.archiveGames()
  let response = await f.path('/api/playtesting/stats?format=Pioneer', { headers: alice })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { groups: [] })
  await writeFile(join(f.replayDirectory, match + '.match.json'), JSON.stringify({ matchId: match, endedAt: Date.now(), winner: 'Alice' }))
  await f.product.archiveGames()
  response = await f.path('/api/playtesting/stats?format=Pioneer', { headers: alice })
  const { groups: [group] } = await response.json()
  assert.equal(group.games, 2)
  assert.equal(group.wins, 1)
  assert.equal(group.onPlay, 2)
  assert.equal(group.onDraw, 0)
  assert.equal(group.averageMulligans, 1)
  assert.equal(group.averageTurns, 4)
  assert.doesNotMatch(JSON.stringify(group), /private:Bob/)
  assert.deepEqual(await (await f.path('/api/playtesting/stats', { headers: carol })).json(), { groups: [] })
})
