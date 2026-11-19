import { createHash } from 'node:crypto'
import { projectReplayEvent } from './archive.mjs'
import { isUuid, normalize, ProductError } from './decks.mjs'
import { categories, createReviewAnnotations } from './review-annotations.mjs'
import { indexReplayPresentation, publicDiscardLinks, publicSourceCard } from './review-presentation.mjs'
import { genericChoiceKinds, indexCommittedDecisions, structuredChoice } from './review-decisions.mjs'
import { submittedSideboardDelta } from './sideboard-delta.mjs'

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
  return gameReady(game) && access.fullAvailable
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

function privateDecision(row, actor, seat, scope, sourceView) {
  const event = row?.event
  if (!event?.decision || (scope !== 'full' && (!seat || seat.playerId !== actor))) return {}
  const { cards, selectedId, selectedIds, prompt, options, choiceKind, sourceCard, passKind, stackSize, endsTurn,
    manaPool, availableManaSources, playableCount } = event.decision
  const numericContext = Object.fromEntries(Object.entries({ stackSize, availableManaSources, playableCount })
    .filter(([, value]) => Number.isSafeInteger(value) && value >= 0))
  const pool = Object.fromEntries(manaSymbols.filter(symbol => Number.isSafeInteger(manaPool?.[symbol])
    && manaPool[symbol] >= 0 && manaPool[symbol] < 1000).map(symbol => [symbol, manaPool[symbol]]))
  const source = cardReference(sourceCard) ?? publicSourceCard(sourceView, event.sourceId)
  const decision = {
    ...(Array.isArray(cards) ? { cards: cards.slice(0, 64).map(cardReference).filter(Boolean) } : {}),
    ...(['mulligan', 'keep'].includes(event.action) && Array.isArray(cards) ? { handKind: 'opening_choice' } : {}),
    ...(isUuid(selectedId) ? { selectedId } : {}),
    ...(Array.isArray(selectedIds) ? { selectedIds: selectedIds.filter(isUuid).slice(0, 64) } : {}),
    ...(typeof prompt === 'string' ? { prompt: plainText(prompt).slice(0, 400) } : {}),
    ...(Array.isArray(options) ? { options: options.filter(option => typeof option === 'string').slice(0, 20).map(option => plainText(option).slice(0, 240)) } : {}),
    ...(['discard', 'bottom'].includes(choiceKind) ? { choiceKind } : {}),
    ...(source ? { sourceCard: source } : {}),
    ...(['manual', 'automatic'].includes(passKind) ? { passKind } : {}),
    ...(typeof endsTurn === 'boolean' ? { endsTurn } : {}),
    ...(Object.keys(pool).length ? { manaPool: pool } : {}),
    ...numericContext,
    ...structuredChoice(row, plainText, cardReference),
  }
  return Object.keys(decision).length ? { decision } : {}
}

