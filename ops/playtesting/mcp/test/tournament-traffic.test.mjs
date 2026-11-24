import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createMcpServer } from '../src/server.mjs'

async function start(t, config, onRequest) {
  const server = createMcpServer(config).listen(0, '127.0.0.1')
  if (onRequest) server.prependListener('request', onRequest)
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  return new URL('http://127.0.0.1:' + server.address().port + '/mcp')
}

function request(url, { token = 'owner', ip, method = 'POST', body, signal } = {}) {
  const headers = {
    authorization: 'Bearer ' + token,
    accept: method === 'GET' ? 'text/event-stream' : 'application/json, text/event-stream',
  }
  if (ip) headers['x-playmat-client-ip'] = ip
  if (method === 'POST') headers['content-type'] = 'application/json'
  return fetch(url, {
    method,
    headers,
    signal,
    ...(method === 'POST' && { body: JSON.stringify(body ?? { jsonrpc: '2.0', id: 1, method: 'ping' }) }),
  })
}

async function limited(response, reason) {
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('x-playmat-limit-reason'), reason)
  assert.ok(Number(response.headers.get('retry-after')) > 0)
  assert.equal((await response.json()).error.code, -32029)
}

test(
  'eight independent MCP pilots and their organizer share one account through check-in, polling and paired tables',
  { timeout: 15000 },
  async (t) => {
    const ids = Array.from({ length: 8 }, () => randomUUID()),
      tables = Array.from({ length: 4 }, () => randomUUID())
    const tournamentId = randomUUID(),
      ownerId = randomUUID(),
      otherId = randomUUID(),
      connectionId = randomUUID()
    const players = new Map(
      ids.map((id, i) => [id, { id, table: tables[Math.floor(i / 2)], polls: 0, confirmed: 0 }]),
    )
    const firstCheckIns = Promise.withResolvers(),
      readingBoard = Promise.withResolvers(),
      finishBoard = Promise.withResolvers()
    const disconnected = Promise.withResolvers()
    let assigned = false
    const url = await start(
      t,
      {
        authorize: async (token, selector) => {
          const owner = {
            accountId: token === 'other' ? otherId : ownerId,
            engineName: 'Organizer',
            connectionId,
            scopes: ['play'],
            playerSelectionEnabled: true,
          }
          const id = token.startsWith('pilot') ? ids[Number(token.slice(5))] : selector
          return id && players.has(id)
            ? { ...owner, playerId: id, engineName: id, playerSelectionEnabled: false, ownsReservation: true }
            : owner
        },
        createEngine: (actor) => ({
          profileId: actor.playerId,
          open: async () => {},
          acceptTournamentTable: (id) => assert.equal(id, players.get(actor.playerId).table),
          matchesPlayerGrant: () => true,
        }),
        product: async (token, name, args, selector) => {
          if (name === 'get_tournament') {
            if (token === 'owner') {
              readingBoard.resolve()
              await finishBoard.promise
            }
            return { status: 'playing', standings: [], pairings: [] }
          }
          assert.equal(name, 'wait_for_next_round')
          const player = players.get(selector)
          if (args.readyTableId) {
            assert.equal(args.readyTableId, player.table)
            player.confirmed++
          } else player.polls++
          if ([...players.values()].every((p) => p.polls)) firstCheckIns.resolve()
          return assigned ? { state: 'table', tableId: player.table } : { state: 'waiting' }
        },
      },
      (req, res) => {
        if (req.method === 'GET')
          res.once('close', () => {
            if (res.statusCode === 200) disconnected.resolve()
          })
      },
    )
    const clients = []
    t.after(async () => Promise.all(clients.map((client) => client.close())))
    for (let i = 0; i < 9; i++) {
      const client = new Client({ name: 'fixture-' + i, version: '1' })
      clients.push(client)
      const opened = Promise.withResolvers()
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: 'Bearer ' + (i < 4 ? 'pilot' + i : 'owner') } },
        fetch: async (input, init) => {
          const res = await fetch(input, init)
          if (init.method === 'GET') opened.resolve(res.status)
          return res
        },
      })
      await client.connect(transport)
      assert.equal(await opened.promise, 200)
    }
    const waits = Promise.all(
      clients.slice(0, 8).map((client, i) =>
        client.callTool({
          name: 'wait_for_next_round',
          arguments: { tournamentId, playerId: ids[i], waitMs: 8000 },
        }),
      ),
    )
    let board
    try {
      await Promise.race([
        firstCheckIns.promise,
        waits.then(() => assert.fail('Pilots left before assignments')),
      ])
      board = clients[8].callTool({
        name: 'get_tournament',
        arguments: { tournamentId, section: 'standings' },
      })
      await Promise.race([
        readingBoard.promise,
        board.then(() => assert.fail('Organizer did not reach the product')),
      ])
      await limited(await request(url), 'operation-concurrency')
      await limited(await request(url, { method: 'GET' }), 'stream-concurrency')
      assert.equal((await request(url, { token: 'other' })).status, 200)
    } finally {
      finishBoard.resolve()
      assigned = true
      await Promise.allSettled([waits, board])
    }
    assert.ok(!(await board).isError)
    for (const [i, reply] of (await waits).entries()) {
      assert.equal(JSON.parse(reply.content[0].text).tableId, tables[Math.floor(i / 2)])
      assert.equal(players.get(ids[i]).confirmed, 1)
      assert.ok(players.get(ids[i]).polls >= 2)
    }
    assert.equal((await request(url)).status, 200)
    await clients.pop().close()
    await disconnected.promise
    const abort = new AbortController()
    try {
      assert.equal((await request(url, { method: 'GET', signal: abort.signal })).status, 200)
    } finally {
      abort.abort()
    }
  },
)

