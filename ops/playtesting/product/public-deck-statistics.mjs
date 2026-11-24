import { createHash } from 'node:crypto'
import { archetypesFor, archetypeSourceUrl, canonicalArchetype } from './deck-performance-identity.mjs'
import { isUuid, ProductError } from './decks.mjs'
import { historyFormatFilter } from './performance.mjs'
import { archetypeColors, statisticsFormat } from './public-deck-identity.mjs'

// Keep the archive as the eligibility authority even for a completed tournament pairing.
// Project only opening identities and anonymous counts. Reading these never requires a replay,
// a private deck name, a composition signature or a player's current library revision.
const results = `
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
      AND (a.official_match IS NULL OR a.official_match=a.id)
      AND a.names @> ARRAY[lower(ea.engine_name),lower(eb.engine_name)]
      AND (a.winner_entry IS NULL OR a.winner_entry IN (ea.id,eb.id))
  ), eligible AS (
    SELECT id,ka,kb,format,ca,cb,aa,ab,palette_a,palette_b,outcome FROM tournament_results WHERE included AND candidates=1
    UNION ALL
    SELECT id,names[1],names[2],format,compositions[1],compositions[2],archetypes[1],archetypes[2],palettes[1],palettes[2],
      CASE winner WHEN names[1] THEN 1 WHEN names[2] THEN -1 ELSE 0 END
    FROM attributed WHERE included AND $1 IS NULL AND pairing_id IS NULL AND physical_id IS NULL
      AND (winner IS NULL OR winner=ANY(names))
  ), side_stats AS (
    -- Every completed game of an eligible match, from one seat: opening hands and length.
    SELECT g.match_id AS id,p.engine_key AS k,count(*)::int AS games,
      count(p.mulligans)::int AS mull_known,coalesce(sum(p.mulligans),0)::int AS mulligans,
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

// Unknown is a separate, format-scoped bucket. These keys encode only public labels.
// Identified decks instead use the randomly issued public composition UUID.
function categoryId(group, format, label) {
  return createHash('sha256')
    .update(JSON.stringify([group, format, label]))
    .digest('hex')
    .slice(0, 32)
}

function category(group, format, composition, publicName, archetype, colors) {
  if (group === 'deck') {
    if (composition) return { id: composition, name: publicName, format, colors }
    return { id: categoryId(group, format, null), name: null, unidentified: true, format, colors: null }
  }
  // Rows archived before a catalog change still group under today's name.
  const label = canonicalArchetype(format, archetype)
  const name = label !== 'Other' && archetypesFor(format).includes(label) ? label : null
  return {
    id: categoryId(group, format, name), name, format, colors: colors ?? archetypeColors(name),
    source: name ? archetypeSourceUrl(format, name) : null,
  }
}

const metrics = ['games', 'mulliganKnown', 'mulligans', 'keptGames', 'keptWins', 'mulliganGames', 'mulliganWins', 'timedGames', 'durationMs']

// One side of the aggregated duels: its own games and opening hands, and the shared game length.
function side(row, s) {
  return {
    games: row['games_' + s], mulliganKnown: row['mull_known_' + s], mulligans: row['mulligans_' + s],
    keptGames: row['kept_games_' + s], keptWins: row['kept_wins_' + s],
    mulliganGames: row['mull_games_' + s], mulliganWins: row['mull_wins_' + s],
    timedGames: row.timed ?? 0, durationMs: Number(row.duration ?? 0),
  }
}

function add(map, category, outcome, count, stats = {}) {
  let row = map.get(category.id)
  if (!row) {
    row = { ...category, n: 0, wins: 0, draws: 0, losses: 0, ...Object.fromEntries(metrics.map((m) => [m, 0])) }
    map.set(row.id, row)
  } else if (row.colors && (!category.colors || row.colors.join() !== category.colors.join())) {
    row.colors = null
  }
  row.n += count
  for (const m of metrics) row[m] += stats[m] ?? 0
  if (outcome > 0) row.wins += count
  else if (outcome < 0) row.losses += count
  else row.draws += count
}

function order(a, b) {
  return (
    b.n - a.n ||
    a.format.localeCompare(b.format) ||
    (a.name ?? '').localeCompare(b.name ?? '') ||
    a.id.localeCompare(b.id)
  )
}

export async function publicDeckStatistics(
  pool,
  { tournamentId = null, group = 'archetype', format, selected = null } = {},
) {
  if (!['archetype', 'deck'].includes(group)) throw new ProductError(400, 'Unsupported statistics group')
  if (format != null && typeof format !== 'string') throw new ProductError(400, 'Unsupported format')
  const requestedFormat = historyFormatFilter(format)
  const filter = requestedFormat && statisticsFormat(requestedFormat)
  let tournamentName = null
  if (tournamentId !== null) {
    if (!isUuid(tournamentId)) throw new ProductError(404, 'Tournament not found')
    const {
      rows: [cup],
    } = await pool.query('SELECT name FROM tournaments WHERE id=$1', [tournamentId])
    if (!cup) throw new ProductError(404, 'Tournament not found')
    tournamentName = cup.name
  }

  const { rows: counts } = await pool.query(results, [tournamentId])
  const formats = new Set()
  const rows = new Map()
  const opponents = new Map()
  let matches = 0
  for (const row of counts) {
    const format = statisticsFormat(row.format)
    formats.add(format)
    if (filter && format !== filter) continue
    matches += row.n
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

  return {
    tournamentName,
    formats: [...formats].sort(),
    matches,
    rows: [...rows.values()].sort(order),
    selected: rows.has(selected) ? { ...rows.get(selected), matchups: [...opponents.values()].sort(order) } : null,
  }
}
