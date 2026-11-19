import { createHash, randomUUID } from 'node:crypto'
import { isUuid, normalize, ProductError } from './decks.mjs'
import { runTheoryStudy } from './theory-study.mjs'
import { searchTacticalTree } from './theory-tactics.mjs'
import { solveOrdinaryCombat } from './theory-combat.mjs'

function invalid(message) { throw new ProductError(400, message) }

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function studyAnchor(value) {
  if (value === undefined) return null
  if (!record(value) || !isUuid(value.gameId) || typeof value.archiveRevision !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.archiveRevision)
    || !Number.isInteger(value.cursor) || value.cursor < 0 || value.cursor > 2_147_483_647
    || typeof value.seatId !== 'string' || !/^[a-z0-9][a-z0-9 ._:'-]{0,95}$/.test(value.seatId)) {
    invalid('Use a recorded game, archive revision, action cursor and seat for a study link.')
  }
  return { gameId: value.gameId.toLowerCase(), archiveRevision: value.archiveRevision, cursor: value.cursor, seatId: value.seatId }
}

function namesMatch(observed, declared) {
  if (observed.length !== declared.length || [...observed, ...declared].some(name => typeof name !== 'string' || !name)) return false
  declared.sort()
  return observed.sort().every((name, index) => name === declared[index])
}

function verifyPosition(study, event) {
  const { position, cards } = study
  if (position === undefined) return { basis: 'public_hypothesis', interpretation: 'illustrative' }
  const { view, myHand } = event.before
  const seat = view?.players?.find(player => normalize(player.name ?? '') === event.seatId)
  const active = seat && (view.activePlayerId && seat.playerId
    ? view.activePlayerId === seat.playerId : normalize(view.activePlayerName ?? '') === event.seatId)
  if (!active || !['PRECOMBAT_MAIN', 'POSTCOMBAT_MAIN'].includes(view.step) || view.turn !== position.turn
    || !record(myHand) || !record(seat.battlefield) || !Array.isArray(cards) || !Array.isArray(position.hand)
    || !Array.isArray(position.lands)) invalid('Use the acting seat’s recorded hand and lands during its main phase.')
  const names = new Map(cards.filter(record).map(card => [card.id, card.name ?? card.id]))
  const battlefield = Object.values(seat.battlefield)
  if (battlefield.some(card => !Array.isArray(card?.cardTypes))) invalid('The replay frame lacks the land types needed to verify this position.')
  const lands = battlefield.filter(card => card.cardTypes.includes('LAND'))
  if (lands.some(card => typeof card.name !== 'string' || typeof card.tapped !== 'boolean')
    || !namesMatch(Object.values(myHand).map(card => card?.name), position.hand.map(id => names.get(id)))
    || !namesMatch(lands.map(card => JSON.stringify([card.name, card.tapped])),
      position.lands.map(land => names.has(land?.id) && JSON.stringify([names.get(land.id), land.tapped])))) {
    invalid('The declared hand or lands differ from the acting seat’s recorded pre-action frame.')
  }
  return { basis: 'observed_frame', frameQuality: event.evidence?.frameQuality ?? 'unavailable',
    verified: ['acting_seat', 'turn', 'hand_card_names', 'land_card_names', 'land_tapped_status'],
    assumptions: ['Card costs and mana abilities', 'Land drop availability', 'Library composition and order', 'Opponent responses'] }
}

function anchorFromRow(row) {
  return row.game_id === null ? null : {
    gameId: row.game_id, archiveRevision: row.archive_revision, cursor: row.event_cursor, seatId: row.seat_key,
  }
}

function studyReceipt(row) {
  const anchor = anchorFromRow(row)
  return { studyId: row.id, ...(anchor ? { anchor } : {}), result: row.result }
}

function modelResult(run, model, message) {
  if (!record(model)) invalid(message)
  try {
    return run(model)
  } catch (error) {
    invalid(error?.constructor === Error ? error.message : message)
  }
}

