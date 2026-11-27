import { createHash } from 'node:crypto'
import { matchEndingCauses } from './archive.mjs'
import { archetypesFor, archetypeSourceUrl, canonicalArchetype } from './deck-performance-identity.mjs'
import { isUuid, ProductError, transaction } from './decks.mjs'
import { historyFormatFilter } from './performance.mjs'
import { archetypeColors, statisticsFormat } from './public-deck-identity.mjs'

// Keep the archive as the eligibility authority even for a completed tournament pairing.
// Project only opening identities and anonymous counts. Reading these never requires a replay,
// a private deck name, a composition signature or a player's current library revision.
const eligibleMatches = `
  WITH seats AS (
    SELECT m.id,m.table_id,eligible.id IS NOT NULL AS included,COALESCE(m.format,m.engine_format,'Unknown') AS format,
      NULLIF(lower(btrim(m.winner)),'') AS winner,p.engine_key,
      CASE WHEN count(DISTINCT p.opening_composition_id) FILTER(WHERE g.game_number=1)=1
        THEN min(p.opening_composition_id::text) FILTER(WHERE g.game_number=1)::uuid END AS composition,
      CASE WHEN count(DISTINCT p.opening_archetype) FILTER(WHERE g.game_number=1)=1
        THEN min(p.opening_archetype) FILTER(WHERE g.game_number=1) END AS archetype,
      CASE WHEN count(DISTINCT p.opening_colors) FILTER(WHERE g.game_number=1)=1
        THEN min(array_to_string(p.opening_colors,'')) FILTER(WHERE g.game_number=1) END AS palette
    FROM matches m LEFT JOIN statistically_eligible_matches eligible ON eligible.id=m.id
    JOIN games g ON g.match_id=m.id AND g.status='completed'
    JOIN game_players p ON p.game_id=g.id
    WHERE m.status='completed' AND ($1::uuid IS NULL OR EXISTS (
      SELECT FROM tournament_pairings pairing WHERE pairing.tournament_id=$1
        AND (pairing.match_id=m.id OR pairing.id=tournament_pairing_for_table(m.table_id))
    ))
    GROUP BY m.id,eligible.id,p.engine_key
  ), duels AS (
    SELECT id,table_id,format,winner,included,array_agg(engine_key ORDER BY engine_key) AS names,
      array_agg(composition ORDER BY engine_key) AS compositions,
      array_agg(archetype ORDER BY engine_key) AS archetypes,array_agg(palette ORDER BY engine_key) AS palettes
    FROM seats GROUP BY id,table_id,format,winner,included HAVING count(*)=2
  ), attributed AS (
    SELECT d.*,physical.pairing_id AS physical_id,
      p.id AS pairing_id,p.match_id AS official_match,p.completed,p.result_reason,p.tournament_id,
      p.entry_a,p.entry_b,p.winner_entry
    FROM duels d
    LEFT JOIN tournament_pairing_tables physical ON physical.table_id=d.table_id
    LEFT JOIN tournament_pairings p ON p.id=physical.pairing_id
      OR (p.match_id=d.id AND physical.pairing_id IS NULL)
  ), tournament_results AS (
    SELECT a.id,lower(ea.engine_name) AS ka,lower(eb.engine_name) AS kb,
      a.pairing_id,a.included,t.format,ea.opening_composition_id AS ca,eb.opening_composition_id AS cb,
      ea.opening_archetype AS aa,eb.opening_archetype AS ab,
      array_to_string(ea.opening_colors,'') AS palette_a,array_to_string(eb.opening_colors,'') AS palette_b,
      CASE a.winner_entry WHEN a.entry_a THEN 1 WHEN a.entry_b THEN -1 ELSE 0 END AS outcome,
      count(*) OVER (PARTITION BY a.pairing_id) AS candidates
    FROM attributed a JOIN tournaments t ON t.id=a.tournament_id
    JOIN tournament_entries ea ON ea.id=a.entry_a JOIN tournament_entries eb ON eb.id=a.entry_b
    JOIN published_tournament_entries pa ON pa.entry_id=ea.id JOIN published_tournament_entries pb ON pb.entry_id=eb.id
    WHERE a.completed AND a.result_reason IN ('played','afk') AND ($1::uuid IS NULL OR t.id=$1)
      AND (NOT $2::boolean OR a.result_reason='played')
      AND (a.official_match IS NULL OR a.official_match=a.id)
      AND a.names @> ARRAY[lower(ea.engine_name),lower(eb.engine_name)]
      AND (a.winner_entry IS NULL OR a.winner_entry IN (ea.id,eb.id))
  ), eligible_series AS (
    SELECT id,ka,kb,format,ca,cb,aa,ab,palette_a,palette_b,outcome FROM tournament_results WHERE included AND candidates=1
    UNION ALL
    SELECT id,names[1],names[2],format,compositions[1],compositions[2],archetypes[1],archetypes[2],palettes[1],palettes[2],
      CASE winner WHEN names[1] THEN 1 WHEN names[2] THEN -1 ELSE 0 END
    FROM attributed WHERE included AND $1 IS NULL AND pairing_id IS NULL AND physical_id IS NULL
      AND (winner IS NULL OR winner=ANY(names))
  ), eligible AS (
    SELECT e.* FROM eligible_series e WHERE NOT $2::boolean OR NOT EXISTS (
      SELECT FROM games gq WHERE gq.match_id=e.id
        AND (gq.status<>'completed' OR NOT gq.good_quality OR gq.end_cause=ANY($3::text[]))
    )
  )`

