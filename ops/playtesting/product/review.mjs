import { createHash } from 'node:crypto'
import { projectReplayEvent } from './archive.mjs'
import { isUuid, normalize, ProductError } from './decks.mjs'
import { categories, createReviewAnnotations } from './review-annotations.mjs'

const pageLimit = 40
const capturedActions = new Set(['cast', 'land', 'activate', 'attack', 'block', 'mulligan', 'keep', 'sideboard', 'pass', 'pay', 'select'])
const cardActions = new Map([
  ['plays', 'land'], ['casts', 'cast'], ['activates', 'activate'], ['attacks', 'attack'], ['blocks', 'block'],
  ['mulligans', 'mulligan'], ['keeps', 'keep'], ['sideboards', 'sideboard'], ['passes', 'pass'],
  ['pays', 'pay'], ['discards', 'discard'], ['chooses', 'select'],
])
const manaSymbols = ['W', 'U', 'B', 'R', 'G', 'C']

function plainText(value) {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() : ''
}

function immutableRevision(game) {
  return game.checksum ? createHash('sha256').update(JSON.stringify([game.id, game.checksum])).digest('hex') : null
}

function gameReady(game) {
  return game.match_status === 'completed' && game.status === 'completed' && !!game.object_key && !!game.checksum
}

function canReadTogether(game, access) {
  return gameReady(game) && access.fullAvailable && (game.review_version === 2 || access.legacyGranted)
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null) return fallback
  if (!/^\d{1,10}$/.test(String(value))) throw new ProductError(400, 'Use a numeric replay cursor, turn or page size')
  const number = Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new ProductError(400, 'Replay page is outside the supported bounds')
  return number
}

function pageOptions(query) {
  return {
    cursor: boundedInteger(query.cursor, 0, 0, 2_147_483_647),
    count: boundedInteger(query.count, 8, 1, pageLimit),
    turn: boundedInteger(query.turn, null, 0, 1_000_000),
  }
}

function checkArchiveRevision(expected, revision) {
  if (expected !== undefined && expected !== revision) throw new ProductError(409, 'Replay archive changed. Reopen the review')
}

function requireReady(game) {
  if (!gameReady(game)) throw new ProductError(409, 'Wait for the completed match and its replay archive')
}

function canonicalRows(raw) {
  const rows = []
  let turn = null
  let frameCursor = null
  for (const [cursor, event] of raw.entries()) {
    if (event.kind === 'rollback' && Number.isSafeInteger(event.turn)) {
      while (rows.length && rows.at(-1).turn >= event.turn) rows.pop()
      turn = event.turn
      frameCursor = rows.at(-1)?.frameCursor ?? null
    }
    if (event.view && Number.isSafeInteger(event.view.turn)) {
      turn = event.view.turn
      frameCursor = cursor
    }
    rows.push({ cursor, frameCursor, turn: Number.isSafeInteger(event.turn) ? event.turn : turn, event })
  }
  return rows
}

function gamePerspectives(game, access, rows) {
  const players = game.players ?? []
  const observed = new Map()
  for (const { event } of rows) {
    if (!Array.isArray(event.view?.players)) continue
    for (const { playerId, name } of event.view.players) if (isUuid(playerId)) observed.set(normalize(name), playerId)
    if (observed.size >= players.length) break
  }
  return players.map(player => {
    const playerId = player.playerId ?? observed.get(player.seatId)
    const owned = access.perspectives.some(perspective => perspective.seatId === player.seatId && perspective.owned)
      || player.seatId === access.viewerSeatId
    return { seatId: player.seatId, name: player.name, ...(playerId ? { playerId } : {}), owned }
  })
}

