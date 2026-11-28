import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { publicDeckStatistics } from './public-deck-statistics.mjs'

const url = process.env.PLAYMAT_TEST_DATABASE_URL
async function fixture(t) {
  const schema = 'public_stats_' + randomUUID().replaceAll('-', '')
  const base = new Pool({ connectionString: url })
  await base.query('CREATE SCHEMA ' + schema)
  const db = new Pool({ connectionString: url, options: '-c search_path=' + schema })
  t.after(async () => {
    await db.end()
    await base.query('DROP SCHEMA ' + schema + ' CASCADE')
    await base.end()
  })
  for (const file of [
    'schema',
    'oauth-schema',
    'player-identities',
    'review-schema',
    'tournaments',
    'performance-schema',
    'public-deck-identity',
  ])
    await db.query(await readFile(new URL(file + '.sql', import.meta.url), 'utf8'))
  const owner = randomUUID()
  await db.query(
    "INSERT INTO accounts(id,username,username_key,password_hash) VALUES($1,'Private owner','private owner','fixture')",
    [owner],
  )
  const palettes = new Map()
  async function composition(label, colors) {
    const id = randomUUID()
    palettes.set(id, colors)
    await db.query('INSERT INTO public_deck_compositions(id,format,list_signature,public_name) VALUES($1,$2,$3,$4)', [
      id,
      'Pioneer',
      'internal-' + id,
      label,
    ])
    return id
  }
  async function match(
    sides,
    { format = 'Pioneer', winner = 'Alice', status = 'completed', table = randomUUID(), number = 1 } = {},
  ) {
    const id = randomUUID(),
      game = randomUUID()
    await db.query('INSERT INTO matches(id,table_id,engine_format,winner,started_at,status) VALUES($1,$2,$3,$4,0,$5)', [
      id,
      table,
      format,
      winner,
      status,
    ])
    await db.query(
      "INSERT INTO games(id,match_id,game_number,started_at,status,archive_state) VALUES($1,$2,$3,0,'completed','ready')",
      [game, id, number],
    )
    for (const [i, [comp, arch]] of sides.entries()) {
      const name = ['Alice', 'Bob', 'Charlie'][i]
      await db.query(
        'INSERT INTO game_players(game_id,engine_key,engine_name,human,opening_composition_id,opening_archetype,deck_snapshot,opening_colors) VALUES($1,lower($2),$2,true,$3,$4,$5,$6)',
        [game, name, comp, arch, JSON.stringify({ name: 'Private deck name' }), palettes.get(comp)],
      )
    }
    return { id, table, game }
  }
  const exclude = (id) =>
    db.query("INSERT INTO match_statistics_exclusions(match_id,reason,author) VALUES($1,'fixture','fixture')", [id])
  return { db, owner, match, composition, exclude }
}
const record = (row) => [row.n, row.wins, row.draws, row.losses]