const results = eligibleMatches + `, side_stats AS (
    -- Every completed game of an eligible match, from one seat: opening hands and length.
    SELECT g.match_id AS id,p.engine_key AS k,count(*)::int AS games,
      count(p.mulligans)::int AS mull_known,coalesce(sum(p.mulligans),0)::int AS mulligans,
      count(*) FILTER (WHERE lower(btrim(g.winner))=p.engine_key)::int AS game_wins,
      count(*) FILTER (WHERE p.mulligans=0)::int AS kept_games,
      count(*) FILTER (WHERE p.mulligans=0 AND lower(btrim(g.winner))=p.engine_key)::int AS kept_wins,
      count(*) FILTER (WHERE p.mulligans>0)::int AS mull_games,
      count(*) FILTER (WHERE p.mulligans>0 AND lower(btrim(g.winner))=p.engine_key)::int AS mull_wins,
      count(*) FILTER (WHERE g.ended_at>=g.started_at)::int AS timed,
      coalesce(sum(g.ended_at-g.started_at) FILTER (WHERE g.ended_at>=g.started_at),0)::bigint AS duration
    FROM games g JOIN game_players p ON p.game_id=g.id
    WHERE g.status='completed' AND g.match_id IN (SELECT id FROM eligible)
    GROUP BY g.match_id,p.engine_key
  ), counts AS (
    SELECT e.format,ca,cb,aa,ab,palette_a,palette_b,outcome,count(*)::int AS n,
      coalesce(sum(sa.games),0)::int AS games_a,coalesce(sum(sb.games),0)::int AS games_b,
      coalesce(sum(sa.game_wins),0)::int AS game_wins_a,coalesce(sum(sb.game_wins),0)::int AS game_wins_b,
      coalesce(sum(sa.mull_known),0)::int AS mull_known_a,coalesce(sum(sb.mull_known),0)::int AS mull_known_b,
      coalesce(sum(sa.mulligans),0)::int AS mulligans_a,coalesce(sum(sb.mulligans),0)::int AS mulligans_b,
      coalesce(sum(sa.kept_games),0)::int AS kept_games_a,coalesce(sum(sb.kept_games),0)::int AS kept_games_b,
      coalesce(sum(sa.kept_wins),0)::int AS kept_wins_a,coalesce(sum(sb.kept_wins),0)::int AS kept_wins_b,
      coalesce(sum(sa.mull_games),0)::int AS mull_games_a,coalesce(sum(sb.mull_games),0)::int AS mull_games_b,
      coalesce(sum(sa.mull_wins),0)::int AS mull_wins_a,coalesce(sum(sb.mull_wins),0)::int AS mull_wins_b,
      coalesce(sum(sa.timed),0)::int AS timed,coalesce(sum(sa.duration),0)::float8 AS duration
    FROM eligible e LEFT JOIN side_stats sa ON sa.id=e.id AND sa.k=e.ka
    LEFT JOIN side_stats sb ON sb.id=e.id AND sb.k=e.kb
    GROUP BY e.format,ca,cb,aa,ab,palette_a,palette_b,outcome
  ), cup_titles AS (
    SELECT e.opening_composition_id, min(NULLIF(btrim(e.deck_name),'') COLLATE "C") AS title
    FROM tournament_entries e JOIN published_tournament_entries pub ON pub.entry_id=e.id
    WHERE e.tournament_id=$1 AND e.opening_composition_id IS NOT NULL
    GROUP BY e.opening_composition_id
  )
  SELECT counts.*,COALESCE(ta.title,a.public_name) AS name_a,COALESCE(tb.title,b.public_name) AS name_b
  FROM counts LEFT JOIN public_deck_compositions a ON a.id=ca LEFT JOIN public_deck_compositions b ON b.id=cb
  LEFT JOIN cup_titles ta ON ta.opening_composition_id=ca LEFT JOIN cup_titles tb ON tb.opening_composition_id=cb`

