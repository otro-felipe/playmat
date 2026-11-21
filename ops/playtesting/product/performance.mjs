import { normalize, normalizeFormat, performanceCatalog, ProductError } from './decks.mjs'
import { classifyArchetype, deckListSignature } from './deck-performance-identity.mjs'
import { viewerNames } from './identity.mjs'
import { evidenceLoader } from './performance-evidence.mjs'

const emptyRecord = () => ({ total: 0, wins: 0, losses: 0, draws: 0 })
const emptySummary = () => ({ matches: emptyRecord(), games: emptyRecord() })

function count(record, winner, seat) {
  record.total++
  if (!winner) record.draws++
  else if (normalize(winner) === seat) record.wins++
  else record.losses++
}

function group(map, key, create) {
  if (!map.has(key)) map.set(key, create())
  return map.get(key)
}

export function historyFormatFilter(requested) {
  const format = normalizeFormat(requested) ?? requested?.trim()
  if (format && (format.length > 120 || /\p{Cc}/u.test(format))) throw new ProductError(400, 'Unsupported format')
  return format || null
}

async function finishedGames(pool, actor, format) {
  const { rows } = await pool.query(
    `
    SELECT m.id AS match_id,COALESCE(m.format,m.engine_format,'Unknown') AS format,m.wins_needed,m.winner AS match_winner,
      g.id,g.game_number,g.winner,g.start_player,g.turns,g.archive_state,g.object_key,g.checksum,
      p.engine_key,p.engine_name,p.player_id,p.mulligans,
      CASE WHEN g.game_number=1 THEN p.deck_snapshot END AS opening_deck,
      reg.deck_id,reg.deck_name,reg.list_version,reg.archetype,reg.list_signature,
      opponent.archetype AS opponent_archetype,opponent.mulligans AS opponent_mulligans
    FROM retained_match_history h JOIN matches m ON m.id=h.match_id
    JOIN games g ON g.match_id=m.id
    JOIN LATERAL (
      SELECT engine_name,engine_key,player_id,mulligans,deck_snapshot
      FROM game_players WHERE game_id=g.id AND engine_key=ANY($1::text[])
      ORDER BY array_position($1::text[],engine_key) LIMIT 1
    ) p ON TRUE
    LEFT JOIN match_deck_registrations reg ON reg.table_id=m.table_id AND reg.engine_key=p.engine_key AND reg.account_id=h.account_id
    LEFT JOIN LATERAL (
      SELECT MAX(r.archetype) AS archetype, MAX(other.mulligans) AS mulligans
      FROM game_players other LEFT JOIN match_deck_registrations r ON r.table_id=m.table_id AND r.engine_key=other.engine_key
      WHERE other.game_id=g.id AND other.engine_key<>p.engine_key HAVING COUNT(*)=1
    ) opponent ON TRUE
    WHERE h.account_id=$2 AND m.status='completed' AND g.status='completed' AND ($3::text IS NULL OR COALESCE(m.format,m.engine_format,'Unknown')=$3)
    ORDER BY m.started_at DESC,m.id,g.game_number,g.started_at,g.id`,
    [viewerNames(actor), actor.accountId, format],
  )
  return rows
}

function catalogIndex(decks) {
  const index = new Map()
  for (const deck of decks) {
    for (const version of deck.versions) {
      const key = JSON.stringify([version.format ?? deck.format, version.signature])
      group(index, key, () => []).push({
        deckId: deck.id,
        deckName: deck.name,
        version: version.version,
        archetype: version.archetype ?? deck.archetype,
        signature: version.signature,
      })
    }
  }
  return index
}

function identifyMatch(games, index) {
  const [first] = games
  if (first.deck_id)
    return {
      deckId: first.deck_id,
      deckName: first.deck_name,
      version: first.list_version,
      signature: first.list_signature,
      archetype: first.archetype,
    }
  // Never substitute game 2's sideboard configuration for an absent game 1.
  const initial = games.filter((game) => game.game_number === 1 && game.opening_deck)
  const signatures = new Set(initial.map((game) => deckListSignature(game.opening_deck)))
  const deck = signatures.size === 1 ? initial[0]?.opening_deck : null
  const signature = deck && deckListSignature(deck)
  const candidates = signature ? (index.get(JSON.stringify([first.format, signature])) ?? []) : []
  if (candidates.length === 1) return candidates[0]
  return {
    deckId: null,
    version: null,
    deckName: deck?.name ?? null,
    signature,
    archetype: deck && signature ? classifyArchetype(first.format, deck.name, deck.cards) : null,
  }
}

async function history(pool, actor, format) {
  const [decks, games] = await Promise.all([performanceCatalog(pool, actor.accountId), finishedGames(pool, actor, format)])
  const index = catalogIndex(decks)
  const matches = new Map()
  for (const game of games) group(matches, game.match_id, () => []).push(game)
  return {
    decks,
    matches: [...matches.values()].map((games) => {
      const [first] = games
      return {
        id: first.match_id,
        format: first.format,
        winner: first.match_winner,
        seat: first.engine_key,
        bestOf: first.wins_needed > 0 ? 2 * first.wins_needed - 1 : null,
        opponent: first.opponent_archetype,
        ...identifyMatch(games, index),
        games,
      }
    }),
  }
}

