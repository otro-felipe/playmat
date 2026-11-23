import { registeredDecklists } from './tournament-decklists.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { Pool } from 'pg'
import { readFile } from 'node:fs/promises'
import {
  createTournamentTableBridge,
  reconcileTournamentTable,
  restoreTournamentTable,
  storeTournamentScore,
} from './tournament-table-bridge.mjs'

const assignment = {
  tournamentId: 'cup',
  pairingId: 'pair',
  bestOf: 3,
  stage: 'swiss',
  format: 'Standard',
  playerA: { engineName: 'Luna' },
  playerB: { engineName: 'Sol' },
}

test('only a native waiting table with both presence bits advances presentation time', async (t) => {
  const tableId = randomUUID()
  let code = 200
  let native = { tableId, state: 'WAITING', seatAOnline: true, seatBOnline: false }
  const server = createServer((_req, res) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(native))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const events = []
  const bridge = createTournamentTableBridge({ query: async () => ({ rows: [] }) }, {
    closedTables: async () => [],
    pendingTables: async () => [{ ...assignment, tableId }],
    acceptTable: async () => events.push('present'),
    missTable: async () => events.push('absent'),
    observeWaitingTable: async () => events.push('observed'),
    suspendWaitingTable: async () => events.push('frozen'),
    markLaunched: async () => events.push('playing'),
  }, { engineUrl: 'http://127.0.0.1:' + server.address().port })
  await bridge.tick()
  assert.deepEqual(events.splice(0), ['present', 'absent', 'observed'])
  for (const invalid of [null, { tableId: null, state: 'WAITING' }, { tableId, state: 'WAITING' }, { tableId, state: 'UNKNOWN' }]) {
    native = invalid
    await bridge.tick()
    assert.deepEqual(events.splice(0), ['frozen'])
  }
  for (const state of ['DUELING', 'SIDEBOARDING', 'FINISHED']) {
    native = { tableId, state }
    await bridge.tick()
    assert.deepEqual(events.splice(0), ['frozen'])
  }
  native = { tableId, gameId: randomUUID(), gameStarted: true, state: 'DUELING' }
  await bridge.tick()
  assert.deepEqual(events.splice(0), ['playing'])
  code = 503
  await assert.rejects(bridge.tick(), /503/)
  assert.deepEqual(events, ['frozen'])
})

test('a prepared playoff table is bound before either player sees an engine game; repeated ticks reuse the binding', async () => {
  const calls = []
  const operations = {
    findResult: async () => null,
    prepare: async () => {
      calls.push('prepare')
      return { tableId: 'real-table' }
    },
    bind: async (table) => calls.push('bind ' + table),
    ready: async () => true,
    launch: async (table) => calls.push('launch ' + table),
  }
  await reconcileTournamentTable(assignment, operations)
  await reconcileTournamentTable({ ...assignment, tableId: 'real-table' }, operations)
  assert.deepEqual(calls, ['prepare', 'bind real-table', 'launch real-table'])
})

test('a closed engine match supplies the actual signed game score before any attempt to launch', async () => {
  const score = { winsA: 2, winsB: 1, draws: 1 }
  let reported
  await reconcileTournamentTable(
    { ...assignment, tableId: 'table' },
    {
      findResult: async () => score,
      report: async (value) => {
        reported = value
      },
      launch: () => assert.fail('closed match cannot restart'),
    },
  )
  assert.deepEqual(reported, { tableId: 'table', ...score })
})

test(
  'checkpoint recovery keeps the original replay table across multiple replacements and never resurrects a completed pairing',
  {
    skip: !process.env.PLAYMAT_TEST_DATABASE_URL,
  },
  async () => {
    const pool = new Pool({ connectionString: process.env.PLAYMAT_TEST_DATABASE_URL })
    const db = await pool.connect()
    try {
      await db.query(
        'CREATE TEMP TABLE tournament_pairings(table_id uuid,original_engine_table_id uuid,completed boolean)',
      )
      const [original, second, third] = [randomUUID(), randomUUID(), randomUUID()]
      await db.query('INSERT INTO tournament_pairings VALUES($1,NULL,false)', [original])
      await restoreTournamentTable(db, original, second)
      await restoreTournamentTable(db, original, third)
      await db.query('UPDATE tournament_pairings SET completed=true')
      await restoreTournamentTable(db, original, randomUUID())
      const {
        rows: [row],
      } = await db.query('SELECT * FROM tournament_pairings')
      assert.deepEqual(row, { table_id: third, original_engine_table_id: original, completed: true })
    } finally {
      db.release()
      await pool.end()
    }
  },
)