// Casual and multiplayer formats have no archetype catalog; their results would mix unrelated decks.
const casualFormat = /freeform|commander|unknown/i
// Rehearsal lists exercise the engine, not the metagame. A match against one says nothing about either deck.
const practiceArchetypes = new Set(['Empty deck', 'Basic Lands Practice', 'Creature Practice'])
const isPractice = (format, label) => practiceArchetypes.has(canonicalArchetype(format, label))

// Unknown is a separate, format-scoped bucket. These keys encode only public labels.
// Identified decks instead use the randomly issued public composition UUID.
function categoryId(group, format, label) {
  return createHash('sha256')
    .update(JSON.stringify([group, format, label]))
    .digest('hex')
    .slice(0, 32)
}

// Rows archived before a catalog change still group under today's name.
function archetypeName(format, archetype) {
  const label = canonicalArchetype(format, archetype)
  return label !== 'Other' && archetypesFor(format).includes(label) ? label : null
}

function category(group, format, composition, publicName, archetype, colors) {
  if (group === 'deck') {
    // An unnamed list is shown by its archetype, so its row says what kind of deck it is.
    if (composition) return { id: composition, name: publicName, archetype: archetypeName(format, archetype), format, colors }
    return { id: categoryId(group, format, null), name: null, unidentified: true, format, colors: null }
  }
  const name = archetypeName(format, archetype)
  return {
    id: categoryId(group, format, name), name, format, colors: colors ?? archetypeColors(name),
    canonicalColors: archetypeColors(name),
    source: name ? archetypeSourceUrl(format, name) : null,
  }
}

const metrics = ['games', 'gameWins', 'mulliganKnown', 'mulligans', 'keptGames', 'keptWins', 'mulliganGames', 'mulliganWins', 'timedGames', 'durationMs']

// One side of the aggregated duels: its own games and opening hands, and the shared game length.
function side(row, s) {
  return {
    games: row['games_' + s], gameWins: row['game_wins_' + s], mulliganKnown: row['mull_known_' + s], mulligans: row['mulligans_' + s],
    keptGames: row['kept_games_' + s], keptWins: row['kept_wins_' + s],
    mulliganGames: row['mull_games_' + s], mulliganWins: row['mull_wins_' + s],
    timedGames: row.timed ?? 0, durationMs: Number(row.duration ?? 0),
  }
}

