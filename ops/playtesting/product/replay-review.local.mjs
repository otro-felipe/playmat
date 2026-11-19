import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { createMcpServer } from '../mcp/src/server.mjs'
import { createProductClient } from '../mcp/src/product.mjs'
import { createProduct } from './product.mjs'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}`
}

export async function verifyReplayReviewOverMcp({ capture, humanCapture, Client, StreamableHTTPClientTransport, token }) {
  if (process.env.PLAYMAT_SEQUENCE_LOCAL_TEST !== 'yes'
    || !process.env.DATABASE_URL?.includes('@playmat-sequence-pg:5432/sequence_fixture')) {
    throw Error('Review acceptance requires the isolated engine and database')
  }
  // Use the product's real archive worker with a synthetic object store. The
  // isolated application has no S3 configured and leaves its staged replays
  // intact. The production entry point never enables this in-memory store.
  const product = await createProduct({
    databaseUrl: process.env.DATABASE_URL, replayDirectory: '/opt/xmage/saved/replays', store: new Map(),
  })
  let mcp
  let client
  try {
    const productUrl = await listen(product.server)
    const transport = createProductClient(productUrl)
    mcp = createMcpServer({
      authorize: transport.authorize, product: transport.operation,
      createEngine: () => assert.fail('Review tools cannot open an engine seat'),
    })
    const mcpUrl = await listen(mcp)
    client = new Client({ name: 'isolated-replay-review-fixture', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', mcpUrl), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    }))
    const { tools } = await client.listTools()
    for (const name of ['get_match_review', 'read_review_evidence', 'list_review_annotations', 'save_review_annotations']) {
      assert.ok(tools.some(tool => tool.name === name), 'Native tool absent: ' + name)
    }
    async function call(name, args, error) {
      const result = await client.callTool({ name, arguments: args })
      const data = JSON.parse(result.content[0].text)
      if (error) {
        assert.equal(result.isError, true, name)
        assert.equal(data.code, error)
      } else assert.notEqual(result.isError, true, name + ' ' + (data.code ?? ''))
      return data
    }
    async function completed(gameId) {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        await product.archiveGames()
        const result = await call('get_match_review', { gameId })
        if (result.status === 'completed' && result.archiveRevision) return result
        await sleep(40)
      }
      assert.fail('The isolate must archive a completed game before review')
    }
    const game = await completed(capture.gameId)
    const { gameId, archiveRevision, viewerSeatId } = game
    assert.equal(game.fullAvailable, true)
    assert.equal(game.coverage.version, 2)
    const peer = game.availablePerspectives.find(seat => seat.playerId === capture.rivalId)
    assert.ok(peer)
    const drawArgs = { gameId, archiveRevision, purpose: 'replay', cursor: capture.rivalDrawCursor, count: 1 }
    const own = await call('read_review_evidence', { ...drawArgs, scope: 'seat' })
    const alternate = await call('read_review_evidence', { ...drawArgs, scope: 'seat', seatId: peer.seatId })
    const full = await call('read_review_evidence', { ...drawArgs, scope: 'full' })
    assert.equal(own.events[0].type, 'draw')
    assert.equal(own.events[0].card, undefined)
    assert.equal(alternate.events[0].card?.name, 'Mountain')
    assert.deepEqual(full.events[0].card, alternate.events[0].card)
    assert.equal(own.events[0].cursor, full.events[0].cursor)
    await call('read_review_evidence', { ...drawArgs, scope: 'seat', seatId: 'mismatched-seat' }, 'forbidden')

    const evidence = await call('read_review_evidence', {
      gameId, archiveRevision, purpose: 'analysis', scope: 'seat', cursor: capture.castCursor, count: 1,
    })
    const [recordedCast] = evidence.events
    assert.equal(recordedCast.cursor, capture.castCursor)
    assert.equal(recordedCast.actual.card, capture.cardName)
    assert.deepEqual(recordedCast.actual.targetIds, [capture.rivalId])
    assert.equal(recordedCast.actual.cardRef.name, capture.cardName)
    assert.deepEqual(recordedCast.actual.targets, [{ id: capture.rivalId, name: peer.name, kind: 'player' }])
    assert.deepEqual(recordedCast.actual.paidMana, { R: 1 })
    assert.ok(recordedCast.frameCursor < recordedCast.cursor)
    assert.ok(recordedCast.before.view)
    const annotation = { cursor: recordedCast.cursor, seatId: viewerSeatId, confidence: 'medium', assessment: 'acceptable',
      rationale: 'The observed spell spends available red mana on the announced target.',
      benefit: 'Applies pressure before the next turn.',
      risk: 'Commits a source and an interaction spell.' }
    const command = { gameId, archiveRevision, entries: [annotation] }
    const saved = await call('save_review_annotations', command)
    const retry = await call('save_review_annotations', command)
    assert.equal(saved.annotations[0].revision, retry.annotations[0].revision)
    assert.equal(saved.annotations[0].frameCursor, recordedCast.frameCursor)
    const coalesced = recordedCast.evidence.frameQuality === 'coalesced_snapshot'
    const expectedCategory = coalesced ? 'insufficient' : 'acceptable'
    assert.equal(saved.annotations[0].confidence, coalesced ? 'low' : 'medium')
    assert.equal(saved.annotations[0].category, expectedCategory)
    const loaded = await call('list_review_annotations', { gameId, cursor: capture.castCursor, count: 1 })
    assert.deepEqual(loaded.annotations, saved.annotations)
    const encounter = await call('get_match_review', { matchId: capture.matchId })
    assert.equal(encounter.analysis.reviewed, 1)
    assert.equal(encounter.analysis.counts[expectedCategory], 1)

    const browserMatch = await completed(humanCapture.gameId)
    assert.equal(browserMatch.fullAvailable, true)
    const browserEvidence = await call('read_review_evidence', {
      gameId: humanCapture.gameId, purpose: 'replay', scope: 'full', count: 40,
    })
    assert.ok(browserEvidence.events.some(row => Object.keys(row.hands ?? {}).length === 2))
    console.log(JSON.stringify({ phase: '[PM-REVIEW-API-1/2/3/4] real Java native archive review',
      version: client.getServerVersion()?.version, exactCast: true, ownPeerAndFull: true, automaticBrowserCapture: true, retryCount: 1 }))
  } finally {
    await client?.close()
    mcp?.closeAllConnections()
    mcp?.close()
    product.server.closeAllConnections()
    product.server.close()
    await product.close()
  }
}