function scopedSeat(game, access, perspectives, scope, requestedSeat) {
  if (!['seat', 'public', 'full'].includes(scope)) throw new ProductError(400, 'Unknown replay perspective')
  if (scope === 'full' && !canReadTogether(game, access)) throw new ProductError(403, 'Full replay permission is unavailable')
  if (scope === 'public') return null
  // A match owner must also own a seat in the requested game. This prevents
  // substituting a separately recorded game identifier into another match.
  const seat = perspectives.find(perspective => perspective.seatId === (requestedSeat ?? access.viewerSeatId))
  if (!seat || (!seat.owned && !canReadTogether(game, access))) throw new ProductError(403, 'Replay perspective is unavailable')
  return seat
}

function frameProjection(event, seat, typed) {
  const overlay = typed && seat?.playerId ? event.review?.seatViews?.[seat.playerId] : null
  // Read only the hand of the requested seat. Apply the ordinary public
  // allowlist to a seat-specific view rather than packaging hidden metadata.
  const projected = projectReplayEvent({ ...event, view: overlay ? { ...event.view, ...overlay } : event.view }, seat?.seatId)
  if (!projected?.view) return null
  if (seat && overlay?.lookedAt) projected.view.lookedAt = overlay.lookedAt
  if (seat && overlay?.myHand) projected.myHand = overlay.myHand
  return projected
}

function gameHand(event, seat, typed) {
  return frameProjection(event, seat, typed)?.myHand ?? null
}

function actionDetails(row, perspectives, typed) {
  const { event } = row
  if (typed && event.kind === 'action' && capturedActions.has(event.action)) {
    const seat = perspectives.find(({ playerId }) => playerId === event.actorPlayerId)
    if (!seat) return null
    const card = cardReference(event.card)
    const paidMana = Object.fromEntries(manaSymbols.filter(symbol => Number.isSafeInteger(event.paidMana?.[symbol])
      && event.paidMana[symbol] > 0 && event.paidMana[symbol] < 1000).map(symbol => [symbol, event.paidMana[symbol]]))
    const details = {
      kind: event.action,
      text: card ? `${seat.name} · ${event.action} · ${card.name}` : `${seat.name} · ${event.action}`,
      ...(card ? { card: card.name } : {}),
      ...(isUuid(event.objectId) ? { objectId: event.objectId } : {}),
      ...(isUuid(event.sourceId) ? { sourceId: event.sourceId } : {}),
      ...(typeof event.fromZone === 'string' ? { fromZone: event.fromZone.slice(0, 30) } : {}),
      ...(Array.isArray(event.targetIds) ? { targetIds: event.targetIds.filter(isUuid).slice(0, 32) } : {}),
      ...(Object.keys(paidMana).length ? { paidMana } : {}),
      ...(Array.isArray(event.modes) ? { modes: event.modes.filter(mode => typeof mode === 'string').slice(0, 10).map(mode => mode.slice(0, 400)) } : {}),
    }
    return { seatId: seat.seatId, basis: 'recorded_action', actual: details }
  }
  if (event.log?.messageType !== 'GAME') return null
  const message = plainText(event.log.message)
  const lower = message.toLowerCase()
  const seat = perspectives.find(({ name }) => lower.startsWith(normalize(name) + ' '))
  if (!seat) return null
  const rest = message.slice(seat.name.length).trimStart()
  const verb = rest.split(/\s+/, 1)[0].toLowerCase()
  if (!cardActions.has(verb)) return null
  return { seatId: seat.seatId, basis: 'engine_log', actual: { kind: cardActions.get(verb), text: message.slice(0, 1200) } }
}