function add(map, category, outcome, count, stats = {}) {
  let row = map.get(category.id)
  if (!row) {
    const { colors, canonicalColors, ...rest } = category
    row = { ...rest, n: 0, wins: 0, draws: 0, losses: 0, ...Object.fromEntries(metrics.map((m) => [m, 0])) }
    Object.defineProperty(row, 'palettes', { value: { votes: new Map(), canonical: canonicalColors?.join('') ?? null } })
    map.set(row.id, row)
  } else if (row.archetype !== undefined && row.archetype !== category.archetype) {
    row.archetype = row.archetype ?? category.archetype
    if (category.archetype && row.archetype !== category.archetype) row.archetype = null
  }
  if (category.colors) {
    const key = category.colors.join('')
    row.palettes.votes.set(key, (row.palettes.votes.get(key) ?? 0) + count)
  }
  row.n += count
  for (const m of metrics) row[m] += stats[m] ?? 0
  if (outcome > 0) row.wins += count
  else if (outcome < 0) row.losses += count
  else row.draws += count
}

// The palette most records agree on. A tie keeps the archetype's own palette when it is
// one of the tied candidates, and is otherwise unknown.
function settleColors(row) {
  const { votes, canonical } = row.palettes
  const top = Math.max(0, ...votes.values())
  const tied = [...votes].filter(([, count]) => count === top).map(([key]) => key)
  const key = tied.length === 1 ? tied[0] : tied.includes(canonical) ? canonical : votes.size ? null : canonical
  row.colors = key == null ? null : [...key]
  return row
}

function order(a, b) {
  return (
    b.n - a.n ||
    a.format.localeCompare(b.format) ||
    (a.name ?? '').localeCompare(b.name ?? '') ||
    a.id.localeCompare(b.id)
  )
}

function snapshotCards(entries) {
  const counts = new Map()
  for (const card of Array.isArray(entries) ? entries : []) {
    const raw = typeof card === 'string' ? card : (card?.cardName ?? card?.name)
    const name = typeof raw === 'string' ? raw.trim() : ''
    const amount = Number(card?.amount ?? card?.quantity ?? card?.count ?? 1)
    if (!name || name.length > 200 || !Number.isSafeInteger(amount) || amount < 1) continue
    counts.set(name, (counts.get(name) ?? 0) + amount)
  }
  return counts
}

const byCount = (a, b) => b.amount - a.amount || a.name.localeCompare(b.name)