function actionDetails(row, perspectives, typed) {
  const { event } = row
  if (typed && event.kind === 'action' && capturedActions.has(event.action)) {
    const seat = perspectives.find(({ playerId }) => playerId === event.actorPlayerId)
    if (!seat) return null
    if (event.action === 'pass') {
      const context = event.decision
      const unspentMana = context?.availableManaSources > 0 || manaSymbols.some(symbol => context?.manaPool?.[symbol] > 0)
      if (!(context?.playableCount > 0) && !(context?.endsTurn === true && unspentMana)) return null
    }
    if (event.action === 'select' && genericChoiceKinds.has(event.decision?.choiceKind)) {
      return { seatId: seat.seatId, basis: 'recorded_action', actual: { kind: 'select', text: `${seat.name} · select` } }
    }
    const card = cardReference(event.card)
    const paidMana = Object.fromEntries(manaSymbols.filter(symbol => Number.isSafeInteger(event.paidMana?.[symbol])
      && event.paidMana[symbol] > 0 && event.paidMana[symbol] < 1000).map(symbol => [symbol, event.paidMana[symbol]]))
    const details = {
      kind: event.action,
      text: card ? `${seat.name} · ${event.action} · ${card.name}` : `${seat.name} · ${event.action}`,
      ...(card ? { card: card.name } : {}),
      ...(event.action !== 'select' && isUuid(event.objectId) ? { objectId: event.objectId } : {}),
      ...(isUuid(event.sourceId) ? { sourceId: event.sourceId } : {}),
      ...(typeof event.fromZone === 'string' ? { fromZone: event.fromZone.slice(0, 30) } : {}),
      ...(Array.isArray(event.targetIds) ? { targetIds: event.targetIds.filter(isUuid).slice(0, 32) } : {}),
      ...(Object.keys(paidMana).length ? { paidMana } : {}),
      ...(Array.isArray(event.modes) ? { modes: event.modes.filter(mode => typeof mode === 'string').slice(0, 10).map(mode => mode.slice(0, 400)) } : {}),
    }
    return { seatId: seat.seatId, basis: 'recorded_action', actual: details, cardRef: card, castMode: plainText(event.castMode).slice(0, 240) }
  }
  if (event.log?.messageType !== 'GAME') return null
  const message = plainText(event.log.message)
  const lower = message.toLowerCase()
  const seat = perspectives.find(({ name }) => lower.startsWith(normalize(name) + ' '))
  if (!seat) return null
  const rest = message.slice(seat.name.length).trimStart()
  const verb = rest.split(/[\s:]+/, 1)[0].toLowerCase()
  const kind = cardActions.get(verb)
  if (!kind) return null
  return { seatId: seat.seatId, basis: 'engine_log', actual: { kind, text: message.slice(0, 1200) } }
}

