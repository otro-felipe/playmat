// Run only in a disposable, network-isolated XMage namespace with its own local PostgreSQL.
// XMage writes replay staging files in /fixture-replays (mounted read-only here).
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, copyFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { Pool } from 'pg'
import { createProduct } from './product.mjs'
import { digest, ensureOAuthAgent } from './identity.mjs'
import { transaction } from './decks.mjs'
import { createMcpServer } from '../mcp/src/server.mjs'
import { PlaymatEngineSeat } from '../mcp/src/engine-seat.mjs'
import { createProductClient } from '../mcp/src/product.mjs'
import { fixtureMcpFetch } from './fixture-mcp-fetch.mjs'

const requireMcp = createRequire(new URL('../mcp/package.json', import.meta.url))
const { Client } = requireMcp('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = requireMcp('@modelcontextprotocol/sdk/client/streamableHttp.js')
async function until(read, label, timeout = 35_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const ready = await read()
    if (ready) return ready
    await sleep(250)
  }
  assert.fail('Timed out waiting for ' + label)
}

test(
  'two owners pilot eight real XMage seats through three Swiss rounds over MCP',
  {
    skip: process.env.PLAYMAT_LOCAL_TOURNAMENT_FIXTURE !== '1',
    timeout: 250_000,
  },
  async (t) => {
    const schema = 'test_cup_' + randomUUID().replaceAll('-', '')
    const databaseUrl = 'postgresql://postgres@127.0.0.1:5432/postgres'
    const publicUrl = 'https://tournament-fixture.invalid'
    const stage = await mkdtemp(join(tmpdir(), 'cup-replays-'))
    const product = await createProduct({
      databaseUrl,
      schema,
      publicUrl,
      insecureCookie: true,
      replayDirectory: stage,
      store: new Map(),
    })
    const pool = new Pool({ connectionString: databaseUrl, options: '-c search_path=' + schema })
    const root = 'http://127.0.0.1:8790',
      cupPath = '/api/playtesting/tournaments'
    const productClient = createProductClient(root, publicUrl)
    const engines = new Map()
    const mcp = createMcpServer({
      authorize: productClient.authorize,
      product: productClient.operation,
      createEngine: (actor) => {
        const engine = new PlaymatEngineSeat({
          ...actor,
          engineUrl: 'ws://127.0.0.1:17172/ws',
          trustedHeader: 'X-Playmat-User',
          managedPriorityStops: true,
        })
        engines.set(actor.playerId, engine)
        return engine
      },
    })
    let clients = []
    t.after(async () => {
      await Promise.allSettled(clients.map((c) => c.close()))
      mcp.closeAllConnections()
      mcp.close()
      await product.stopTournaments()
      product.server.closeAllConnections()
      product.server.close()
      await pool.end()
      await product.dropTestSchema()
      await product.close()
      await rm(stage, { recursive: true, force: true })
    })
    product.server.listen(8790, '127.0.0.1')
    await once(product.server, 'listening')
    mcp.listen(0, '127.0.0.1')
    await once(mcp, 'listening')
    const mcpUrl = new URL('http://127.0.0.1:' + mcp.address().port + '/mcp')

    const owners = []
    async function browser(path, owner, method = 'GET', body) {
      const response = await fetch(root + path, {
        method,
        headers: { cookie: owner?.cookie ?? '', 'content-type': 'application/json' },
        ...(body && { body: JSON.stringify(body) }),
      })
      const data = await response.json()
      assert.ok(response.ok, method + ' ' + path + ' returned ' + response.status + ' ' + (data.error ?? ''))
      return data
    }
    for (let i = 0; i < 2; i++) {
      const username = ['Cobre', 'Ambar'][i],
        password = randomBytes(24).toString('base64url')
      const id = await product.provisionHuman(username, password)
      const login = await fetch(root + '/login', {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username, password }),
      })
      assert.equal(login.status, 303)
      const connection = randomUUID(),
        token = randomBytes(32).toString('base64url')
      await transaction(pool, async (db) => {
        const key = await ensureOAuthAgent(db, id)
        await db.query(
          `INSERT INTO oauth_connections(id,account_id,engine_key,client_id,audience,scopes_approved,refresh_digest,expires_at)
        VALUES($1,$2,$3,'isolated-cup',$4,'{play,library,chat}',$5,now()+interval '1 day')`,
          [connection, id, key, publicUrl + '/mcp', digest(randomUUID())],
        )
        await db.query(
          "INSERT INTO oauth_access_tokens(digest,connection_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
          [digest(token), connection],
        )
      })
      owners.push({ id, token, cookie: login.headers.get('set-cookie').split(';')[0] })
    }
    await product.setTournamentAdmins(owners.map((o) => o.id))
    const cup = await browser(cupPath, owners[0], 'POST', {
      name: 'Local eight-seat Swiss',
      format: 'Standard',
      template: 'attendance',
      capacity: 8,
      cut: 'none',
      swissRounds: 3,
      breakMinutes: 1,
      coaching: true,
    })
    const eventPath = cupPath + '/' + cup.id,
      seats = []
    async function connect(owner) {
      const client = new Client({ name: 'synthetic-cup-pilot', version: '1' })
      await client.connect(
        new StreamableHTTPClientTransport(mcpUrl, {
          fetch: fixtureMcpFetch,
          requestInit: { headers: { authorization: 'Bearer ' + owner.token } },
        }),
      )
      clients.push(client)
      return client
    }
    async function call(seat, name, args = {}) {
      const result = await seat.client.callTool({ name, arguments: { playerId: seat.playerId, ...args } })
      const data = JSON.parse(result.content[0].text)
      assert.notEqual(result.isError, true, name + ' returned ' + (data.code ?? 'error') + ' ' + (data.message ?? ''))
      return data
    }
    for (let i = 0; i < 8; i++) {
      const owner = owners[i % 2],
        player = await browser('/api/playtesting/players', owner, 'POST', {
          displayName: ['Luna', 'Neptuno', 'Cometa', 'Aurora', 'Cosmos', 'Venus', 'Saturno', 'Vega'][i],
          mcpEnabled: true,
        })
      const deckId = 'fixture-' + i
      await browser('/api/playtesting/decks/' + deckId, owner, 'PUT', {
        library: 'private',
        playerId: player.playerId,
        expectedRevision: 0,
        name: 'Fixture deck',
        format: 'Standard',
        data: { name: 'Fixture deck', format: 'Standard', cards: [{ cardName: 'Forest', amount: 60 }], sideboard: [] },
      })
      const seat = { owner, playerId: player.playerId, deckId, client: await connect(owner) }
      await call(seat, 'join_tournament', { tournamentId: cup.id, deckId })
      seats.push(seat)
    }
    const wait = (seat) => call(seat, 'wait_for_next_round', { tournamentId: cup.id, waitMs: 0 })
    await Promise.all(seats.map(wait))
    await browser(eventPath + '/admin', owners[0], 'POST', { action: 'start' })
    product.startTournaments()
    // Copy only this fixture's finished engine files to private staging, leaving the shared mount intact.
    const copied = new Set()
    async function ingest() {
      const { rows } = await pool.query(
        'SELECT table_id FROM tournament_pairings WHERE tournament_id=$1 AND table_id IS NOT NULL',
        [cup.id],
      )
      const tables = new Set(rows.map((r) => r.table_id))
      for (const name of await readdir('/fixture-replays')) {
        if (!/^[a-f0-9-]{36}(\.match)?\.json$/.test(name) || copied.has(name)) continue
        const raw = JSON.parse(await readFile(join('/fixture-replays', name), 'utf8'))
        if (!tables.has(raw.tableId ?? raw.tournamentScore?.tableId)) continue
        if (!name.endsWith('.match.json'))
          await copyFile(
            join('/fixture-replays', name.replace('.json', '.ndjson.gz')),
            join(stage, name.replace('.json', '.ndjson.gz')),
          )
        await copyFile(join('/fixture-replays', name), join(stage, name))
        copied.add(name)
      }
      await product.archiveGames()
    }
    const usedTables = new Set(),
      usedGames = new Set()
    for (let round = 1; round <= 3; round++) {
      const detail = await until(async () => {
        const view = await browser(eventPath)
        const pairs = view.pairings.filter((p) => p.roundNumber === round)
        return pairs.length === 4 && pairs.every((p) => p.tableId) && view
      }, 'all four tables of round ' + round)
      const assignments = await Promise.all(seats.map(wait))
      const tables = detail.pairings.filter((p) => p.roundNumber === round)
      assert.equal(new Set(assignments.map((a) => a.tableId)).size, 4)
      for (const table of tables) {
        assert.ok(!usedTables.has(table.tableId))
        usedTables.add(table.tableId)
      }
      console.log('Round', round, 'all eight MCP seats received unique pair assignments')
      // Synthetic games reach real MCP decisions, sideboarding and normal BO3 completion.
      await Promise.all(
        tables.map(async (table) => {
          const participants = [table.a, table.b].map((id) => {
            const entry = detail.participants.find((e) => e.id === id)
            return seats.find((s) => s.playerId === entry.playerId)
          })
          for (let gameNumber = 1; gameNumber <= 2; gameNumber++) {
            const gameId = await until(
              () => {
                const states = participants.map((s) => engines.get(s.playerId)?.snapshot())
                const id = states[0]?.gameId
                return (
                  id &&
                  !usedGames.has(id) &&
                  states.every((s) => s?.gameId === id && s.status === 'active') &&
                  states.some((s) => s.decision?.choices?.length) &&
                  id
                )
              },
              'first decision for game ' + gameNumber + ' at round ' + round + ' table ' + table.number,
            )
            usedGames.add(gameId)
            const state = await call(participants[1], 'get_game_state', { gameId })
            assert.equal(state.gameId, gameId)
            await call(participants[1], 'concede', { gameId, entireMatch: false })
            if (gameNumber === 1) {
              await until(
                () => participants.every((s) => engines.get(s.playerId)?.snapshot().sideboard),
                'both sideboard prompts',
              )
              await Promise.all(
                participants.map(async (seat) => {
                  const side = await call(seat, 'get_sideboard_state')
                  assert.equal(side.deck.cards.reduce((n, card) => n + card.amount, 0), 60)
                  assert.ok(side.deck.cards.every((card) => card.cardName === 'Forest'))
                  await call(seat, 'submit_sideboard', { deck: side.deck, decisionId: side.decisionId })
                }),
              )
            }
          }
        }),
      )
      const final = await until(async () => {
        await ingest()
        const detail = await browser(eventPath)
        return ['finished', 'break'].includes(detail.status) && detail
      }, 'recorded match results for round ' + round)
      console.log('Round', round, 'all four real XMage completions archived')
      if (round === 1) {
        await browser(eventPath + '/admin', owners[1], 'POST', { action: 'extend', minutes: 1 })
        await browser(eventPath + '/admin', owners[0], 'POST', {
          action: 'pause',
          nextSessionAt: Date.now() + 24 * 3600_000,
        })
        for (const seat of seats) {
          const deleted = await browser('/api/playtesting/decks/' + seat.deckId, seat.owner, 'DELETE', {
            expectedRevision: 1,
          })
          assert.equal(deleted.deleted, true)
        }
        // Remove these fixture-only source card rows as well, exercising independent tournament snapshots.
        const purged = await pool.query('DELETE FROM deck_revision_cards WHERE deck_id=ANY($1::text[])', [
          seats.map((s) => s.deckId),
        ])
        assert.equal(purged.rowCount, seats.length)
        await Promise.all(clients.map((c) => c.close()))
        clients = []
        for (const seat of seats) seat.client = await connect(seat.owner)
        const receipts = await Promise.all(seats.map(wait))
        assert.ok(receipts.every((r) => r.state === 'paused' && r.tableId === null))
        await browser(eventPath + '/admin', owners[0], 'POST', { action: 'resume' })
      } else if (round === 2) {
        // A one-minute configured intermission exercises the real automatic scheduler.
        await until(async () => (await browser(eventPath)).roundNumber === 3, 'automatic round 3', 75_000)
      } else {
        assert.equal(final.status, 'finished')
        assert.equal(final.deckLists.length, 8)
        assert.equal(final.pairings.length, 12)
        assert.equal(final.standings[0].points, 9)
        assert.equal(final.championId, final.standings[0].id)
        const champion = final.standings[0],
          entryById = new Map(final.standings.map((p) => [p.id, p]))
        const result = await call(seats[0], 'get_tournament', {
          tournamentId: cup.id,
          section: 'deck',
          entryId: champion.id,
        })
        assert.equal(result.deck.cards[0].cardName, 'Forest')
        const path = final.pairings
          .filter((m) => [m.a, m.b].includes(champion.id))
          .map((m) => {
            const opponent = entryById.get(m.a === champion.id ? m.b : m.a)
            return { round: m.roundNumber, opponent: opponent.name, owner: opponent.owner, score: [m.winsA, m.winsB] }
          })
        console.log(
          'Public fixture result',
          JSON.stringify({
            champion: champion.name,
            owner: champion.owner,
            points: champion.points,
            path,
            sameOwnerMatches: final.pairings.filter((m) => entryById.get(m.a).owner === entryById.get(m.b).owner)
              .length,
          }),
        )
        assert.ok((await browser(eventPath + '/pairings/' + final.pairings[0].id + '/replay')).games.length > 0)
      }
    }
  },
)