export function evaluateTheoryTactics(input) {
  if (!record(input) || (input.graph === undefined) === (input.combat === undefined)) {
    invalid('Supply exactly one bounded graph or ordinary combat model.')
  }
  if (input.combat !== undefined) {
    return { objective: 'lethal_this_turn',
      ...modelResult(solveOrdinaryCombat, input.combat, 'Supply a valid ordinary combat model.') }
  }
  return modelResult(searchTacticalTree, input.graph, 'Supply a valid bounded decision tree.')
}

export function createTheoryStore(pool, review) {
  async function verifyAnchor(actor, anchor) {
    if (!anchor) return
    if (!review) throw new ProductError(409, 'Archived study links require replay review.')
    const { gameId, archiveRevision, cursor, seatId } = anchor
    const page = await review.evidence(actor, gameId, {
      archiveRevision, cursor, seatId, scope: 'seat', purpose: 'analysis', count: 1,
    })
    const event = page.events?.[0]
    if (page.gameId !== gameId || page.archiveRevision !== archiveRevision || event?.cursor !== cursor
      || event?.seatId !== seatId || !record(event?.before)) {
      throw new ProductError(404, 'That exact authorized pre-action annotation is unavailable.')
    }
    return event
  }

  async function read(actor, studyId) {
    if (!isUuid(studyId)) throw new ProductError(404, 'Theory study not found.')
    const { rows: [row] } = await pool.query(
      'SELECT * FROM theory_studies WHERE account_id=$1 AND id=$2', [actor.accountId, studyId],
    )
    if (!row) throw new ProductError(404, 'Theory study not found.')
    await verifyAnchor(actor, anchorFromRow(row))
    return studyReceipt(row)
  }

  async function retry(actor, requestId, hash) {
    const { rows: [row] } = await pool.query(
      'SELECT id, request_hash FROM theory_studies WHERE account_id=$1 AND request_id=$2', [actor.accountId, requestId],
    )
    if (!row) return undefined
    if (row.request_hash !== hash) throw new ProductError(409, 'That request ID belongs to different study inputs.')
    return read(actor, row.id)
  }

  async function save(actor, input) {
    if (!record(input) || !record(input.study)) invalid('Supply a model under study.')
    const { requestId, study } = input
    if (requestId !== undefined && !isUuid(requestId)) invalid('A study request ID must be a UUID.')
    const anchor = studyAnchor(input.anchor)
    let hash
    try { hash = createHash('sha256').update(JSON.stringify([study, anchor])).digest('hex') }
    catch { invalid('The model is too deeply nested.') }
    if (requestId) {
      const existing = await retry(actor, requestId, hash)
      if (existing) return existing
    }
    const event = await verifyAnchor(actor, anchor)
    const result = modelResult(runTheoryStudy, study, 'Supply a valid Monte Carlo model.')
    if (event) result.replayContext = verifyPosition(study, event)
    const { rows: [row] } = await pool.query(
      `INSERT INTO theory_studies(id,account_id,request_id,request_hash,game_id,archive_revision,event_cursor,seat_key,result)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(account_id,request_id) DO NOTHING RETURNING *`,
      [randomUUID(), actor.accountId, requestId ?? null, hash, anchor?.gameId ?? null,
        anchor?.archiveRevision ?? null, anchor?.cursor ?? null, anchor?.seatId ?? null, result],
    )
    return row ? studyReceipt(row) : retry(actor, requestId, hash)
  }

  async function attachAnnotationLinks(actor, page) {
    if (!page?.annotations?.length) return page
    const { rows } = await pool.query(
      `SELECT id, event_cursor, seat_key FROM theory_studies
       WHERE account_id=$1 AND game_id=$2 AND archive_revision=$3 AND event_cursor=ANY($4::integer[])
       ORDER BY id`,
      [actor.accountId, page.gameId, page.archiveRevision, page.annotations.map(annotation => annotation.cursor)],
    )
    return {
      ...page,
      annotations: page.annotations.map(annotation => {
        const links = rows.filter(row => row.event_cursor === annotation.cursor && row.seat_key === annotation.seatId)
          .map(row => ({ studyId: row.id, tool: 'get_theory_study' }))
        return links.length ? { ...annotation, theoryStudies: links } : annotation
      }),
    }
  }

  return { save, read, attachAnnotationLinks }
}