function matchesArchetype(value, expected, unknown) {
  return unknown === 'true' ? value == null : !expected || normalize(value) === normalize(expected)
}

function selectHistory({ decks, matches }, query) {
  const scope = query.scope ?? 'version'
  if (
    !['version', 'deck', 'archetype', 'all'].includes(scope) ||
    (query.bestOf && !['1', '3'].includes(query.bestOf)) ||
    (query.version !== undefined && !/^[1-9]\d{0,8}$/.test(query.version))
  )
    throw new ProductError(400, 'Invalid performance filter')
  const eligible = (deck) =>
    !query.format || deck.format === query.format || deck.versions.some((v) => v.format === query.format)
  const defaultId = matches.find(
    (match) => match.deckId && decks.some((deck) => deck.id === match.deckId && !deck.removed),
  )?.deckId
  const selectedDeck = query.deckId
    ? decks.find((deck) => deck.id === query.deckId)
    : (decks.find((deck) => deck.id === defaultId && eligible(deck)) ??
      decks.find((deck) => !deck.removed && eligible(deck)))
  if (query.deckId && !selectedDeck) throw new ProductError(404, 'Deck not found')
  const version = query.version ? Number(query.version) : (selectedDeck?.currentVersion ?? null)
  if (query.version && !selectedDeck?.versions.some((v) => v.version === version))
    throw new ProductError(400, 'Unknown deck version')
  const archetype =
    query.ownArchetype || (scope === 'archetype' && query.ownArchetypeUnknown !== 'true' ? selectedDeck?.archetype : null)
  const selected = matches.filter(
    (match) =>
      (!['version', 'deck'].includes(scope) || (selectedDeck && match.deckId === selectedDeck.id)) &&
      (scope !== 'version' || match.version === version) &&
      (!query.bestOf || match.bestOf === Number(query.bestOf)) &&
      matchesArchetype(match.archetype, archetype, query.ownArchetypeUnknown) &&
      matchesArchetype(match.opponent, query.opponentArchetype, query.opponentArchetypeUnknown),
  )
  return { selected, deckId: selectedDeck?.id ?? null, version, scope }
}

function archetypeGroups(decks, matches, query) {
  const groups = new Map()
  function byArchetype(format, archetype, deckId) {
    const result = group(groups, JSON.stringify([format, archetype]), () => ({
      format,
      archetype,
      deckIds: new Set(),
      ...emptySummary(),
    }))
    if (deckId) result.deckIds.add(deckId)
    return result
  }
  for (const deck of decks) {
    if (!deck.removed && (!query.format || deck.format === query.format)) byArchetype(deck.format, deck.archetype, deck.id)
  }
  for (const match of matches) {
    const result = byArchetype(match.format, match.archetype, match.deckId)
    count(result.matches, match.winner, match.seat)
    for (const game of match.games) count(result.games, game.winner, game.engine_key)
  }
  return [...groups.values()]
    .map((entry) => ({ ...entry, deckIds: [...entry.deckIds] }))
    .sort(
      (a, b) =>
        b.matches.total - a.matches.total ||
        String(a.format).localeCompare(String(b.format)) ||
        String(a.archetype).localeCompare(String(b.archetype)),
    )
}

function withoutCard(known, present) {
  return {
    total: known.total - present.total,
    wins: known.wins - present.wins,
    losses: known.losses - present.losses,
    draws: known.draws - present.draws,
  }
}

function rankCards(map) {
  return [...map]
    .map(([card, games]) => ({ card, games }))
    .sort((a, b) => b.games.total - a.games.total || a.card.localeCompare(b.card))
}