test(
  'authentication allows sixteen from one source and thirty-two globally, then releases capacity',
  { timeout: 8000 },
  async (t) => {
    const begun = Promise.withResolvers(),
      allBegun = Promise.withResolvers(),
      complete = Promise.withResolvers()
    let inFlight = 0
    const url = await start(t, {
      authorize: async (token) => {
        if (++inFlight === 16) begun.resolve()
        if (inFlight === 32) allBegun.resolve()
        await complete.promise
        return { accountId: token, engineName: 'Fixture', scopes: ['play'] }
      },
    })
    // Distinct accounts behind one source, so only authentication admission is measured.
    const pending = Array.from({ length: 16 }, (_, i) => request(url, { token: 'colocated' + i }))
    try {
      await Promise.race([
        begun.promise,
        ...pending.map(async (r) => assert.fail('Authentication ended early with HTTP ' + (await r).status)),
      ])
      await limited(await request(url), 'auth-concurrency')
      const others = Array.from({ length: 16 }, (_, i) => {
        const group = Math.floor(i / 8)
        return request(url, { token: 'owner' + group, ip: '192.0.2.' + (group + 1) })
      })
      pending.push(...others)
      await Promise.race([
        allBegun.promise,
        ...others.map(async (r) => assert.fail('Authentication ended early with HTTP ' + (await r).status)),
      ])
      await limited(await request(url, { token: 'another', ip: '192.0.2.10' }), 'auth-concurrency')
    } finally {
      complete.resolve()
      await Promise.allSettled(pending)
    }
    assert.ok((await Promise.all(pending)).every((r) => r.status === 200))
    assert.equal((await request(url)).status, 200)
  },
)