// The exact opening lists of the selected compositions. Only lists that reached an eligible,
// published duel are read: a game's own snapshot, or a published tournament registration.
async function compositionLists(pool, compositions) {
  if (!compositions.length) return new Map()
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (p.opening_composition_id) p.opening_composition_id AS id,p.deck_snapshot AS snapshot
    FROM game_players p WHERE p.opening_composition_id=ANY($1::uuid[]) AND p.opening_snapshot_used
      AND jsonb_typeof(p.deck_snapshot->'cards')='array'
    ORDER BY p.opening_composition_id,p.game_id`,
    [compositions],
  )
  const lists = new Map(rows.map((row) => [row.id, row.snapshot]))
  const missing = compositions.filter((id) => !lists.has(id))
  if (missing.length) {
    const { rows: cards } = await pool.query(
      `WITH chosen AS (
        SELECT DISTINCT ON (opening_composition_id) opening_composition_id AS id,id AS entry
        FROM tournament_entries WHERE opening_composition_id=ANY($1::uuid[]) ORDER BY opening_composition_id,id)
      SELECT chosen.id,c.zone,c.card_name,c.amount FROM chosen JOIN tournament_entry_cards c ON c.entry_id=chosen.entry
      ORDER BY chosen.id,c.zone,c.position`,
      [missing],
    )
    for (const card of cards) {
      if (!lists.has(card.id)) lists.set(card.id, { cards: [], sideboard: [] })
      lists.get(card.id)[card.zone === 'sideboard' ? 'sideboard' : 'cards'].push({ cardName: card.card_name, amount: card.amount })
    }
  }
  return lists
}

// Results by number of mulligans, and cards seen in a kept opening hand with how those games
// ended. Hands come from the seat's own replay evidence, never from an opponent's hidden zone.
async function openingHands(pool, seats) {
  const { rows } = await pool.query(
    `SELECT p.mulligans,lower(btrim(g.winner))=s.engine_key AS won,COALESCE(e.kept_hand_known,false) AS known,
      ARRAY(SELECT c.card_name FROM game_performance_cards c
        WHERE (c.game_id,c.engine_key)=(g.id,s.engine_key) AND c.evidence='keep') AS cards
    FROM unnest($1::uuid[],$2::text[]) AS s(match_id,engine_key)
    JOIN games g ON g.match_id=s.match_id AND g.status='completed'
    JOIN game_players p ON p.game_id=g.id AND p.engine_key=s.engine_key
    LEFT JOIN game_performance_evidence e ON (e.game_id,e.engine_key)=(g.id,s.engine_key)`,
    [seats.map((seat) => seat[0]), seats.map((seat) => seat[1])],
  )
  const cards = new Map()
  const mulligans = new Map()
  let games = 0,
    wins = 0
  for (const row of rows) {
    if (Number.isInteger(row.mulligans)) {
      const count = Math.min(row.mulligans, 3)
      const bucket = mulligans.get(count) ?? { count, games: 0, wins: 0 }
      bucket.games++
      if (row.won) bucket.wins++
      mulligans.set(count, bucket)
    }
    if (!row.known) continue
    games++
    if (row.won) wins++
    for (const name of new Set(row.cards)) {
      const card = cards.get(name) ?? { name, games: 0, wins: 0 }
      card.games++
      if (row.won) card.wins++
      cards.set(name, card)
    }
  }
  return {
    games,
    wins,
    mulligans: [...mulligans.values()].sort((a, b) => a.count - b.count),
    cards: [...cards.values()].sort((a, b) => b.games - a.games || b.wins - a.wins || a.name.localeCompare(b.name)).slice(0, 80),
  }
}

async function selectedDetails(pool, eligibility, { group, filter, selected }) {
  const { rows } = await pool.query(eligibleMatches + ' SELECT id,ka,kb,format,ca,cb,aa,ab FROM eligible', eligibility)
  const seats = []
  const compositions = new Map()
  for (const row of rows) {
    const format = statisticsFormat(row.format)
    if (casualFormat.test(format) || (filter && format !== filter) || isPractice(format, row.aa) || isPractice(format, row.ab)) continue
    for (const [key, composition, archetype] of [
      [row.ka, row.ca, row.aa],
      [row.kb, row.cb, row.ab],
    ]) {
      if (category(group, format, composition, null, archetype, null).id !== selected) continue
      seats.push([row.id, key])
      if (composition) compositions.set(composition, (compositions.get(composition) ?? 0) + 1)
    }
  }
  const lists = await compositionLists(pool, [...compositions.keys()])
  let list = null
  if (group === 'deck') {
    const snapshot = lists.get(selected)
    if (snapshot) {
      const zone = (entries) => [...snapshotCards(entries)].map(([name, amount]) => ({ name, amount })).sort(byCount)
      list = { kind: 'deck', main: zone(snapshot.cards), sideboard: zone(snapshot.sideboard) }
    }
  } else if (lists.size) {
    // Each distinct list counts once, whatever its number of participations.
    const zones = { main: new Map(), sideboard: new Map() }
    for (const snapshot of lists.values()) {
      for (const [zone, entries] of [
        ['main', snapshot.cards],
        ['sideboard', snapshot.sideboard],
      ]) {
        for (const [name, amount] of snapshotCards(entries)) {
          const card = zones[zone].get(name) ?? { name, lists: 0, copies: 0 }
          card.lists++
          card.copies += amount
          zones[zone].set(name, card)
        }
      }
    }
    const zone = (cards) =>
      [...cards.values()]
        .map((card) => ({ name: card.name, lists: card.lists, copies: card.copies / card.lists }))
        .sort((a, b) => b.lists - a.lists || b.copies - a.copies || a.name.localeCompare(b.name))
        .slice(0, 75)
    list = { kind: 'archetype', lists: lists.size, main: zone(zones.main), sideboard: zone(zones.sideboard) }
  }
  return { list, hands: seats.length ? await openingHands(pool, seats) : { games: 0, wins: 0, mulligans: [], cards: [] } }
}

export function publicDeckStatistics(pool, options = {}) {
  if (!options.selected) return readStatistics(pool, options)
  return transaction(pool, async db => {
    // Rankings and the selected row's opening hands must use the same quality verdicts.
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    return readStatistics(db, options)
  })
}

async function readStatistics(
  pool,
  { tournamentId = null, group = 'archetype', format, selected = null, goodQuality = false },
) {
  if (!['archetype', 'deck'].includes(group)) throw new ProductError(400, 'Unsupported statistics group')
  if (format != null && typeof format !== 'string') throw new ProductError(400, 'Unsupported format')
  const requestedFormat = historyFormatFilter(format)
  let filter = requestedFormat && statisticsFormat(requestedFormat)
  let tournamentName = null
  if (tournamentId !== null) {
    if (!isUuid(tournamentId)) throw new ProductError(404, 'Tournament not found')
    const {
      rows: [cup],
    } = await pool.query('SELECT name FROM tournaments WHERE id=$1', [tournamentId])
    if (!cup) throw new ProductError(404, 'Tournament not found')
    tournamentName = cup.name
  }

  const eligibility = [tournamentId, goodQuality, [...matchEndingCauses]]
  const { rows: allCounts } = await pool.query(results, eligibility)
  const counts = allCounts.filter((row) => {
    const format = statisticsFormat(row.format)
    return !casualFormat.test(format) && !isPractice(format, row.aa) && !isPractice(format, row.ab)
  })
  const played = new Map()
  for (const row of counts) {
    const format = statisticsFormat(row.format)
    played.set(format, (played.get(format) ?? 0) + row.n)
  }
  // Win rates from different formats are not comparable. Without a choice, show the busiest one.
  if (!filter && tournamentId === null && played.size)
    filter = [...played].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
  const rows = new Map()
  const opponents = new Map()
  let matches = 0,
    games = 0
  for (const row of counts) {
    const format = statisticsFormat(row.format)
    if (filter && format !== filter) continue
    matches += row.n
    games += row.games_a ?? 0
    const a = category(group, format, row.ca, row.name_a, row.aa, row.palette_a?.split('') ?? null)
    const b = category(group, format, row.cb, row.name_b, row.ab, row.palette_b?.split('') ?? null)
    const sa = side(row, 'a'),
      sb = side(row, 'b')
    add(rows, a, row.outcome, row.n, sa)
    add(rows, b, -row.outcome, row.n, sb)
    // A matchup row reports the selected deck's own hands against that opponent.
    if (selected === a.id) add(opponents, b, row.outcome, row.n, sa)
    if (selected === b.id) add(opponents, a, -row.outcome, row.n, sb)
  }
  for (const row of [...rows.values(), ...opponents.values()]) settleColors(row)
  // The ranking lists only identified archetypes and decks. Their unknown opponents still count
  // in each record and matchup table.
  const ranked = [...rows.values()].filter((row) => row.name !== null || (group === 'deck' && !row.unidentified))
  const hidden = [...rows.values()].filter((row) => !ranked.includes(row)).reduce((total, row) => total + row.n, 0)
  const detail = rows.get(selected)

  return {
    tournamentName,
    formats: [...played.keys()].sort(),
    format: filter || null,
    matches,
    games,
    unclassified: hidden,
    rows: ranked.sort(order),
    selected: detail
      ? {
          ...detail,
          matchups: [...opponents.values()].sort(order),
          ...(await selectedDetails(pool, eligibility, { group, filter, selected })),
        }
      : null,
  }
}