async function summarize(selected, loadEvidence, includeCards) {
  const summary = emptySummary()
  const splits = Object.fromEntries(['preboard', 'postboard', 'play', 'draw'].map((key) => [key, emptyRecord()]))
  const matchups = new Map(),
    mulligans = new Map(),
    openingCards = new Map(),
    opponentCards = new Map()
  const keptResults = emptyRecord()
  const replayExamples = new Map()
  const coverage = { keptHands: 0, opponentCards: 0, games: 0 }
  const byGame = includeCards ? await loadEvidence(selected.flatMap((match) => match.games)) : null
  for (const match of selected) {
    const matchup = group(matchups, match.opponent, () => ({
      archetype: match.opponent,
      ...emptySummary(),
      mulligans: { known: 0, taken: 0, opponentKnown: 0, opponentTaken: 0 },
    }))
    count(summary.matches, match.winner, match.seat)
    count(matchup.matches, match.winner, match.seat)
    for (const game of match.games) {
      const record = (bucket) => count(bucket, game.winner, game.engine_key)
      record(summary.games)
      record(matchup.games)
      record(game.game_number === 1 ? splits.preboard : splits.postboard)
      if (game.start_player) record(normalize(game.start_player) === game.engine_key ? splits.play : splits.draw)
      if (game.mulligans != null) {
        record(group(mulligans, game.mulligans, emptyRecord))
        matchup.mulligans.known++
        if (game.mulligans > 0) matchup.mulligans.taken++
      }
      if (game.opponent_mulligans != null) {
        matchup.mulligans.opponentKnown++
        if (game.opponent_mulligans > 0) matchup.mulligans.opponentTaken++
      }
      coverage.games++
      if (!includeCards) continue
      const evidence = byGame.get(game.id)
      if (evidence.opening !== null) {
        coverage.keptHands++
        record(keptResults)
        for (const card of evidence.opening) record(group(openingCards, card, emptyRecord))
      }
      if (evidence.opponent !== null) {
        coverage.opponentCards++
        for (const card of evidence.opponent) {
          record(group(opponentCards, card, emptyRecord))
          if (!game.object_key || game.archive_state !== 'ready') continue
          const examples = group(replayExamples, card, () => ({ losses: [], others: [] }))
          const bucket = game.winner && normalize(game.winner) !== game.engine_key ? examples.losses : examples.others
          if (bucket.length < 3) bucket.push(game.id)
        }
      }
    }
  }
  return {
    summary,
    splits,
    matchups: [...matchups.values()].sort((a, b) => b.matches.total - a.matches.total),
    mulligans: [...mulligans].sort(([a], [b]) => a - b).map(([count, games]) => ({ count, games })),
    openingCards: rankCards(openingCards).map(entry => ({ ...entry, without: withoutCard(keptResults, entry.games) })),
    opponentCards: rankCards(opponentCards).map(entry => {
      const examples = replayExamples.get(entry.card)
      return { ...entry, gameIds: examples ? [...examples.losses, ...examples.others].slice(0, 3) : [] }
    }),
    coverage,
  }
}

export function createPerformance(pool, readArchive) {
  const loadEvidence = evidenceLoader(pool, readArchive)
  return {
    async performance(actor, query) {
      const format = historyFormatFilter(query.format)
      query = { ...query, format }
      const data = await history(pool, actor, format || null)
      const { selected, scope, deckId, version } = selectHistory(data, query)
      const groups = archetypeGroups(data.decks, data.matches, query)
      const labels = (values) => [...new Set(values.filter(Boolean))].sort()
      return {
        decks: data.decks
          .filter((deck) => !deck.removed || data.matches.some((match) => match.deckId === deck.id))
          .map((deck) => ({
            id: deck.id,
            name: deck.name,
            format: deck.format,
            archetype: deck.archetype,
            currentVersion: deck.currentVersion,
            versions: deck.versions
              .map(({ version, format, archetype }) => ({ version, format, archetype }))
              .sort((a, b) => b.version - a.version),
          })),
        groups,
        selected: { deckId, version },
        matchIds: selected.map((match) => match.id),
        observedBestOf: [...new Set(selected.map((match) => match.bestOf))],
        options: {
          ownArchetypes: labels(groups.map((g) => g.archetype)),
          opponentArchetypes: labels(data.matches.map((m) => m.opponent)),
        },
        ...(await summarize(selected, loadEvidence, scope !== 'all' || query.includeCards === 'true')),
      }
    },
    async statistics(actor, requestedFormat) {
      const format = requestedFormat ? normalizeFormat(requestedFormat) : null
      if (requestedFormat && !format) throw new ProductError(400, 'Unsupported format')
      const { matches } = await history(pool, actor, format)
      const totals = { matches: matches.length, games: 0, wins: 0 }
      const groups = new Map()
      for (const match of matches) {
        const bucket = group(groups, JSON.stringify([match.format, match.deckId, match.signature]), () => ({
          format: match.format,
          deckName: match.deckName,
          deckVersion: match.signature,
          games: 0,
          wins: 0,
          onPlay: 0,
          onDraw: 0,
          mulligans: 0,
          mulliganCount: 0,
          turns: 0,
          turnCount: 0,
        }))
        for (const game of match.games) {
          bucket.games++
          totals.games++
          if (normalize(game.winner) === game.engine_key) {
            bucket.wins++
            totals.wins++
          }
          if (game.start_player) bucket[normalize(game.start_player) === game.engine_key ? 'onPlay' : 'onDraw']++
          if (game.mulligans != null) {
            bucket.mulligans += game.mulligans
            bucket.mulliganCount++
          }
          if (game.turns != null) {
            bucket.turns += game.turns
            bucket.turnCount++
          }
        }
      }
      return {
        totals,
        groups: [...groups.values()]
          .sort((a, b) => b.games - a.games)
          .slice(0, 100)
          .map(({ mulligans, mulliganCount, turns, turnCount, ...stats }) => ({
            ...stats,
            averageMulligans: mulliganCount ? mulligans / mulliganCount : null,
            averageTurns: turnCount ? turns / turnCount : null,
          })),
      }
    },
  }
}