test('[PM-TOUR-VOID-AC-002] voided physical and legacy match links leave public aggregates without altering archives', { skip: !url }, async t => {
  const { db, owner, composition, match } = await fixture(t)
  const red = await composition(null, ['R'])
  const blue = await composition(null, ['U'])
  const sides = [[red, 'Red Deck Wins'], [blue, 'UR Aggro']]
  const createCup = async name => {
    const id = randomUUID(), a = randomUUID(), b = randomUUID()
    await db.query(`INSERT INTO tournaments(id,name,format,organizer_id,template,cut,capacity,swiss_best_of,playoff_best_of,
      max_agents_per_owner,coaching,break_minutes,created_at,status,stage)
      VALUES($1,$2,'Pioneer',$3,'attendance','none',8,3,3,8,false,5,0,'finished','swiss')`, [id,name,owner])
    await db.query(`INSERT INTO tournament_entries(id,tournament_id,owner_id,name,owner_name,engine_name,deck_id,deck_revision,
      deck_name,opening_composition_id,opening_archetype) VALUES($1,$3,$4,'Alice','Private owner','Alice','a',1,'Fixture A',$5,'Red Deck Wins'),
      ($2,$3,$4,'Bob','Private owner','Bob','b',1,'Fixture B',$6,'UR Aggro')`, [a,b,id,owner,red,blue])
    const pair = async (number, { table = null, original = null, matchId = null }) => {
      await db.query(`INSERT INTO tournament_pairings(tournament_id,round_number,stage,number,best_of,entry_a,entry_b,winner_entry,
        table_id,original_engine_table_id,match_id,opened_at,completed,result_reason)
        VALUES($1,$2,'swiss',1,3,$3,$4,$3,$5,$6,$7,0,true,'played')`, [id,number,a,b,table,original,matchId])
    }
    return { id, pair }
  }
  const excluded = await createCup('Fixture void')
  const remaining = await createCup('Fixture remaining')
  const restored = await match(sides)
  await excluded.pair(1, { table: randomUUID(), original: restored.table })
  const legacy = await match(sides)
  await excluded.pair(2, { matchId: legacy.id })
  const control = await match(sides)
  await remaining.pair(1, { table: control.table, matchId: control.id })
  const friendly = await match(sides)
  await db.query("UPDATE games SET good_quality=true,winner='Alice' WHERE id=ANY($1)", [[restored.game,legacy.game,control.game,friendly.game]])

  const before = await publicDeckStatistics(db, { tournamentId: excluded.id, goodQuality: true })
  assert.deepEqual([before.matches, before.games], [2, 2])
  await db.query('UPDATE tournaments SET voided_at=$2,void_request_id=$3 WHERE id=$1', [excluded.id,1,randomUUID()])
  const voidReport = await publicDeckStatistics(db, { tournamentId: excluded.id })
  assert.deepEqual([voidReport.tournamentName, voidReport.matches, voidReport.games, voidReport.rows],
    ['Fixture void', 0, 0, []])
  for (const goodQuality of [false,true]) {
    const aggregate = await publicDeckStatistics(db, { goodQuality, group: 'deck', selected: red })
    assert.deepEqual([aggregate.matches, aggregate.games, aggregate.selected.matchups[0].games], [2, 2, 2])
    const other = await publicDeckStatistics(db, { tournamentId: remaining.id, goodQuality })
    assert.deepEqual([other.matches, other.games], [1, 1])
  }
  const { rows } = await db.query('SELECT m.id,g.good_quality FROM matches m JOIN games g ON g.match_id=m.id WHERE m.id=ANY($1)', [[restored.id,legacy.id]])
  assert.equal(rows.length, 2)
  assert.ok(rows.every(g => g.good_quality))
})

