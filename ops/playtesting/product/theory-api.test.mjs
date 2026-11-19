import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { test } from 'node:test'
import pg from 'pg'
import { createProduct } from './product.mjs'

const databaseUrl = process.env.PLAYMAT_TEST_DATABASE_URL
const route = '/api/playtesting/theory'
const study = {
  seed: 21,
  trials: 12,
  horizon: 1,
  onPlay: true,
  cards: [{ id: 'Mountain', count: 30, land: { colors: ['R'] } }, { id: 'Bolt', count: 20, cost: { pips: ['R'], generic: 0 } }],
  policies: [{ id: 'default' }],
  queries: [{ key: 'presence', policy: 'default', expression: { has_card: { id: 'Bolt' } } }],
}

async function fixture(t) {
  const schema = 'test_' + randomUUID().replaceAll('-', '')
  const replayDirectory = await mkdtemp(join(tmpdir(), 'playmat-theory-api-'))
  const product = await createProduct({ databaseUrl, schema, replayDirectory, store: new Map(), insecureCookie: true })
  product.server.listen(0, '127.0.0.1')
  await once(product.server, 'listening')
  t.after(async () => {
    product.server.closeAllConnections()
    product.server.close()
    await product.dropTestSchema()
    await product.close()
    await rm(replayDirectory, { recursive: true, force: true })
  })
  await product.provisionHuman('TheoryOwner', 'synthetic-fixture-credential')
  await product.provisionHuman('TheoryOther', 'synthetic-fixture-credential')
  const [owner, other, playOnly] = await Promise.all([
    product.provisionAgent('TheoryOwner', 'TheoryAgentOne', ['history']),
    product.provisionAgent('TheoryOther', 'TheoryAgentTwo', ['history']),
    product.provisionAgent('TheoryOwner', 'TheoryAgentPlay', ['play']),
  ])
  const url = `http://127.0.0.1:${product.server.address().port}`
  const request = (path, token, data) => fetch(url + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
  return {
    owner, other, playOnly, product, replayDirectory, requestAbsolute: request,
    request: (path, token, data) => request(route + path, token, data),
    async db(work) {
      const database = new pg.Client({ connectionString: databaseUrl, options: '-c search_path=' + schema })
      await database.connect()
      try { return await work(database) } finally { await database.end() }
    },
  }
}

test('[PM-THEORY-6] HTTP persists aggregate results and exact retries for the authorized account only', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const requestId = randomUUID()
  assert.equal((await f.request('/studies', undefined, { study, requestId })).status, 401)
  assert.equal((await f.request('/studies', f.playOnly, { study, requestId })).status, 403)
  const results = await Promise.all(Array.from({ length: 2 }, () => f.request('/studies', f.owner, { study, requestId })))
  assert.deepEqual(results.map(({ status }) => status), [200, 200])
  const [first, retry] = await Promise.all(results.map(result => result.json()))
  assert.deepEqual(retry, first)
  assert.equal(first.result.results.presence.denominator, 12)
  assert.equal(first.result.seed, 21)
  assert.equal((await f.request('/studies', f.owner, { study: { ...study, seed: 22 }, requestId })).status, 409)
  assert.equal((await f.request(`/studies/${first.studyId}`, f.other)).status, 404)
  assert.equal((await f.request(`/studies/${first.studyId}`, f.playOnly)).status, 403)
  assert.deepEqual(await (await f.request(`/studies/${first.studyId}`, f.owner)).json(), first)
  const persisted = await f.db(async db => (await db.query('SELECT result FROM theory_studies')).rows)
  assert.deepEqual(persisted, [{ result: first.result }])
  assert.equal('cards' in persisted[0].result, false)
  assert.equal('samples' in persisted[0].result, false)
})

test('[PM-THEORY-5] HTTP scopes tactical conclusions to the caller’s model and budget', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const graph = {
    objective: 'lethal_this_turn', rootId: 'root', maxDepth: 2, budget: 4,
    nodes: { root: { kind: 'terminal', scored: true } },
  }
  assert.equal((await f.request('/tactics', f.playOnly, { graph })).status, 403)
  const response = await f.request('/tactics', f.owner, { graph })
  assert.equal(response.status, 200)
  const report = await response.json()
  assert.equal(report.verification, 'input_model')
  assert.equal(report.forcedInModel, true)
  assert.equal((await f.request('/tactics', f.owner, { graph: { ...graph, budget: 0 } })).status, 400)
  const combat = { attackers: [{ id: 'bear', power: 2 }], blockers: [], defendingLife: 2,
    completeLegalActions: true, completeReplies: true, budget: 100 }
  const combatResponse = await f.request('/tactics', f.owner, { combat })
  assert.equal(combatResponse.status, 200)
  const combatReport = await combatResponse.json()
  assert.equal(combatReport.objective, 'lethal_this_turn')
  assert.equal(combatReport.verification, 'ordinary_combat_model')
  assert.equal(combatReport.forcedLethalInModel, true)
  assert.equal((await f.request('/tactics', f.owner, { combat, graph })).status, 400)
  assert.equal((await f.request('/tactics', f.owner, { combat: { ...combat, attackers: [{ ...combat.attackers[0], trample: true }] } })).status, 400)
})

