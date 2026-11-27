import { matchEndingCauses, replayEndCauses } from './archive.mjs'
import { ProductError } from './decks.mjs'
import { hasTournamentReplayFrame } from './tournament-replay-index.mjs'

const cursorKinds = new Set(['review_cursor', 'spectator_frame'])
const limitationKinds = new Set(['interruption', 'insufficient_evidence'])
const maximumCursor = 2_147_483_647

export function qualityInput(input) {
  const { archiveRevision, goodQuality, qualityReason, qualityAnchor } = input ?? {}
  if (typeof archiveRevision !== 'string' || !/^[a-f0-9]{64}$/.test(archiveRevision) || typeof goodQuality !== 'boolean') {
    throw new ProductError(400, 'Supply the archive revision and a boolean quality verdict')
  }
  if (qualityReason === undefined && qualityAnchor === undefined) return { archiveRevision, goodQuality }
  const reason = typeof qualityReason === 'string' ? qualityReason.replace(/\r\n?/g, '\n').trim() : ''
  const kind = qualityAnchor?.kind
  const hasCursor = cursorKinds.has(kind)
  if (!reason || reason.length > 1200 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(reason)
    || !qualityAnchor || typeof qualityAnchor !== 'object' || Array.isArray(qualityAnchor)
    || Object.keys(qualityAnchor).some(key => key !== 'kind' && !(hasCursor && key === 'cursor'))
    || (hasCursor ? !Number.isInteger(qualityAnchor.cursor) || qualityAnchor.cursor < 0 || qualityAnchor.cursor > maximumCursor
      : goodQuality || !limitationKinds.has(kind))) {
    throw new ProductError(400, 'Supply a quality reason and a supported evidence anchor')
  }
  return { archiveRevision, goodQuality, qualityReason: reason, qualityAnchor }
}

export function ownsGameQuality(game, access) {
  return access.reason !== 'match_not_completed' && game.players?.length === 2 && game.players.every(({ seatId }) =>
    access.perspectives.some(seat => seat.seatId === seatId && seat.owned))
}

export function qualityDetails(row, archiveRevision) {
  if (!row.quality_reason || row.quality_archive_revision !== archiveRevision) return {}
  return {
    qualityReason: row.quality_reason,
    qualityAnchor: { kind: row.quality_anchor_kind,
      ...(row.quality_anchor_cursor != null ? { cursor: row.quality_anchor_cursor } : {}) },
  }
}

export async function verifyQualityArchiveAnchor(records, verdict, isPublicRecord) {
  const { kind, cursor } = verdict.qualityAnchor
  let recordCursor = -1
  let frameCursor = -1
  let anchorTurn = null
  let turn = null
  let found = false
  let ending = null
  // Consume the entire stream to verify the checksum and detect a rolled-back
  // observation. Spectator numbering follows the corresponding replay index.
  for await (const record of records) {
    recordCursor++
    if (record.kind === 'spectatorEnd' && record.terminal === true) {
      ending = replayEndCauses.has(record.cause) ? record.cause : null
    }
    if (kind === 'interruption') continue
    if (kind === 'spectator_frame') {
      if (hasTournamentReplayFrame(record) && ++frameCursor === cursor) found = true
      continue
    }
    if (record.kind === 'rollback' && Number.isSafeInteger(record.turn)) {
      if (found && anchorTurn >= record.turn) found = false
      turn = record.turn
    }
    if (Number.isSafeInteger(record.view?.turn)) turn = record.view.turn
    if (recordCursor === cursor && isPublicRecord(record)) {
      anchorTurn = Number.isSafeInteger(record.turn) ? record.turn : turn
      found = true
    }
  }
  if (kind === 'interruption') found = matchEndingCauses.has(ending)
  if (!found) throw new ProductError(409, 'The quality anchor is unavailable in the current archive')
  if (verdict.goodQuality && matchEndingCauses.has(ending)) {
    throw new ProductError(409, 'The archived game changed or ended with an interruption')
  }
}

export async function storeGameQuality(db, game, verdict, verifiedInterruption) {
  const { archiveRevision, goodQuality, qualityAnchor } = verdict
  const { rows: [prior] } = await db.query(`
    SELECT g.good_quality,g.quality_reason,g.quality_anchor_kind,g.quality_anchor_cursor,g.quality_archive_revision
    FROM games g JOIN matches m ON m.id=g.match_id
    WHERE g.id=$1 AND g.checksum=$3 AND g.object_key IS NOT NULL
      AND g.status='completed' AND m.status='completed'
      AND (NOT $2 OR NOT COALESCE(g.end_cause=ANY($4::text[]),false))
      AND ($5::text IS DISTINCT FROM 'interruption' OR g.end_cause=ANY($4::text[])
        OR ($6 AND g.end_cause IS NULL))
    FOR UPDATE OF g`,
  [game.id, goodQuality, game.checksum, [...matchEndingCauses], qualityAnchor?.kind ?? null, verifiedInterruption])
  if (!prior) throw new ProductError(409, 'The archived game changed or ended with an interruption')
  const details = qualityAnchor ? { qualityReason: verdict.qualityReason, qualityAnchor }
    : prior.good_quality === goodQuality ? qualityDetails(prior, archiveRevision) : {}
  await db.query(`UPDATE games SET good_quality=$2,quality_reason=$3,quality_anchor_kind=$4,
    quality_anchor_cursor=$5,quality_archive_revision=$6 WHERE id=$1`,
  [game.id, goodQuality, details.qualityReason ?? null, details.qualityAnchor?.kind ?? null,
    details.qualityAnchor?.cursor ?? null, details.qualityReason ? archiveRevision : null])
  return { gameId: game.id, archiveRevision, goodQuality, ...details }
}