test('[PM-STATS-QUALITY-1] mixed series contribute each good game to rankings, matchup totals and hands', { skip: !url }, async t => {
  const { db, composition, match, exclude } = await fixture(t)
  const red = await composition(null, ['R'])
  const blue = await composition(null, ['U'])
  const sides = [[red, 'Red Deck Wins'], [blue, 'UR Aggro']]
  const good = await match(sides)
  const mixed = await match(sides, { winner: 'Bob' })
  const excluded = await match(sides)
  await exclude(excluded.id)
  await match(sides)
  await db.query("UPDATE games SET good_quality=true,winner='Alice',ended_at=60000 WHERE id=ANY($1)", [
    [good.game, mixed.game, excluded.game],
  ])
  const addGame = async (series, quality) => {
    const game = randomUUID()
    await db.query("INSERT INTO games(id,match_id,game_number,started_at,ended_at,winner,status,archive_state,good_quality) VALUES($1,$2,2,0,30000,'Alice','completed','ready',$3)",
      [game, series.id, quality])
    await db.query("INSERT INTO game_players(game_id,engine_key,engine_name,human,mulligans) VALUES($1,'alice','Alice',true,1),($1,'bob','Bob',true,0)", [game])
    await db.query("INSERT INTO game_performance_evidence(game_id,engine_key,kept_hand_known,opponent_view_known) VALUES($1,'alice',true,false)", [game])
    return game
  }
  const goodSecond = await addGame(good, true)
  await addGame(mixed, false)
  await db.query("UPDATE game_players SET mulligans=0 WHERE game_id=$1 AND engine_key='alice'", [mixed.game])
  await db.query("INSERT INTO game_performance_evidence(game_id,engine_key,kept_hand_known,opponent_view_known) VALUES($1,'alice',true,false)", [mixed.game])
  const baseline = await publicDeckStatistics(db, { group: 'deck', selected: red })
  assert.deepEqual([baseline.matches, baseline.games], [3, 5])
  const filtered = await publicDeckStatistics(db, { group: 'deck', selected: red, goodQuality: true })
  assert.deepEqual([filtered.matches, filtered.games], [1, 3])
  assert.deepEqual(record(filtered.selected), [1, 1, 0, 0])
  assert.deepEqual(record(filtered.selected.matchups[0]), [1, 1, 0, 0])
  assert.equal(filtered.selected.matchups[0].games, 3)
  assert.deepEqual([filtered.selected.games, filtered.selected.gameWins, filtered.selected.durationMs], [3, 3, 150000])
  assert.deepEqual(filtered.selected.hands, { games: 2, wins: 2, mulligans: [{ count: 0, games: 1, wins: 1 }, { count: 1, games: 1, wins: 1 }], cards: [] })
  await db.query('UPDATE games SET good_quality=false WHERE id=$1', [goodSecond])
  const gamesOnly = await publicDeckStatistics(db, { group: 'deck', selected: red, goodQuality: true })
  assert.deepEqual([gamesOnly.formats, gamesOnly.format, gamesOnly.matches, gamesOnly.games], [['Pioneer'], 'Pioneer', 0, 2])
  assert.deepEqual(record(gamesOnly.selected), [0, 0, 0, 0])
  assert.deepEqual(record(gamesOnly.selected.matchups[0]), [0, 0, 0, 0])
  assert.deepEqual([gamesOnly.selected.games, gamesOnly.selected.gameWins, gamesOnly.selected.hands.games], [2, 2, 1])
})
test(
  'public deck and archetype matchups count only eligible duels from their opening snapshots, once per seat',
  { skip: !url },
  async (t) => {
    const { db, composition, match, exclude } = await fixture(t)
    const a = await composition(null, ['G']),
      b = await composition(null, ['G']),
      c = await composition('Public Example', [])
    const A = [a, 'Aggro'],
      B = [b, 'Aggro'],
      C = [c, 'Control']
    const first = await match([A, B])
    await match([B, A], { winner: null, format: 'Constructed - Pioneer' })
    await match([A, C], { winner: 'Bob' })
    await match([A, C], { format: 'Modern', winner: null, number: 2 })
    await match([A, B], { status: 'active' })
    await match([A, B], { status: 'interrupted' })
    await match([A, B], { winner: 'Not a seat' })
    await match([A, B, C])
    await exclude((await match([A, C])).id)
    const later = randomUUID()
    await db.query(
      "INSERT INTO games(id,match_id,game_number,started_at,status,archive_state) VALUES($1,$2,2,1,'completed','ready')",
      [later, first.id],
    )
    await db.query(
      "INSERT INTO game_players(game_id,engine_key,engine_name,human,opening_composition_id,opening_archetype) VALUES($1,'alice','Alice',true,$2,'Control'),($1,'bob','Bob',true,$2,'Control')",
      [later, c],
    )
    const report = await publicDeckStatistics(db, { format: 'Pioneer' })
    assert.equal(report.matches, 3)
    assert.deepEqual(report.formats, ['Modern', 'Pioneer'])
    // Generic Pioneer labels from earlier editors fall into MTGTop8's miscellaneous buckets.
    const aggro = report.rows.find((x) => x.name === 'Other - Aggro')
    assert.deepEqual(record(aggro), [5, 1, 2, 2])
    assert.deepEqual(aggro.colors, ['G'])
    assert.deepEqual(report.rows.find((x) => x.name === 'Other - Control').colors, [])
    const detail = await publicDeckStatistics(db, { selected: aggro.id })
    assert.deepEqual(record(detail.selected.matchups.find((x) => x.id === aggro.id)), [4, 1, 2, 1])
    assert.deepEqual(record(detail.selected.matchups.find((x) => x.name === 'Other - Control')), [1, 0, 0, 1])
    const decks = await publicDeckStatistics(db, { group: 'deck', format: 'Pioneer', selected: a })
    assert.equal(decks.rows.length, 3)
    assert.deepEqual(record(decks.selected), [3, 1, 1, 1])
    assert.equal(decks.selected.name, null)
    assert.notEqual(decks.selected.unidentified, true)
    assert.equal(decks.selected.matchups.find((x) => x.id === c).name, 'Public Example')
    assert.equal((await publicDeckStatistics(db, { group: 'deck', selected: randomUUID() })).selected, null)
    // A game-two-only record has no opening identity. It counts, but stays out of the ranking.
    const modern = await publicDeckStatistics(db, { format: 'Modern' })
    assert.deepEqual([modern.format, modern.matches, modern.unclassified, modern.rows], ['Modern', 1, 2, []])
    const modernDecks = await publicDeckStatistics(db, { group: 'deck', format: 'Modern' })
    assert.deepEqual([modernDecks.unclassified, modernDecks.rows], [2, []])
    // Without a requested format the busiest one is shown, never a mix of formats.
    assert.equal((await publicDeckStatistics(db)).format, 'Pioneer')
    assert.doesNotMatch(JSON.stringify([report, decks]), /Private|internal-|Alice|Bob/)
    await assert.rejects(publicDeckStatistics(db, { group: 'player' }), { status: 400 })
    await assert.rejects(publicDeckStatistics(db, { tournamentId: randomUUID() }), { status: 404 })
  },
)
test(
  '[PM-STATS-QUALITY-1] public matches follow tournament publication, eligible archive and restored table attribution',
  { skip: !url },
  async (t) => {
    const { db, owner, composition, match, exclude } = await fixture(t)
    const cup = randomUUID(),
      a = randomUUID(),
      b = randomUUID(),
      comp = await composition(null, ['R'])
    await db.query(
      "INSERT INTO tournaments(id,name,format,organizer_id,template,cut,capacity,swiss_best_of,playoff_best_of,max_agents_per_owner,coaching,break_minutes,created_at,status,stage) VALUES($1,'Example Cup','Pioneer',$2,'casual','auto',8,3,5,4,false,5,0,'running','swiss')",
      [cup, owner],
    )
    for (const [id, name, title] of [
      [a, 'Alice', 'Cup Red Alpha'],
      [b, 'Bob', 'Cup Red Beta'],
    ])
      await db.query(
        "INSERT INTO tournament_entries(id,tournament_id,owner_id,name,owner_name,engine_name,deck_id,deck_revision,deck_name,opening_composition_id,opening_archetype) VALUES($1,$2,$3,$4,'Private owner',$4,'private-lib-id',1,$6,$5,'Aggro')",
        [id, cup, owner, name, comp, title],
      )
    const physical = randomUUID(),
      first = await match(
        [
          [null, null],
          [null, null],
        ],
        { table: physical },
      ),
      restored = randomUUID()
    async function pairing(n, table, matchId, reason = 'played', entryB = b) {
      await db.query(
        "INSERT INTO tournament_pairings(tournament_id,stage,round_number,number,best_of,entry_a,entry_b,winner_entry,table_id,match_id,opened_at,completed,result_reason) VALUES($1,'swiss',$2,1,3,$3,$4,$3,$5,$6,0,true,$7)",
        [cup, n, a, entryB, table, matchId, reason],
      )
    }
    await pairing(1, physical, null)
    await db.query(
      'UPDATE tournament_pairings SET original_engine_table_id=table_id,table_id=$2 WHERE tournament_id=$1',
      [cup, restored],
    )
    await pairing(2, randomUUID(), randomUUID())
    await pairing(3, randomUUID(), null, 'bye', null)
    const rejected = await match([
      [null, null],
      [null, null],
    ])
    await pairing(4, rejected.table, rejected.id, 'no_show')
    const excluded = await match([
      [null, null],
      [null, null],
    ])
    await pairing(5, excluded.table, excluded.id)
    await exclude(excluded.id)
    const afk = await match(
      [
        [null, null],
        [null, null],
      ],
      { winner: 'Bob' },
    )
    await pairing(6, afk.table, afk.id, 'afk')
    const ambiguous = await match([
      [null, null],
      [null, null],
    ])
    await match(
      [
        [null, null],
        [null, null],
      ],
      { table: ambiguous.table },
    )
    await pairing(7, ambiguous.table, null)
    // Excluding one legacy incarnation does not prove which incarnation the score belonged to.
    const ambiguousExclusion = await match([
      [null, null],
      [null, null],
    ])
    await exclude(ambiguousExclusion.id)
    await match(
      [
        [null, null],
        [null, null],
      ],
      { table: ambiguousExclusion.table },
    )
    await pairing(8, ambiguousExclusion.table, null)
    async function check(n) {
      const local = await publicDeckStatistics(db, { tournamentId: cup })
      assert.equal(local.tournamentName, 'Example Cup')
      assert.equal(local.matches, n)
      assert.equal((await publicDeckStatistics(db)).matches, n)
      assert.doesNotMatch(JSON.stringify(local), /Private|private-lib|Alice|Bob/)
      return local
    }
    await check(0)
    assert.doesNotMatch(JSON.stringify(await publicDeckStatistics(db, { group: 'deck', tournamentId: cup })), /Cup Red/)
    await db.query("UPDATE tournaments SET stage='playoffs' WHERE id=$1", [cup])
    await db.query('UPDATE tournament_entries SET qualified_seed=1 WHERE id=$1', [a])
    await check(0)
    await db.query('UPDATE tournament_entries SET qualified_seed=2 WHERE id=$1', [b])
    const pub = await check(2)
    assert.deepEqual(record(pub.rows[0]), [4, 2, 0, 2])
    await db.query("UPDATE tournaments SET status='finished' WHERE id=$1", [cup])
    await db.query('UPDATE games SET good_quality=true WHERE id=ANY($1::uuid[])', [[first.game, afk.game, ambiguous.game]])
    const qualityCup = await publicDeckStatistics(db, { tournamentId: cup, goodQuality: true })
    assert.deepEqual([qualityCup.matches, qualityCup.games, record(qualityCup.rows[0])], [1, 2, [2, 1, 0, 1]])
    assert.equal((await publicDeckStatistics(db, { goodQuality: true })).matches, 1)
    await db.query(`INSERT INTO games(id,match_id,game_number,started_at,status,archive_state,good_quality,end_cause)
      VALUES ($1,$2,2,1,'completed','ready',true,'round_clock')`, [randomUUID(), first.id])
    const clockCup = await publicDeckStatistics(db, { tournamentId: cup, goodQuality: true })
    assert.deepEqual([clockCup.matches, clockCup.games, record(clockCup.rows[0]), clockCup.rows[0].games], [0, 2, [0, 0, 0, 0], 4])
    const cupDecks = await publicDeckStatistics(db, { group: 'deck', tournamentId: cup, selected: comp })
    assert.deepEqual(
      cupDecks.rows.map((r) => r.name),
      ['Cup Red Alpha'],
    )
    assert.equal(cupDecks.selected.matchups[0].name, 'Cup Red Alpha')
    assert.deepEqual(
      (await publicDeckStatistics(db, { group: 'deck' })).rows.map((r) => r.name),
      [null],
    )
    await exclude(first.id)
    await check(1)
    await match([
      [comp, 'Aggro'],
      [comp, 'Aggro'],
    ])
    // Both sides of this private Swiss registration refer to the very same composition
    // as an ordinary public encounter. Its local color metadata must not modify that encounter.
    await db.query("UPDATE tournaments SET status='running',stage='swiss' WHERE id=$1", [cup])
    await db.query("UPDATE tournament_entries SET opening_colors=ARRAY['U'] WHERE tournament_id=$1", [cup])
    const onlyPublic = await publicDeckStatistics(db, { group: 'deck' })
    assert.equal(onlyPublic.matches, 1)
    assert.deepEqual(onlyPublic.rows[0].colors, ['R'])
    await db.query("UPDATE tournaments SET status='finished' WHERE id=$1", [cup])
    assert.deepEqual((await publicDeckStatistics(db, { group: 'deck', tournamentId: cup })).rows[0].colors, ['U'])
    assert.equal((await publicDeckStatistics(db, { group: 'deck' })).rows[0].colors, null)
  },
)