function positionsFor(rows, perspectives, typed) {
  const positions = []
  const frames = new Set()
  let lastAction = null
  for (const row of rows) {
    if (row.event.view) frames.add(row.cursor)
    if (row.frameCursor === null || row.cursor === row.frameCursor) continue
    const details = actionDetails(row, perspectives, typed)
    if (!details) continue
    // Captured actions and the human-readable log can describe the same play.
    // Resolve only a neighboring actor/kind pair with no intervening action or
    // frame. Other logs remain available as lower-confidence historical anchors.
    if (lastAction?.seatId === details.seatId && lastAction.actual.kind === details.actual.kind
      && (lastAction.basis === 'recorded_action') !== (details.basis === 'recorded_action')
      && lastAction.frameCursor === row.frameCursor) {
      if (details.basis === 'engine_log') {
        lastAction.actual.text = details.actual.text
        lastAction = null
        continue
      }
      details.actual.text = lastAction.actual.text
      positions.pop()
    }
    const explicitFrame = row.event.preActionCursor
    const exact = typed && details.basis === 'recorded_action'
      && Number.isSafeInteger(explicitFrame) && explicitFrame < row.cursor && frames.has(explicitFrame)
    const frameCursor = exact ? explicitFrame : row.frameCursor
    const evidence = { frameCursor, turn: row.turn, basis: details.basis,
      frameQuality: exact ? 'exact' : 'preceding_snapshot' }
    lastAction = { cursor: row.cursor, frameCursor, seatId: details.seatId, actual: details.actual, evidence,
      basis: details.basis }
    positions.push(lastAction)
  }
  const occupied = new Set()
  return positions.map(({ basis: _basis, ...position }) => {
    if (occupied.has(position.frameCursor) && position.evidence.frameQuality !== 'exact') position.evidence.frameQuality = 'coalesced_snapshot'
    occupied.add(position.frameCursor)
    return position
  })
}

function cardReference(card) {
  if (!card || !isUuid(card.id) || typeof card.name !== 'string') return null
  return { id: card.id, name: card.name, ...(typeof card.setCode === 'string' ? { setCode: card.setCode } : {}),
    ...(typeof card.cardNumber === 'string' ? { cardNumber: card.cardNumber } : {}) }
}

function projectRow(row, seat, scope, perspectives, typed, analysis) {
  const { event, cursor, frameCursor, turn } = row
  const base = { cursor, frameCursor, turn, timeMs: event.t }
  if (event.view) {
    const frame = frameProjection(event, seat, typed)
    if (!frame) return null
    const hands = scope === 'full' ? Object.fromEntries(perspectives.flatMap(perspective => {
      const hand = gameHand(event, perspective, typed)
      return hand && perspective.playerId ? [[perspective.playerId, hand]] : []
    })) : undefined
    return { ...base, type: 'frame', view: frame.view, ...(frame.myHand ? { myHand: frame.myHand } : {}), ...(hands ? { hands } : {}) }
  }
  if (event.kind === 'rollback' && Number.isSafeInteger(event.turn)) return { ...base, type: 'rollback' }
  if (typed && event.kind === 'draw' && isUuid(event.actorPlayerId)) {
    const actor = perspectives.find(perspective => perspective.playerId === event.actorPlayerId)
    if (!actor) return null
    const card = (scope === 'full' || actor.playerId === seat?.playerId) ? cardReference(event.card) : null
    return { ...base, type: 'draw', seatId: actor.seatId, actorPlayerId: actor.playerId, text: `${actor.name} drew a card`,
      ...(card ? { card } : {}) }
  }
  const publicLog = projectReplayEvent(event, null)?.log
  if (analysis) return { ...base, type: 'action', seatId: analysis.seatId, text: analysis.actual.text,
    actual: analysis.actual, ...(publicLog ? { log: publicLog } : {}) }
  if (publicLog) return { ...base, type: 'log', text: plainText(publicLog.message), log: publicLog }
  return null
}