test(
  'idle event streams leave operation capacity and combined admission stays bounded across accounts',
  { timeout: 10000 },
  async (t) => {
    const enough = Array.from({ length: 3 }, () => Promise.withResolvers())
    const finish = Promise.withResolvers(),
      streamClosed = Promise.withResolvers()
    const tournamentId = randomUUID()
    let running = 0
    const url = await start(
      t,
      {
        authorize: async (token) => ({ accountId: token, engineName: 'Fixture', scopes: ['play'] }),
        product: async () => {
          running++
          if (running % 8 === 0) enough[running / 8 - 1].resolve()
          await finish.promise
          return { standings: [] }
        },
      },
      (req, res) => {
        if (req.method === 'GET')
          res.once('close', () => {
            if (res.statusCode === 200) streamClosed.resolve()
          })
      },
    )
    const streams = [],
      ops = []
    try {
      // Undici cancels an unconsumed body when its Response is garbage-collected.
      // Keep each spectator response until the test explicitly disconnects it.
      for (let i = 0; i < 24; i++) {
        const response = await request(url, { token: 'reader' + Math.floor(i / 8), method: 'GET' })
        streams.push(response)
        assert.equal(response.status, 200)
      }
      await limited(await request(url, { token: 'another-reader', method: 'GET' }), 'stream-concurrency')
      assert.equal((await request(url, { token: 'organizer' })).status, 200)
      for (let group = 0; group < 3; group++) {
        const batch = Array.from({ length: 8 }, () =>
          request(url, {
            token: 'owner' + group,
            body: {
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: 'get_tournament', arguments: { tournamentId } },
            },
          }),
        )
        ops.push(...batch)
        await Promise.race([
          enough[group].promise,
          ...batch.map(async (req) => assert.fail('Operation ended early with HTTP ' + (await req).status)),
        ])
      }
      await limited(await request(url, { token: 'organizer' }), 'global-concurrency')
      await streams.pop().body.cancel()
      await streamClosed.promise
      assert.equal((await request(url, { token: 'organizer' })).status, 200)
    } finally {
      finish.resolve()
      await Promise.allSettled([...streams.map(stream => stream.body.cancel()), ...ops])
    }
    assert.ok((await Promise.all(ops)).every((res) => res.status === 200))
  },
)

test(
  'a rate-exempt administrator account passes per-account caps and rate while instance totals still apply',
  { timeout: 20000 },
  async (t) => {
    const reached = Promise.withResolvers(),
      finish = Promise.withResolvers()
    const tournamentId = randomUUID()
    let running = 0
    const url = await start(t, {
      authorize: async (token) => ({
        accountId: token,
        engineName: 'Fixture',
        scopes: ['play'],
        ...(token === 'admin' && { rateExempt: true }),
      }),
      product: async () => {
        if (++running === 16) reached.resolve()
        await finish.promise
        return { standings: [] }
      },
    })
    const streams = [],
      ops = []
    try {
      // Sixteen colocated pilots on one administrator account: streams and operations above nine.
      for (let i = 0; i < 16; i++) {
        const response = await request(url, { token: 'admin', method: 'GET' })
        streams.push(response)
        assert.equal(response.status, 200)
      }
      for (let i = 0; i < 16; i++)
        ops.push(
          request(url, {
            token: 'admin',
            body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_tournament', arguments: { tournamentId } } },
          }),
        )
      await Promise.race([
        reached.promise,
        ...ops.map(async (req) => assert.fail('Operation ended early with HTTP ' + (await req).status)),
      ])
      // An ordinary account keeps its per-account caps (eight streams still fit the instance total of 24).
      for (let i = 0; i < 8; i++) {
        const response = await request(url, { token: 'owner', method: 'GET' })
        streams.push(response)
        assert.equal(response.status, 200)
      }
      await limited(await request(url, { token: 'owner', method: 'GET' }), 'stream-concurrency')
    } finally {
      finish.resolve()
      await Promise.allSettled([...streams.map((stream) => stream.body.cancel()), ...ops])
    }
    assert.ok((await Promise.all(ops)).every((res) => res.status === 200))

    // Per-account rate: an ordinary account stops after its minute budget; the administrator does not.
    async function burst(token, count) {
      const statuses = []
      for (let i = 0; i < count; i += 50) {
        const batch = await Promise.all(
          Array.from({ length: Math.min(50, count - i) }, () => request(url, { token, ip: '198.51.100.' + (token === 'admin' ? 1 : 2) })),
        )
        for (const res of batch) {
          statuses.push(res.status === 429 ? res.headers.get('x-playmat-limit-reason') : res.status)
          await res.body?.cancel()
        }
      }
      return statuses
    }
    const owner = await burst('rate-owner', 650)
    assert.ok(owner.includes('account-rate'), 'ordinary account should reach its per-minute budget')
    const admin = await burst('admin', 650)
    assert.ok(admin.every((status) => status === 200), 'administrator should not be rate limited per account')
  },
)