test(
  'an evidenced archetype keeps its canonical palette with an unidentified opening list',
  { skip: !url },
  async (t) => {
    const { db, match } = await fixture(t)
    await match([
      [null, 'Mono-Red Aggro'],
      [null, 'Private unpublished title'],
    ])
    const report = await publicDeckStatistics(db)
    const red = report.rows.find((row) => row.name === 'Red Deck Wins')
    assert.deepEqual(red.colors, ['R'])
    assert.equal(red.source, 'https://www.mtgtop8.com/archetype?a=862&f=PI')
    assert.equal(report.rows.some((row) => row.name === null), false)
    assert.equal(report.unclassified, 1)
    assert.doesNotMatch(JSON.stringify(report), /Private unpublished title/)
    const decks = await publicDeckStatistics(db, { group: 'deck' })
    assert.deepEqual([decks.rows.length, decks.unclassified], [0, 2])
  },
)

test(
  'archetype rows report games, opening-hand mulligans with their game results, and average game length',
  { skip: !url },
  async (t) => {
    const { db, match } = await fixture(t)
    const first = await match([
      [null, 'Mono-Red Prowess'],
      [null, 'Izzet Prowess'],
    ])
    // Game one: Alice keeps seven and wins in 10 minutes; Bob mulligans once.
    await db.query("UPDATE games SET winner='Alice',started_at=0,ended_at=600000 WHERE id=$1", [first.game])
    await db.query("UPDATE game_players SET mulligans=CASE engine_key WHEN 'alice' THEN 0 ELSE 1 END WHERE game_id=$1", [first.game])
    // Game two: Alice mulligans twice and loses in 20 minutes; Bob keeps.
    const second = randomUUID()
    await db.query(
      "INSERT INTO games(id,match_id,game_number,started_at,ended_at,winner,status,archive_state) VALUES($1,$2,2,0,1200000,'Bob','completed','ready')",
      [second, first.id],
    )
    await db.query(
      "INSERT INTO game_players(game_id,engine_key,engine_name,human,mulligans) VALUES($1,'alice','Alice',true,2),($1,'bob','Bob',true,0)",
      [second],
    )
    const report = await publicDeckStatistics(db)
    const red = report.rows.find((row) => row.name === 'Red Deck Wins')
    const izzet = report.rows.find((row) => row.name === 'UR Aggro')
    assert.deepEqual(record(red), [1, 1, 0, 0])
    assert.deepEqual(
      [red.games, red.mulliganKnown, red.mulligans, red.keptGames, red.keptWins, red.mulliganGames, red.mulliganWins],
      [2, 2, 2, 1, 1, 1, 0],
    )
    assert.deepEqual(
      [izzet.games, izzet.mulligans, izzet.keptGames, izzet.keptWins, izzet.mulliganGames, izzet.mulliganWins],
      [2, 1, 1, 1, 1, 0],
    )
    assert.deepEqual([red.timedGames, red.durationMs], [2, 1800000])
    const detail = await publicDeckStatistics(db, { selected: red.id })
    const versus = detail.selected.matchups.find((row) => row.name === 'UR Aggro')
    assert.deepEqual([versus.games, versus.mulligans, versus.keptWins], [2, 2, 1], 'matchups report the selected deck’s own hands')
  },
)