function countsFor(rows, positions, visible, revision, fullAvailable, coverage = []) {
  const aggregate = { reviewed: 0, eligible: 0, counts: {}, bySeat: [] }
  for (const seatId of visible) {
    const records = rows.filter(record => record.seat_key === seatId && record.archive_revision === revision
      && (fullAvailable || !record.requires_full))
    const eligible = positions ? positions.filter(position => position.seatId === seatId).length
      : coverage.find(record => record.seat_key === seatId && record.archive_revision === revision)?.eligible ?? null
    const counts = {}
    for (const { category, total } of records) counts[category] = (counts[category] ?? 0) + total
    const reviewed = records.reduce((acc, record) => acc + record.total, 0)
    aggregate.eligible = eligible === null || aggregate.eligible === null ? null : aggregate.eligible + eligible
    aggregate.reviewed += reviewed
    for (const category of categories) if (counts[category]) aggregate.counts[category] = (aggregate.counts[category] ?? 0) + counts[category]
    aggregate.bySeat.push({ seatId, eligible, reviewed, counts })
  }
  return { ...aggregate, status: aggregate.reviewed === 0 ? 'not_started'
    : aggregate.eligible !== null && aggregate.reviewed >= aggregate.eligible ? 'complete' : 'partial' }
}

function aggregateMatches(games) {
  const totals = { reviewed: 0, eligible: 0, counts: {}, bySeat: [] }
  const bySeat = new Map()
  for (const { analysis } of games) {
    totals.reviewed += analysis.reviewed
    totals.eligible = totals.eligible === null || analysis.eligible === null ? null : totals.eligible + analysis.eligible
    for (const data of analysis.bySeat) {
      const seat = bySeat.get(data.seatId) ?? { seatId: data.seatId, reviewed: 0, eligible: 0, counts: {} }
      seat.reviewed += data.reviewed
      seat.eligible = seat.eligible === null || data.eligible === null ? null : seat.eligible + data.eligible
      for (const [category, count] of Object.entries(data.counts)) {
        seat.counts[category] = (seat.counts[category] ?? 0) + count
        totals.counts[category] = (totals.counts[category] ?? 0) + count
      }
      bySeat.set(data.seatId, seat)
    }
  }
  totals.bySeat = [...bySeat.values()]
  return { ...totals, status: totals.reviewed === 0 ? 'not_started'
    : totals.eligible !== null && totals.reviewed >= totals.eligible ? 'complete' : 'partial' }
}

function pageRows(rows, { cursor, count, turn }, project) {
  const events = []
  for (const row of rows) {
    if (row.cursor < cursor || (turn !== null && row.turn !== turn)) continue
    const event = project(row)
    if (!event) continue
    if (events.length === count) return { events, next: row.cursor }
    events.push(event)
  }
  return { events, next: null }
}