test(
  'the two tournament seats keep their registered main decks, printings and sideboards after the source decks are deleted',
  {
    skip: !process.env.PLAYMAT_TEST_DATABASE_URL,
  },
  async () => {
    const pool = new Pool({ connectionString: process.env.PLAYMAT_TEST_DATABASE_URL })
    const db = await pool.connect()
    try {
      await db.query('CREATE TEMP TABLE decks(id uuid PRIMARY KEY)')
      await db.query('CREATE TEMP TABLE tournament_entries(id uuid PRIMARY KEY,deck_name text)')
      await db.query(
        'CREATE TEMP TABLE tournament_entry_cards(entry_id uuid,zone text,position integer,card_name text,amount integer,set_code text,card_number text)',
      )
      const [a, b] = [randomUUID(), randomUUID()]
      await db.query('INSERT INTO decks VALUES($1),($2)', [a, b])
      await db.query("INSERT INTO tournament_entries VALUES($1,'Registered A'),($2,'Registered B')", [a, b])
      await db.query(
        "INSERT INTO tournament_entry_cards VALUES($1,'cards',1,'Forest',60,'M15','268'),($1,'sideboard',1,'Forest',2,NULL,NULL),($2,'cards',1,'Island',60,NULL,NULL)",
        [a, b],
      )
      await db.query('DELETE FROM decks')
      const [second, first] = await registeredDecklists(db, [b, a])
      assert.deepEqual(first.cards, [{ cardName: 'Forest', amount: 60, setCode: 'M15', cardNumber: '268' }])
      assert.equal(first.sideboard[0].amount, 2)
      assert.equal(second.entryId, b)
      assert.equal(second.cards[0].cardName, 'Island')
      assert.deepEqual(second.sideboard, [])
    } finally {
      db.release()
      await pool.end()
    }
  },
)

test(
  'a late native score from an intermediate restart is reported against the current table',
  {
    skip: !process.env.PLAYMAT_TEST_DATABASE_URL,
  },
  async (t) => {
    const config = { connectionString: process.env.PLAYMAT_TEST_DATABASE_URL }
    const main = new Pool(config)
    const schema = 'bridge_' + randomUUID().replaceAll('-', '')
    await main.query('CREATE SCHEMA ' + schema)
    const pool = new Pool({ ...config, options: '-c search_path=' + schema })
    t.after(async () => {
      await pool.end()
      await main.query('DROP SCHEMA ' + schema + ' CASCADE')
      await main.end()
    })
    for (const file of ['schema.sql', 'tournaments.sql', 'tournament-table-bridge.sql'])
      await pool.query(await readFile(new URL(file, import.meta.url), 'utf8'))
    const [owner, cup, pair, a, b, first, second, third, matchId] = Array.from({ length: 9 }, () => randomUUID())
    await pool.query(
      "INSERT INTO accounts(id,username,username_key,password_hash) VALUES($1,'owner','owner','fixture')",
      [owner],
    )
    await pool.query(
      `INSERT INTO tournaments(id,name,format,organizer_id,template,cut,capacity,swiss_best_of,playoff_best_of,max_agents_per_owner,coaching,break_minutes,created_at)
    VALUES($1,'test','Standard',$2,'casual','none',8,3,5,4,false,5,0)`,
      [cup, owner],
    )
    for (const [id, name] of [
      [a, 'Luna'],
      [b, 'Sol'],
    ])
      await pool.query(
        `INSERT INTO tournament_entries(id,tournament_id,owner_id,name,owner_name,engine_name,deck_id,deck_revision,deck_name)
    VALUES($1,$2,$3,$4,'owner',$4,'deck',1,'deck')`,
        [id, cup, owner, name],
      )
    await pool.query(
      `INSERT INTO tournament_pairings(id,tournament_id,round_number,stage,number,best_of,entry_a,entry_b,table_id,opened_at)
    VALUES($1,$2,1,'swiss',1,3,$3,$4,$5,0)`,
      [pair, cup, a, b, first],
    )
    await restoreTournamentTable(pool, first, second)
    await restoreTournamentTable(pool, first, third)
    await storeTournamentScore(pool, {
      matchId,
      winner: 'Luna',
      tournamentScore: { pairingId: pair, tableId: second, seatA: 'Luna', seatB: 'Sol', winsA: 2, winsB: 1, draws: 0 },
    })
    let received
    const bridge = createTournamentTableBridge(pool, {
      closedTables: async () => [],
      pendingTables: async () => [
        {
          tournamentId: cup,
          pairingId: pair,
          tableId: third,
          playerA: { engineName: 'Luna' },
          playerB: { engineName: 'Sol' },
        },
      ],
      report: async (...result) => {
        received = result
      },
    })
    await bridge.tick()
    assert.deepEqual(received, [
      cup,
      pair,
      { tableId: third, winsA: 2, winsB: 1, draws: 0, disqualified: null, winnerEngineName: 'Luna', matchId },
    ])
  },
)