test(
  'practice and casual results stay out, palettes follow the majority, and a selection shows its lists and kept hands',
  { skip: !url },
  async (t) => {
    const { db, composition, match } = await fixture(t)
    const red = await composition(null, ['R'])
    const splash = await composition(null, ['R', 'W'])
    const rival = await composition('Rival list', ['U', 'R'])
    const lists = {
      [red]: { cards: [{ cardName: 'Monastery Swiftspear', amount: 4 }, { cardName: 'Mountain', amount: 20 }], sideboard: [{ cardName: 'Abrade', amount: 2 }] },
      [splash]: { cards: [{ cardName: 'Monastery Swiftspear', amount: 3 }, { cardName: 'Sacred Foundry', amount: 4 }], sideboard: [] },
    }
    async function played(sides, options) {
      const result = await match(sides, options)
      for (const [i, [comp]] of sides.entries()) {
        if (!lists[comp]) continue
        await db.query('UPDATE game_players SET deck_snapshot=$3,opening_snapshot_used=true WHERE game_id=$1 AND engine_key=$2', [
          result.game, ['alice', 'bob'][i], JSON.stringify(lists[comp]),
        ])
      }
      return result
    }
    const RDW = [red, 'Red Deck Wins'], SPLASH = [splash, 'Red Deck Wins'], UR = [rival, 'UR Aggro']
    const first = await played([RDW, UR])
    await played([RDW, UR], { winner: 'Bob' })
    await played([SPLASH, UR])
    // None of these may reach the statistics.
    await played([RDW, [null, 'Basic Lands Practice']])
    await played([[null, 'Creature Practice'], UR])
    await played([RDW, UR], { format: 'Freeform' })
    await played([RDW, UR], { format: 'Freeform Commander' })
    // Alice keeps seven with Swiftspear and wins; a second game she mulligans once and loses.
    await db.query("UPDATE games SET winner='Alice' WHERE id=$1", [first.game])
    await db.query("UPDATE game_players SET mulligans=0 WHERE game_id=$1 AND engine_key='alice'", [first.game])
    const second = randomUUID()
    await db.query(
      "INSERT INTO games(id,match_id,game_number,started_at,winner,status,archive_state) VALUES($1,$2,2,1,'Bob','completed','ready')",
      [second, first.id],
    )
    await db.query("INSERT INTO game_players(game_id,engine_key,engine_name,human,mulligans) VALUES($1,'alice','Alice',true,1),($1,'bob','Bob',true,0)", [second])
    for (const [game, cards] of [
      [first.game, ['Monastery Swiftspear', 'Mountain']],
      [second, ['Mountain']],
    ]) {
      await db.query("INSERT INTO game_performance_evidence(game_id,engine_key,kept_hand_known,opponent_view_known) VALUES($1,'alice',true,false)", [game])
      for (const card of cards)
        await db.query("INSERT INTO game_performance_cards(game_id,engine_key,evidence,card_name) VALUES($1,'alice','keep',$2)", [game, card])
    }

    const report = await publicDeckStatistics(db)
    assert.deepEqual(report.formats, ['Pioneer'])
    assert.equal(report.matches, 3)
    assert.deepEqual(report.rows.map((row) => row.name), ['Red Deck Wins', 'UR Aggro'])
    const rdw = report.rows[0]
    // Two mono-red records outvote one splash list.
    assert.deepEqual(rdw.colors, ['R'])
    assert.deepEqual([record(rdw), rdw.games, rdw.gameWins], [[3, 2, 0, 1], 4, 1])

    const archetype = (await publicDeckStatistics(db, { selected: rdw.id })).selected
    assert.equal(archetype.list.kind, 'archetype')
    assert.equal(archetype.list.lists, 2)
    assert.deepEqual(archetype.list.main[0], { name: 'Monastery Swiftspear', lists: 2, copies: 3.5 })
    assert.deepEqual(archetype.list.sideboard, [{ name: 'Abrade', lists: 1, copies: 2 }])
    assert.deepEqual(archetype.hands.mulligans, [
      { count: 0, games: 1, wins: 1 },
      { count: 1, games: 1, wins: 0 },
    ])
    assert.deepEqual([archetype.hands.games, archetype.hands.wins], [2, 1])
    assert.deepEqual(archetype.hands.cards, [
      { name: 'Mountain', games: 2, wins: 1 },
      { name: 'Monastery Swiftspear', games: 1, wins: 1 },
    ])

    const deck = (await publicDeckStatistics(db, { group: 'deck', selected: red })).selected
    assert.deepEqual(deck.list, {
      kind: 'deck',
      main: [{ name: 'Mountain', amount: 20 }, { name: 'Monastery Swiftspear', amount: 4 }],
      sideboard: [{ name: 'Abrade', amount: 2 }],
    })
    assert.equal((await publicDeckStatistics(db, { group: 'deck', selected: rival })).selected.list, null)
    assert.doesNotMatch(JSON.stringify([report, archetype, deck]), /Private|internal-|Alice|Bob/)

    // The one-time reset excludes every match that started before its cutoff, and only those.
    const later = await played([RDW, UR])
    await db.query('UPDATE matches SET started_at=1795556700000 WHERE id=$1', [later.id])
    await db.query(await readFile(new URL('statistics-reset.sql', import.meta.url), 'utf8'))
    await db.query(await readFile(new URL('statistics-reset.sql', import.meta.url), 'utf8'))
    const reset = await publicDeckStatistics(db)
    assert.equal(reset.matches, 1)
    const { rows: [excluded] } = await db.query("SELECT count(*)::int AS n FROM match_statistics_exclusions WHERE author='service-operator'")
    assert.equal(excluded.n, 7)
  },
)