export function createPostMatchReview(pool, archive, permissions) {
  const annotations = createReviewAnnotations(pool)

  async function accessGame(actor, game) {
    const access = await permissions.reviewAccess(actor, game.match_id)
    if (!(game.players ?? []).some(({ seatId }) => access.perspectives.some(perspective => perspective.seatId === seatId && perspective.owned)
      || access.viewerSeatId === seatId)) throw new ProductError(404, 'Replay not found')
    return access
  }

  async function loadGame(game, access, readRows = true) {
    const ready = gameReady(game)
    const rows = ready && readRows ? canonicalRows(await archive.readReviewArchive(game)) : []
    const perspectives = gamePerspectives(game, access, rows)
    const typed = game.review_version === 2
    const fullAvailable = canReadTogether(game, access)
    const visible = perspectives.filter(({ owned }) => owned || fullAvailable).map(({ seatId }) => seatId)
    const positions = positionsFor(rows, perspectives, typed)
    return { ready, rows, perspectives, typed, fullAvailable, visible, positions }
  }

  function gameManifest(game, access, data, rows) {
    const archiveRevision = immutableRevision(game)
    const eligiblePositions = data.ready ? data.positions : null
    const archiveStatus = game.archive_state
    const reason = game.match_status === 'active' ? 'match_active' : !data.ready ? 'replay_not_ready'
      : data.fullAvailable ? null : access.reason ?? 'legacy_unavailable'
    return {
      gameId: game.id, matchId: game.match_id, gameNumber: game.game_number, status: game.match_status, gameStatus: game.status,
      format: game.format ?? game.engine_format, viewerSeatId: access.viewerSeatId,
      perspectives: data.perspectives, availablePerspectives: data.perspectives.map(seat => ({ ...seat, allowed: seat.owned || data.fullAvailable })),
      fullAvailable: data.fullAvailable, canGrantLegacy: access.canGrantLegacy, legacyGranted: access.legacyGranted,
      reason,
      privacy: { fullAvailable: data.fullAvailable, canGrantLegacy: access.canGrantLegacy, legacyGranted: access.legacyGranted,
        viewerSeatId: access.viewerSeatId, perspectives: data.perspectives, reason },
      archiveRevision,
      coverage: {
        archive: archiveStatus, version: data.typed ? 2 : 1, partial: archiveStatus !== 'ready' || !data.typed || game.review_incomplete,
        frames: data.rows.filter(({ event }) => !!event.view).length, actions: data.positions.filter(position => data.visible.includes(position.seatId)).length,
        draws: data.typed ? { recorded: data.rows.filter(({ event }) => event.kind === 'draw' && cardReference(event.card)).length,
          total: data.rows.filter(({ event }) => event.kind === 'draw').length }
          : { status: 'unavailable' },
        hands: data.fullAvailable ? 'both_where_recorded' : 'own_where_recorded',
        seatViews: data.typed ? 'where_recorded' : 'own_hand_and_public_board',
      },
      analysis: countsFor(rows, eligiblePositions, data.visible, archiveRevision, data.fullAvailable),
    }
  }

  return {
    async manifest(actor, id) {
      const game = await archive.reviewGame(id)
      const access = await accessGame(actor, game)
      const data = await loadGame(game, access)
      return gameManifest(game, access, data, await annotations.counts([id]))
    },
    async match(actor, matchId) {
      if (!isUuid(matchId)) throw new ProductError(404, 'Match not found')
      const access = await permissions.reviewAccess(actor, matchId)
      const games = await archive.reviewGames(matchId)
      const counts = await annotations.counts(games.map(({ id }) => id))
      const manifests = []
      for (const game of games) {
        if (!(game.players ?? []).some(({ seatId }) => access.perspectives.some(perspective => perspective.seatId === seatId && perspective.owned)
          || access.viewerSeatId === seatId)) continue
        const data = await loadGame(game, access)
        manifests.push(gameManifest(game, access, data, counts.filter(row => row.game_id === game.id)))
      }
      return { matchId, status: access.status, games: manifests, analysis: aggregateMatches(manifests) }
    },
    async evidence(actor, id, query) {
      const game = await archive.reviewGame(id)
      const access = await accessGame(actor, game)
      requireReady(game)
      const archiveRevision = immutableRevision(game)
      checkArchiveRevision(query.archiveRevision, archiveRevision)
      const scope = query.scope ?? 'seat'
      const purpose = query.purpose ?? 'replay'
      const includeBefore = query.includeBefore !== 'false'
      if (!['replay', 'analysis'].includes(purpose) || purpose === 'analysis' && scope === 'full') {
        throw new ProductError(400, 'Analyze pre-action evidence from one seat; use replay purpose for retrospect')
      }
      if (query.includeBefore !== undefined && (!['true', 'false'].includes(query.includeBefore) || scope !== 'public' || purpose !== 'analysis')) {
        throw new ProductError(400, 'Before-state filtering is available for public analysis')
      }
      const options = pageOptions(query)
      scopedSeat(game, access, gamePerspectives(game, access, []), scope, query.seatId)
      const data = await loadGame(game, access)
      const seat = scopedSeat(game, access, data.perspectives, scope, query.seatId)
      const positions = new Map(data.positions.map(position => [position.cursor, position]))
      const events = purpose === 'analysis'
        ? analysisEvidence(data, seat, { ...options, includeBefore })
        : pageRows(data.rows, options, row => projectRow(row, seat, scope, data.perspectives, data.typed, positions.get(row.cursor)))
      return { gameId: id, matchId: game.match_id, archiveRevision, scope, purpose, ...events }
    },
    async listAnnotations(actor, id, query) {
      const game = await archive.reviewGame(id)
      const access = await accessGame(actor, game)
      requireReady(game)
      const data = await loadGame(game, access, false)
      const archiveRevision = immutableRevision(game)
      checkArchiveRevision(query.archiveRevision, archiveRevision)
      const visible = query.seatId === undefined ? data.visible : data.visible.filter(id => id === query.seatId)
      if (!visible.length) throw new ProductError(403, 'Replay perspective is unavailable')
      return { gameId: id, archiveRevision, ...await annotations.read(id, archiveRevision, visible,
        { ...pageOptions(query), fullAvailable: data.fullAvailable }) }
    },
    async saveAnnotations(actor, id, input) {
      const game = await archive.reviewGame(id)
      const access = await accessGame(actor, game)
      requireReady(game)
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProductError(400, 'Supply the archive revision and annotation entries')
      const { archiveRevision: receivedRevision, entries } = input
      const data = await loadGame(game, access)
      const archiveRevision = immutableRevision(game)
      return { gameId: id, archiveRevision, ...await annotations.save({
        game, actor, archiveRevision, receivedRevision, positions: data.positions, seatIds: data.visible,
        fullAvailable: data.fullAvailable, entries,
        authorize: async db => {
          const latest = await permissions.reviewAccess(actor, game.match_id, db)
          if (latest.status !== 'completed' || data.fullAvailable && !canReadTogether(game, latest)
            || entries.some(entry => !data.fullAvailable && !latest.perspectives.some(seat => seat.seatId === entry.seatId && seat.owned))) {
            throw new ProductError(403, 'Replay permission changed')
          }
        },
      }) }
    },
    async withHistory(actor, history) {
      const nowArchived = history.matches.filter(match => match.status === 'completed')
      const gameIds = nowArchived.flatMap(match => match.games.map(game => game.gameId))
      const [counts, coverage] = await Promise.all([annotations.counts(gameIds), annotations.coverage(gameIds)])
      const analyzed = new Set(counts.map(row => row.game_id))
      const matches = await Promise.all(history.matches.map(async match => {
        if (!match.games.some(game => analyzed.has(game.gameId))) {
          return { ...match, analysis: aggregateMatches([]) }
        }
        let access
        try {
          access = await permissions.reviewAccess(actor, match.id)
        } catch (error) {
          if (error.status !== 404) throw error
          return { ...match, analysis: aggregateMatches([]) }
        }
        const games = await archive.reviewGames(match.id)
        const summaries = games.map(game => {
          const full = canReadTogether(game, access)
          const visible = gamePerspectives(game, access, []).filter(seat => seat.owned || full).map(seat => seat.seatId)
          return { gameId: game.id, analysis: countsFor(counts.filter(row => row.game_id === game.id), null, visible,
            immutableRevision(game), full, coverage.filter(row => row.game_id === game.id)) }
        })
        return { ...match, analysis: aggregateMatches(summaries),
          games: match.games.map(game => ({ ...game, analysis: summaries.find(s => s.gameId === game.gameId)?.analysis })) }
      }))
      return { ...history, matches }
    },
  }
}

function analysisEvidence(data, seat, options) {
  const frames = new Map(data.rows.filter(row => row.event.view).map(row => [row.cursor, row.event]))
  return pageRows(data.positions.map(position => ({ ...position, turn: position.evidence.turn })), options, position => {
    if (seat && seat.seatId !== position.seatId) return null
    const frame = frames.get(position.frameCursor)
    if (!frame) return null
    return { ...position, type: 'action', text: position.actual.text,
      ...(options.includeBefore ? { before: frameProjection(frame, seat, data.typed) } : {}) }
  })
}
