import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { createGzip } from 'node:zlib'
import { buffer } from 'node:stream/consumers'
import { createArchive } from './archive.mjs'
import { createTournamentBroadcast } from './tournament-broadcast.mjs'

test('retained long tournament replay supports index, concurrent seeks, terminal notes and revocation', async (t) => {
  const [event, pair, table, game, a, b] = Array.from({ length: 6 }, () => randomUUID())
  const players = [
    { name: 'a', playerId: a },
    { name: 'b', playerId: b },
  ]
  const padding = 'x'.repeat(256 * 1024)
  const count = 390
  const note = {
    kind: 'line',
    commandId: 'last',
    actorPlayerId: a,
    explanation: 'Cierro la partida.',
    audience: 'public',
    t: 81,
  }
  async function* records() {
    for (let index = 0; index < count; index++) {
      yield JSON.stringify({ t: index, view: { players, turn: index + 1 }, review: { ignored: padding } }) +
        '\n'
    }
    yield JSON.stringify(note) // A valid final NDJSON record can lack a trailing newline.
  }
  const body = await buffer(Readable.from(records()).pipe(createGzip({ level: 1 })))
  const gameRow = {
    id: game,
    object_key: 'fixture',
    checksum: createHash('sha256').update(body).digest('hex'),
    started_at: '1000',
  }
  const pairing = {
    id: pair,
    table_id: table,
    completed: true,
    name_a: 'a',
    name_b: 'b',
    display_a: 'Brasa',
    display_b: 'Cirro',
    player_a: a,
    player_b: b,
  }
  let retained = true
  let reads = 0
  const pool = {
    async query(sql) {
      return { rows: sql.includes('JOIN tournament_entries') ? [pairing] : retained ? [gameRow] : [] }
    },
  }
  const store = {
    async get() {
      reads++
      return body
    },
  }
  const broadcast = createTournamentBroadcast(pool, createArchive(pool, '', store))
  t.after(() => broadcast.close())
  const replay = (query = {}) => broadcast.replay(event, pair, null, new URLSearchParams(query))
  const [index, early] = await Promise.all([replay(), replay({ gameId: game, frame: 0 })])
  assert.equal(index.games[0].gameId, game)
  assert.equal(index.games[0].frameCount, count)
  assert.equal(early.view.turn, 1)
  assert.deepEqual(early.lines, [])
  const late = await replay({ gameId: game, frame: count - 1 })
  assert.equal(late.view.turn, count)
  assert.deepEqual(
    late.lines.map((n) => [n.playerId, n.explanation]),
    [[a, note.explanation]],
  )
  assert.equal(await replay({ gameId: game, frame: 156 }).then((f) => f.view.turn), 157)
  assert.equal(reads, 1)
  retained = false
  assert.deepEqual((await replay()).games, [])
  await assert.rejects(replay({ gameId: game, frame: 0 }), { status: 404 })
})

test('a failed streaming checksum leaves no published count or frame and a repair can be replayed', async (t) => {
  const [event, pair, table, game, a, b] = Array.from({ length: 6 }, () => randomUUID())
  const names = [
    { name: 'a', playerId: a },
    { name: 'b', playerId: b },
  ]
  const row = {
    id: pair,
    table_id: table,
    completed: true,
    name_a: 'a',
    name_b: 'b',
    display_a: 'Brasa',
    display_b: 'Cirro',
    player_a: a,
    player_b: b,
  }
  const source = Buffer.from(JSON.stringify({ view: { players: names, turn: 10 } }))
  const body = await buffer(Readable.from([source]).pipe(createGzip()))
  let stored = Buffer.from(body)
  const gameRow = {
    id: game,
    object_key: 'fixture',
    checksum: createHash('sha256').update(body).digest('hex'),
  }
  const pool = {
    async query(sql) {
      return { rows: [sql.includes('JOIN tournament_entries') ? row : gameRow] }
    },
  }
  const store = {
    async open() {
      return Readable.from([stored.subarray(0, 3), stored.subarray(3)])
    },
  }
  const broadcast = createTournamentBroadcast(pool, createArchive(pool, '', store))
  t.after(() => broadcast.close())
  const query = new URLSearchParams()
  // Another well-formed gzip with valid rows must still be rejected under the original digest.
  stored = await buffer(Readable.from([source, Buffer.from('\n')]).pipe(createGzip()))
  await assert.rejects(broadcast.replay(event, pair, null, query), { status: 503 })
  stored = body
  const repaired = await broadcast.replay(event, pair, null, query)
  assert.equal(repaired.games[0].gameId, game)
  assert.equal(repaired.games[0].frameCount, 1)
})

test('a disk-full fifth replay reclaims idle indexes and retries once while an active spectator keeps reading', async (t) => {
  const { open } = await import('node:fs/promises')
  const { tournamentReplayIndexes } = await import('./tournament-replay-index.mjs')
  const games = Array.from({ length: 6 }, () => ({ id: randomUUID(), checksum: 'synthetic' }))
  const builds = new Map()
  const cache = tournamentReplayIndexes({
    async *streamTournamentRecords(game) {
      const attempt = (builds.get(game) ?? 0) + 1
      builds.set(game, attempt)
      yield { view: { players: [{}, {}] }, gameId: game.id }
      yield { view: { players: [{}, {}] }, gameId: game.id }
    },
  })
  t.after(() => cache.close())
  const read = (game) => cache.read(game, (record, number) => ({ gameId: record.gameId, number }), false, 0)
  for (const game of games.slice(0, 4)) await read(game)

  // Force a real index write to fail after its first synthetic frame, and hold
  // a reader on an older index across reclamation.
  const fixture = await open('/dev/null', 'r')
  const proto = Object.getPrototypeOf(fixture)
  await fixture.close()
  const started = Promise.withResolvers(),
    resume = Promise.withResolvers()
  const nativeWrite = proto.writeFile
  t.mock.method(proto, 'writeFile', function (bytes, ...args) {
    const frame = JSON.parse(bytes.toString())
    if (
      frame.number === 1 &&
      ((frame.gameId === games[4].id && builds.get(games[4]) === 1) || frame.gameId === games[5].id)
    )
      throw Object.assign(new Error('Fixture disk is full'), { code: 'ENOSPC' })
    return nativeWrite.call(this, bytes, ...args)
  })
  const nativeRead = proto.read
  let holdNextRead = true
  t.mock.method(proto, 'read', async function (...args) {
    if (holdNextRead) {
      holdNextRead = false
      started.resolve()
      await resume.promise
    }
    return nativeRead.apply(this, args)
  })
  const active = read(games[0])
  await started.promise
  try {
    const [first, second] = await Promise.all([read(games[4]), read(games[4])])
    assert.deepEqual(first.board, { gameId: games[4].id, number: 0 })
    assert.deepEqual(second, first)
    assert.equal(builds.get(games[4]), 2)
  } finally {
    resume.resolve()
    assert.deepEqual((await active).board, { gameId: games[0].id, number: 0 })
  }
  await read(games[0])
  assert.equal(builds.get(games[0]), 1)
  await read(games[1])
  assert.equal(builds.get(games[1]), 2)
  await assert.rejects(read(games[5]), { code: 'ENOSPC' })
  assert.equal(builds.get(games[5]), 2)
  // All reclaimable indexes were already closed. A later request fails immediately.
  await assert.rejects(read(games[5]), { code: 'ENOSPC' })
  assert.equal(builds.get(games[5]), 3)
})