test('[PM-THEORY-6] links use a terminal game and the exact authorized pre-action frame', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const gameId = randomUUID()
  const matchId = randomUUID()
  const now = Date.now()
  const names = ['TheoryOwner', 'TheoryOther']
  const mountain = { name: 'Mountain', cardTypes: ['LAND'], tapped: true }
  const bolt = { name: 'Lightning Bolt', cardTypes: ['INSTANT'] }
  const view = {
    turn: 19, step: 'PRECOMBAT_MAIN', activePlayerName: names[0],
    players: [{ name: names[0], battlefield: { mountain } }, { name: names[1], battlefield: {} }],
  }
  const rows = [
    { t: 10, view, hands: { [names[0]]: { bolt }, [names[1]]: { hidden: { name: 'Opponent private card' } } } },
    { t: 11, log: { messageType: 'GAME', message: names[0] + ' casts Lightning Bolt' } },
    { t: 12, view, hands: { [names[0]]: { future: { name: 'Later own card' } } } },
  ]
  await writeFile(join(f.replayDirectory, gameId + '.json'), JSON.stringify({
    gameId, matchId, tableId: matchId, startedAt: now - 1000, endedAt: now, winner: names[0],
    deckType: 'Constructed - Pioneer', players: names.map(name => ({ name, human: true })),
  }))
  await writeFile(join(f.replayDirectory, gameId + '.ndjson.gz'), gzipSync(rows.map(row => JSON.stringify(row)).join('\n')))
  await f.product.archiveGames()
  const replay = '/api/playtesting/review/games/' + gameId
  const manifestResponse = await f.requestAbsolute(replay, f.owner)
  assert.equal(manifestResponse.status, 200)
  const manifest = await manifestResponse.json()
  const anchor = { gameId, archiveRevision: manifest.archiveRevision, cursor: 1, seatId: 'theoryowner' }
  const positioned = { ...study, horizon: 19,
    cards: [{ ...study.cards[0] }, { ...study.cards[1], name: 'Lightning Bolt' }],
    position: { turn: 19, hand: ['Bolt'], lands: [{ id: 'Mountain', tapped: true }] },
  }
  const save = (token, input = positioned, link = anchor) => f.request('/studies', token, { study: input, anchor: link })
  assert.equal((await save(f.owner)).status, 409)
  await writeFile(join(f.replayDirectory, matchId + '.match.json'), JSON.stringify({ matchId, endedAt: now }))
  await f.product.archiveGames()
  assert.equal((await save(f.other)).status, 200)
  assert.equal((await save(f.owner, positioned, { ...anchor, archiveRevision: '0'.repeat(64) })).status, 409)
  assert.equal((await save(f.owner, positioned, { ...anchor, cursor: 0 })).status, 404)
  assert.equal((await save(f.owner, { ...positioned, position: { ...positioned.position, hand: [] } })).status, 400)
  assert.equal((await save(f.owner, { ...positioned, position: { ...positioned.position, lands: [{ id: 'Mountain', tapped: false }] } })).status, 400)
  await f.product.provisionHuman('TheoryOutsider', 'synthetic-fixture-credential')
  const outsider = await f.product.provisionAgent('TheoryOutsider', 'TheoryAgentOutsider', ['history'])
  assert.equal((await save(outsider)).status, 404)
  const receipt = await save(f.owner)
  assert.equal(receipt.status, 200)
  const result = await receipt.json()
  assert.deepEqual(result.anchor, anchor)
  assert.equal(result.result.replayContext.basis, 'observed_frame')
  assert.equal(result.result.replayContext.frameQuality, 'preceding_snapshot')
  assert.doesNotMatch(JSON.stringify(result), /Lightning Bolt|Mountain|Opponent private card|Later own card/)
  assert.equal((await f.request('/studies/' + result.studyId, f.other)).status, 404)
  const illustrative = await (await save(f.owner, study)).json()
  assert.deepEqual(illustrative.result.replayContext, { basis: 'public_hypothesis', interpretation: 'illustrative' })

  const entry = { cursor: 1, seatId: anchor.seatId, confidence: 'medium', assessment: 'sound',
    rationale: 'A plausible development line.', benefit: 'Uses mana.', risk: 'Spends a card.', alternatives: [] }
  assert.equal((await f.requestAbsolute(replay + '/annotations', f.owner, { archiveRevision: anchor.archiveRevision, entries: [entry] })).status, 200)
  const annotations = await (await f.requestAbsolute(replay + '/annotations', f.owner)).json()
  assert.deepEqual(annotations.annotations[0].theoryStudies.map(({ studyId }) => studyId).sort(),
    [result.studyId, illustrative.studyId].sort())
  const otherAnnotations = await (await f.requestAbsolute(replay + '/annotations', f.other)).json()
  assert.equal(otherAnnotations.annotations.length, 1)
  assert.doesNotMatch(JSON.stringify(otherAnnotations), new RegExp(result.studyId))
  assert.doesNotMatch(JSON.stringify(otherAnnotations), new RegExp(illustrative.studyId))
  await f.db(db => db.query('UPDATE games SET checksum=$2 WHERE id=$1', [gameId, '0'.repeat(64)]))
  assert.equal((await f.request('/studies/' + result.studyId, f.owner)).status, 409)
})