function positionsFor(rows, perspectives, typed, capture, nestedDecisions) {
  const positions = []
  const frames = new Set()
  const committedChoices = new Map()
  let lastAction = null
  for (const row of rows) {
    if (row.event.view) frames.add(row.cursor)
    if (nestedDecisions.has(row.cursor)) continue
    if (row.frameCursor === null || row.cursor === row.frameCursor) continue
    const details = actionDetails(row, perspectives, typed)
    if (!details) continue
    const event = row.event
    if (typed && event.action === 'select' && event.decision?.choiceKind === 'discard'
      && isUuid(event.sourceId) && isUuid(event.affectedPlayerId)) {
      const ids = Array.isArray(event.decision.selectedIds) ? event.decision.selectedIds : [event.decision.selectedId]
      for (const id of ids.filter(isUuid).slice(0, 64)) {
        committedChoices.set(`${event.affectedPlayerId}:${event.sourceId}:${id}`, row.cursor)
      }
    } else if (typed && details.actual.kind === 'discard' && details.basis === 'engine_log') {
      const { card, source } = publicDiscardLinks(event.log?.message)
      const victim = perspectives.find(seat => seat.seatId === details.seatId)
      const key = victim && card && source ? `${victim.playerId}:${source.id}:${card.id}` : undefined
      if (row.cursor - committedChoices.get(key) <= 128) {
        committedChoices.delete(key)
        continue
      }
    }
    // Captured actions and the human-readable log can describe the same play.
    // Resolve only a neighboring actor/kind pair with no intervening action or
    // frame. Other logs remain available as lower-confidence historical anchors.
    if (lastAction?.seatId === details.seatId && lastAction.actual.kind === details.actual.kind
      && (lastAction.basis === 'recorded_action') !== (details.basis === 'recorded_action')
      && lastAction.frameCursor === row.frameCursor) {
      if (details.basis === 'engine_log') {
        lastAction.actual.text = details.actual.text
        capture.set(lastAction.cursor, { ...capture.get(lastAction.cursor), logMessage: row.event.log?.message })
        lastAction = null
        continue
      }
      details.actual.text = lastAction.actual.text
      details.logMessage = capture.get(lastAction.cursor)?.logMessage
      capture.delete(lastAction.cursor)
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
    capture.set(row.cursor, { cardRef: details.cardRef, castMode: details.castMode, logMessage: details.logMessage ?? row.event.log?.message })
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

function projectRow(row, seat, scope, perspectives, typed, analysis, presentation, decisionContext) {
  const { event, cursor, frameCursor, turn } = row
  const base = { cursor, frameCursor, turn, timeMs: event.t }
  if (event.view) {
    const frame = frameProjection(event, seat, typed)
    if (!frame) return null
    const hands = scope === 'full' ? Object.fromEntries(perspectives.flatMap(perspective => {
      const hand = gameHand(event, perspective, typed)
      return hand && perspective.playerId ? [[perspective.playerId, hand]] : []
    })) : undefined
    return { ...base, type: 'frame', view: frame.view, ...(frame.myHand ? { myHand: frame.myHand } : {}), ...(hands ? { hands } : {}),
      ...(analysis?.actual.kind === 'omission' ? { inferredDecision: analysis } : {}) }
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
  if (analysis) {
    const displayed = presentation(analysis)
    return { ...base, type: 'action', seatId: analysis.seatId, text: analysis.actual.text, ...displayed,
      ...decisionContext(analysis, displayed, seat, scope),
      ...(publicLog ? { log: publicLog } : {}) }
  }
  if (publicLog) return { ...base, type: 'log', text: plainText(publicLog.message), log: publicLog }
  return null
}

function countsFor(rows, positions, visible, revision, fullAvailable, coverage = []) {
  const aggregate = { reviewed: 0, eligible: 0, counts: {}, bySeat: [] }
  for (const seatId of visible) {
    const records = rows.filter(record => record.seat_key === seatId && record.archive_revision === revision
      && (fullAvailable || !record.requires_full))
    const recordedEligible = coverage.find(record => record.seat_key === seatId && record.archive_revision === revision)?.eligible ?? null
    const inferred = records.filter(record => record.evidence_basis === 'inferred_omission').reduce((sum, record) => sum + record.total, 0)
    const eligible = positions ? positions.filter(position => position.seatId === seatId).length
      : recordedEligible === null ? null : recordedEligible + inferred
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

function decisionContextFor(data) {
  const indexes = new Map(data.rows.map((row, index) => [row.cursor, index]))
  function sourceView(row) {
    const frame = row?.event.preActionCursor ?? row?.frameCursor
    return data.rows[indexes.get(frame)]?.event.view
  }
  function legacyKeep(position, actor) {
    if (position.actual.kind !== 'keep' || position.evidence.basis !== 'engine_log' || !actor) return undefined
    const index = indexes.get(position.cursor)
    for (const { event } of data.rows.slice(index + 1, index + 65)) {
      if (event.view?.turn >= 1) {
        if (event.view.turn !== 1 || !['UNTAP', 'UPKEEP'].includes(event.view.step)) return undefined
        const hand = gameHand(event, actor, data.typed)
        const cards = Object.entries(hand ?? {}).map(([id, card]) => cardReference({ id, name: card.name,
          setCode: card.expansionSetCode, cardNumber: card.cardNumber })).filter(Boolean)
        return cards.length && cards.length === Object.keys(hand).length ? { cards, handKind: 'kept_hand' } : undefined
      }
      if (event.kind === 'draw' && event.actorPlayerId === actor.playerId) return undefined
      if (event.kind === 'action' && !['mulligan', 'keep'].includes(event.action)) return undefined
      if (event.log?.messageType === 'GAME') {
        const message = plainText(event.log.message)
        const sameActor = message.toLowerCase().startsWith(actor.name.toLowerCase() + ' ')
        if (sameActor && /^\s*(?:draws|discards|casts|plays|activates|puts)\b/i.test(message.slice(actor.name.length))) return undefined
      }
    }
  }
  function decisionContext(position, displayed, seat, scope) {
    const actor = data.perspectives.find(player => player.seatId === (displayed.decisionSeatId ?? position.seatId))
    const row = data.rows[indexes.get(position.cursor)]
    const linked = data.linkedDecisions.byParent.get(position.cursor) ?? []
    const hasDecisionContext = data.typed && (!!row?.event.decision || linked.length > 0)
    const hint = hasDecisionContext ? { hasDecisionContext } : {}
    if (linked.length) {
      const decisions = linked.flatMap(child => {
        const chooserId = child.event.decisionPlayerId ?? child.event.actorPlayerId
        const { decision } = privateDecision(child, chooserId, seat, scope, sourceView(child))
        return decision ? [decision] : []
      })
      if (decisions.length) return { ...hint, decision: decisions[0], decisions }
    }
    if (!actor || (scope !== 'full' && seat?.seatId !== actor.seatId)) return hint
    const context = data.typed ? privateDecision(row, actor.playerId, seat, scope, sourceView(row)) : {}
    if (context.decision) return { ...hint, ...context }
    const kept = legacyKeep(position, actor)
    return kept ? { decision: kept } : hint
  }
  return { decisionContext, legacyKeep }
}

const omittedKind = 'omission'
const omittedBasis = 'inferred_omission'
const maximumOpportunityWindow = 128
const opportunityTransitions = new Map([
  ['before_combat', ['PRECOMBAT_MAIN', 'BEGIN_COMBAT']],
  ['before_end_turn', ['POSTCOMBAT_MAIN', 'END_TURN']],
])

function inferredPosition(row, seat, through, window, opening) {
  return { cursor: row.cursor, frameCursor: row.cursor, seatId: seat.seatId,
    actual: { kind: omittedKind, text: `${seat.name} · ${omittedKind}` },
    evidence: { frameCursor: row.cursor, turn: row.turn, basis: omittedBasis,
      frameQuality: 'preceding_snapshot', observedThroughCursor: through,
      ...(window ? { window, openingCursor: opening } : {}) } }
}

function validatedOmission(entry, data, rowByCursor, existing) {
  const { observedThroughCursor, opportunityObjectId, window, openingCursor } = entry.omission ?? {}
  const { cursor, seatId } = entry
  const marker = rowByCursor.get(cursor)
  const seat = data.perspectives.find(player => player.seatId === seatId)
  const end = rowByCursor.get(observedThroughCursor)
  const opening = window && data.positions.find(position => position.cursor === openingCursor)
  const start = opening ? rowByCursor.get(opening.frameCursor) : marker
  const startView = start?.event.view
  const endView = end?.event.view
  const transition = opportunityTransitions.get(window)
  const stepChanged = typeof endView?.step === 'string' && typeof startView?.step === 'string' && endView.step !== startView.step
  const nextPriority = normalize(endView?.priorityPlayerName ?? '')
  const witnessedWindow = window === undefined
    ? observedThroughCursor > cursor && normalize(startView?.priorityPlayerName ?? '') === seatId
      && (stepChanged || nextPriority && nextPriority !== seatId)
    : transition && opening && opening.seatId === seatId
      && ['land', 'cast', 'activate'].includes(opening.actual.kind) && opening.cursor < cursor
      && observedThroughCursor === cursor && startView?.step === transition[0] && endView?.step === transition[1]
      && normalize(startView?.activePlayerName ?? '') === seatId && normalize(endView?.activePlayerName ?? '') === seatId
  const openingAnchor = opening?.cursor ?? cursor
  if (!Number.isSafeInteger(observedThroughCursor) || !isUuid(opportunityObjectId) || !seat || !marker?.event.view || !startView || !endView
    || existing && existing.actual.kind !== omittedKind
    || observedThroughCursor - openingAnchor > maximumOpportunityWindow || start.turn !== end.turn || !witnessedWindow) {
    throw new ProductError(400, 'An inferred omission requires a witnessed priority window')
  }
  if (data.positions.some(position => position.actual.kind !== omittedKind && position.seatId === seatId
    && position.cursor > openingAnchor && position.cursor <= observedThroughCursor)) {
    throw new ProductError(400, 'Review the recorded decision in that priority window')
  }
  const hand = gameHand(marker.event, seat, data.typed)
  const controlled = marker.event.view.players?.find(player => player.playerId === seat.playerId)?.battlefield
  if (!hand?.[opportunityObjectId] && !controlled?.[opportunityObjectId]) {
    throw new ProductError(400, 'The opportunity was not visible in the acting seat at that cursor')
  }
  return inferredPosition(marker, seat, observedThroughCursor, window, opening?.cursor)
}

function entriesWithEvidence(entries, data, rowByCursor, positions, presentation, legacyKeep) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 24) return entries
  return entries.map(entry => {
    if (!entry || typeof entry !== 'object') return entry
    const position = positions.get(entry.cursor)
    if (entry.omission !== undefined) {
      if (!data.visible.includes(entry.seatId)) throw new ProductError(403, 'The requested replay perspective is unavailable')
      const omission = validatedOmission(entry, data, rowByCursor, position)
      positions.set(entry.cursor, omission)
    } else if (position?.actual.kind === omittedKind) {
      throw new ProductError(400, 'Resend the witnessed opportunity to edit an inferred omission')
    }
    const current = positions.get(entry.cursor)
    const displayed = position && presentation(position)
    if (displayed?.decisionSeatId === entry.seatId && entry.seatId !== position.seatId) {
      if (!data.visible.includes(entry.seatId)) throw new ProductError(403, 'The requested replay perspective is unavailable')
      entry = { ...entry, seatId: position.seatId }
    }
    if (entry.decisionEvidence !== undefined) {
      const { observationCursor, summary } = entry.decisionEvidence ?? {}
      const observed = rowByCursor.get(observationCursor)
      const sameAction = observationCursor === current?.cursor
      if (!current || !observed || !Number.isSafeInteger(observationCursor)
        || observationCursor < current.frameCursor || observationCursor > current.cursor
        || observed.turn !== current.evidence.turn || !sameAction && !projectReplayEvent(observed.event, null)) {
        throw new ProductError(400, 'Decision evidence must refer to an observed event in the pre-action window')
      }
      return { ...entry, decisionEvidence: { observationCursor, summary } }
    }
    if (Number.isSafeInteger(entry.expectedRevision) && position?.evidence.frameQuality === 'coalesced_snapshot'
      && Array.isArray(entry.alternatives) && entry.alternatives.some(option => option?.legality === 'confirmed')) {
      const card = displayed.actual.cardRef
      if (card && ['cast', 'land', 'activate', 'discard'].includes(position.actual.kind)) {
        return { ...entry, decisionEvidence: { observationCursor: position.cursor, summary: `The archived action identifies ${card.name}.` } }
      }
      const seat = data.perspectives.find(seat => seat.seatId === entry.seatId)
      if (data.visible.includes(entry.seatId) && legacyKeep(position, seat)) {
        return { ...entry, decisionEvidence: { observationCursor: position.cursor,
          summary: 'The first upkeep frame preserves the kept hand before any recorded play or draw by this seat.' } }
      }
    }
    return entry
  })
}

function noteWithChooser(note, positions, presentation) {
  const position = positions.get(note.cursor)
  const displayed = position?.actual.kind === 'discard' && presentation(position)
  if (!displayed?.decisionSeatId) return note
  return { ...note, decisionSeatId: displayed.decisionSeatId,
    decisionActor: displayed.decisionActor, decisionActorPlayerId: displayed.decisionActorPlayerId }
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
    const capture = new Map()
    const linkedDecisions = indexCommittedDecisions(rows, typed)
    const positions = positionsFor(rows, perspectives, typed, capture, linkedDecisions.nested)
    if (ready && readRows) {
      const byCursor = new Map(rows.map(row => [row.cursor, row]))
      for (const item of await annotations.omissions(game.id, immutableRevision(game), visible, fullAvailable)) {
        const row = byCursor.get(item.event_cursor)
        const seat = perspectives.find(player => player.seatId === item.seat_key)
        if (row?.event.view && seat) positions.push(inferredPosition(row, seat, item.observed_through_cursor,
          item.opportunity_window, item.opportunity_opening_cursor))
      }
      positions.sort((a, b) => a.cursor - b.cursor)
    }
    return { ready, rows, perspectives, typed, fullAvailable, visible, positions, capture, linkedDecisions }
  }

  async function gameManifest(game, access, data, rows) {
    const archiveRevision = immutableRevision(game)
    const eligiblePositions = data.ready ? data.positions : null
    const chooserByCursor = new Map()
    const discards = data.positions.filter(position => position.actual.kind === 'discard' && position.evidence.basis === 'engine_log')
    if (discards.length) {
      const display = indexReplayPresentation(data.rows, data.positions, data.perspectives, data.capture)
      for (const position of discards) {
        const chooser = display(position).decisionSeatId
        if (chooser && data.visible.includes(chooser) && data.visible.includes(position.seatId)) chooserByCursor.set(position.cursor, chooser)
      }
    }
    const positionsForCounts = chooserByCursor.size ? eligiblePositions.map(position =>
      ({ ...position, seatId: chooserByCursor.get(position.cursor) ?? position.seatId })) : eligiblePositions
    const rowsForCounts = chooserByCursor.size ? rows.map(row =>
      ({ ...row, seat_key: chooserByCursor.get(row.event_cursor) ?? row.seat_key })) : rows
    const archiveStatus = game.archive_state
    const reason = game.match_status === 'active' ? 'match_active' : !data.ready ? 'replay_not_ready'
      : data.fullAvailable ? null : access.reason ?? 'replay_not_ready'
    let sideboardDelta = { status: 'unavailable' }
    if (data.ready && data.perspectives.some(seat => seat.owned && seat.seatId === access.viewerSeatId)) {
      sideboardDelta = game.game_number === 1 ? { status: 'initial_game' }
        : submittedSideboardDelta(await archive.reviewOwnDeckPair(game.id, access.viewerSeatId))
    }
    return {
      gameId: game.id, matchId: game.match_id, gameNumber: game.game_number, status: game.match_status, gameStatus: game.status,
      format: game.format ?? game.engine_format, viewerSeatId: access.viewerSeatId,
      perspectives: data.perspectives, availablePerspectives: data.perspectives.map(seat => ({ ...seat, allowed: seat.owned || data.fullAvailable })),
      fullAvailable: data.fullAvailable,
      reason,
      privacy: { fullAvailable: data.fullAvailable,
        viewerSeatId: access.viewerSeatId, perspectives: data.perspectives, reason },
      archiveRevision,
      sideboardDelta,
      coverage: {
        archive: archiveStatus, version: data.typed ? 2 : 1, partial: archiveStatus !== 'ready' || !data.typed || game.review_incomplete,
        frames: data.rows.filter(({ event }) => !!event.view).length, actions: data.positions.filter(position => data.visible.includes(position.seatId)).length,
        draws: data.typed ? { recorded: data.rows.filter(({ event }) => event.kind === 'draw' && cardReference(event.card)).length,
          total: data.rows.filter(({ event }) => event.kind === 'draw').length }
          : { status: 'unavailable' },
        hands: data.fullAvailable ? 'both_where_recorded' : 'own_where_recorded',
        seatViews: data.typed ? 'where_recorded' : 'own_hand_and_public_board',
      },
      analysis: countsFor(rowsForCounts, positionsForCounts, data.visible, archiveRevision, data.fullAvailable),
    }
  }

  return {
    async manifest(actor, id) {
      const game = await archive.reviewGame(id)
      const access = await accessGame(actor, game)
      const data = await loadGame(game, access)
      return gameManifest(game, access, data, await annotations.counts([id], true))
    },
    async match(actor, matchId) {
      if (!isUuid(matchId)) throw new ProductError(404, 'Match not found')
      const access = await permissions.reviewAccess(actor, matchId)
      const games = await archive.reviewGames(matchId)
      const counts = await annotations.counts(games.map(({ id }) => id), true)
      const manifests = []
      for (const game of games) {
        if (!(game.players ?? []).some(({ seatId }) => access.perspectives.some(perspective => perspective.seatId === seatId && perspective.owned)
          || access.viewerSeatId === seatId)) continue
        const data = await loadGame(game, access)
        manifests.push(await gameManifest(game, access, data, counts.filter(row => row.game_id === game.id)))
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
      const presentation = indexReplayPresentation(data.rows, data.positions, data.perspectives, data.capture)
      const { decisionContext } = decisionContextFor(data)
      const events = purpose === 'analysis'
        ? analysisEvidence(data, seat, { ...options, includeBefore }, presentation, decisionContext)
        : pageRows(data.rows, options, row => projectRow(row, seat, scope, data.perspectives, data.typed, positions.get(row.cursor), presentation, decisionContext))
      return { gameId: id, matchId: game.match_id, archiveRevision, scope, purpose, ...events }
    },
    async listAnnotations(actor, id, query) {
      const game = await archive.reviewGame(id)
      const access = await accessGame(actor, game)
      requireReady(game)
      const permissionsOnly = await loadGame(game, access, false)
      const archiveRevision = immutableRevision(game)
      checkArchiveRevision(query.archiveRevision, archiveRevision)
      const visible = query.seatId === undefined ? permissionsOnly.visible : permissionsOnly.visible.filter(id => id === query.seatId)
      if (!visible.length) throw new ProductError(403, 'Replay perspective is unavailable')
      const result = await annotations.read(id, archiveRevision, permissionsOnly.visible,
        { ...pageOptions(query), fullAvailable: permissionsOnly.fullAvailable })
      if (!result.annotations.some(note => note.actual.kind === 'discard')) {
        return { gameId: id, archiveRevision, ...result, annotations: result.annotations.filter(note => visible.includes(note.seatId)) }
      }
      const data = await loadGame(game, access)
      const presentation = indexReplayPresentation(data.rows, data.positions, data.perspectives, data.capture)
      const positions = new Map(data.positions.map(position => [position.cursor, position]))
      const notes = result.annotations.map(note => noteWithChooser(note, positions, presentation))
        .filter(note => visible.includes(note.decisionSeatId ?? note.seatId))
      return { gameId: id, archiveRevision, ...result, annotations: notes }
    },
    async saveAnnotations(actor, id, input) {
      const game = await archive.reviewGame(id)
      const access = await accessGame(actor, game)
      requireReady(game)
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProductError(400, 'Supply the archive revision and annotation entries')
      const { archiveRevision: receivedRevision, entries } = input
      const data = await loadGame(game, access)
      const archiveRevision = immutableRevision(game)
      checkArchiveRevision(receivedRevision, archiveRevision)
      const positionMap = new Map(data.positions.map(position => [position.cursor, position]))
      const displayed = indexReplayPresentation(data.rows, data.positions, data.perspectives, data.capture)
      const { legacyKeep } = decisionContextFor(data)
      const validatedEntries = entriesWithEvidence(entries, data, new Map(data.rows.map(row => [row.cursor, row])), positionMap, displayed, legacyKeep)
      const result = await annotations.save({
        game, actor, archiveRevision, receivedRevision, positions: [...positionMap.values()], seatIds: data.visible,
        fullAvailable: data.fullAvailable, entries: validatedEntries,
        authorize: async db => {
          const latest = await permissions.reviewAccess(actor, game.match_id, db)
          if (latest.status !== 'completed' || data.fullAvailable && !canReadTogether(game, latest)
            || entries.some(entry => !data.fullAvailable && !latest.perspectives.some(seat => seat.seatId === entry.seatId && seat.owned))) {
            throw new ProductError(403, 'Replay permission changed')
          }
        },
      })
      return { gameId: id, archiveRevision, ...result,
        annotations: result.annotations.map(note => noteWithChooser(note, positionMap, displayed)) }
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

function analysisEvidence(data, seat, options, presentation, decisionContext) {
  const frames = new Map(data.rows.filter(row => row.event.view).map(row => [row.cursor, row.event]))
  return pageRows(data.positions.map(position => ({ ...position, turn: position.evidence.turn })), options, position => {
    const displayed = presentation(position)
    if (seat && seat.seatId !== (displayed.decisionSeatId ?? position.seatId)) return null
    const frame = frames.get(position.frameCursor)
    if (!frame) return null
    return { ...position, type: 'action', text: position.actual.text, ...displayed,
      ...decisionContext(position, displayed, seat, 'seat'),
      ...(options.includeBefore ? { before: frameProjection(frame, seat, data.typed) } : {}) }
  })
}
