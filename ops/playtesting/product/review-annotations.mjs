import { createHash } from 'node:crypto'
import { ProductError, transaction } from './decks.mjs'

export const categories = ['brilliant', 'best', 'good', 'acceptable', 'inaccuracy', 'blunder', 'equivalent', 'insufficient', 'unrated']
const assessmentCategories = new Map(Object.entries({
  exceptional: 'brilliant', optimal: 'best', sound: 'good', acceptable: 'acceptable',
  small_loss: 'inaccuracy', decisive_loss: 'blunder', equivalent: 'equivalent', insufficient: 'insufficient', trivial: 'unrated',
}))
const confidenceLevels = new Set(['low', 'medium', 'high'])
const alternativeKinds = new Set(['confirmed', 'conditional', 'unverified'])
const responseKinds = new Set(['public_observed', 'plausible'])
const maximumEntries = 24
const rubricVersion = 1

function invalid() {
  throw new ProductError(400, 'Supply a valid assessment, confidence, supporting lines and replay event')
}

function text(value, max = 900) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) invalid()
  return value.trim()
}

function declaredList(value, limit, entry) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > limit) invalid()
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid()
    return entry(item)
  })
}

function sourceUrl(value) {
  try {
    const url = new URL(text(value, 400))
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) || /\.(local|internal|test|invalid|localhost)$/i.test(url.hostname)) invalid()
    return url.href
  } catch {
    invalid()
  }
}

function sourceDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid()
  const date = new Date(value + 'T00:00:00Z')
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value || Number(value.slice(0, 4)) < 1993) invalid()
  return value
}

function normalizeReview(entry, position, canSeeRetrospective) {
  const { confidence, assessment, expectedRevision } = entry
  if (!confidenceLevels.has(confidence) || !assessmentCategories.has(assessment)
    || expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) invalid()
  if (entry.retrospective !== undefined && !canSeeRetrospective) throw new ProductError(403, 'Retrospective notes require full replay access')
  const alternatives = declaredList(entry.alternatives, 3, option => {
    if (!alternativeKinds.has(option.legality) || option.legality === 'conditional' && option.condition === undefined) invalid()
    return {
      line: text(option.line), legality: option.legality,
      ...(option.condition === undefined ? {} : { condition: text(option.condition, 400) }),
      benefit: text(option.benefit), risk: text(option.risk),
    }
  })
  const opponentResponses = declaredList(entry.opponentResponses, 3, response => {
    if (!responseKinds.has(response.basis)) invalid()
    return { line: text(response.line), basis: response.basis, impact: text(response.impact) }
  })
  const sources = declaredList(entry.sources, 4, source => ({
    url: sourceUrl(source.url), date: sourceDate(source.date), format: text(source.format, 120), applicability: text(source.applicability, 500),
  }))
  const comparison = alternatives.some(option => option.legality === 'confirmed')
  if (assessment === 'trivial' && position.actual.kind !== 'pass') invalid()
  if (assessment === 'exceptional' && (confidence !== 'high' || !comparison || !opponentResponses.length
    || position.evidence.frameQuality !== 'exact')) invalid()
  if (['optimal', 'equivalent', 'small_loss', 'decisive_loss'].includes(assessment) && !comparison) invalid()
  const assessedConfidence = position.evidence.frameQuality === 'coalesced_snapshot' ? 'low'
    : position.evidence.frameQuality !== 'exact' && confidence === 'high' ? 'medium' : confidence
  const category = assessedConfidence === 'low' && assessment !== 'trivial' ? 'insufficient' : assessmentCategories.get(assessment)
  const review = {
    ...position, category, confidence: assessedConfidence, rubricVersion, alternatives, opponentResponses, sources,
    rationale: text(entry.rationale), benefit: text(entry.benefit), risk: text(entry.risk),
    retrospective: entry.retrospective === undefined ? null : text(entry.retrospective),
  }
  const contentHash = createHash('sha256').update(JSON.stringify(review)).digest('hex')
  return { ...review, contentHash, expectedRevision, requiresFull: canSeeRetrospective }
}

function display(row, fullAvailable) {
  const { game_id: gameId, event_cursor: cursor, frame_cursor: frameCursor, seat_key: seatId,
    revision, rubric_version: rubricVersion, category, confidence, evidence_basis: basis, frame_quality: frameQuality, turn,
    action_kind: kind, action_text: actionText, action_card: card,
    rationale, benefit, risk, alternatives, opponentResponses, sources, retrospective } = row
  return {
    gameId, cursor, frameCursor, seatId, revision, rubricVersion, category, confidence,
    actual: { kind, text: actionText, ...(card ? { card } : {}) }, evidence: { basis, frameCursor, frameQuality, turn },
    rationale, benefit, risk, alternatives, opponentResponses, sources, ...(fullAvailable && retrospective ? { retrospective } : {}),
  }
}

const selectAnnotations = `
  SELECT a.*,
    COALESCE((SELECT json_agg(json_strip_nulls(json_build_object('line',c.line,'legality',c.legality,'condition',c.condition,
      'benefit',c.benefit,'risk',c.risk)) ORDER BY c.position) FROM review_alternatives c WHERE c.annotation_id=a.id), '[]') AS alternatives,
    COALESCE((SELECT json_agg(json_build_object('line',c.line,'basis',c.basis,'impact',c.impact) ORDER BY c.position)
      FROM review_opponent_responses c WHERE c.annotation_id=a.id), '[]') AS "opponentResponses",
    COALESCE((SELECT json_agg(json_build_object('url',c.url,'date',c.source_date,'format',c.format,'applicability',c.applicability)
      ORDER BY c.position) FROM review_sources c WHERE c.annotation_id=a.id), '[]') AS sources
  FROM review_annotations a`

async function saveChildren(db, id, entry) {
  await db.query('DELETE FROM review_alternatives WHERE annotation_id=$1', [id])
  await db.query('DELETE FROM review_opponent_responses WHERE annotation_id=$1', [id])
  await db.query('DELETE FROM review_sources WHERE annotation_id=$1', [id])
  for (const [i, item] of entry.alternatives.entries()) {
    await db.query('INSERT INTO review_alternatives VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, i, item.line, item.legality, item.condition ?? null, item.benefit, item.risk])
  }
  for (const [i, item] of entry.opponentResponses.entries()) {
    await db.query('INSERT INTO review_opponent_responses VALUES ($1,$2,$3,$4,$5)', [id, i, item.line, item.basis, item.impact])
  }
  for (const [i, item] of entry.sources.entries()) {
    await db.query('INSERT INTO review_sources VALUES ($1,$2,$3,$4,$5,$6)', [id, i, item.url, item.date, item.format, item.applicability])
  }
}

async function saveAnnotation(db, gameId, archiveRevision, accountId, entry) {
  const { rows: [stored] } = await db.query(
    'SELECT id,revision,content_hash,requires_full FROM review_annotations WHERE game_id=$1 AND archive_revision=$2 AND seat_key=$3 AND event_cursor=$4 FOR UPDATE',
    [gameId, archiveRevision, entry.seatId, entry.cursor],
  )
  if (stored?.requires_full && !entry.requiresFull) throw new ProductError(403, 'Full review permission is required for this annotation')
  if (stored?.content_hash === entry.contentHash) return stored.id
  if (stored ? entry.expectedRevision !== stored.revision : entry.expectedRevision !== undefined) {
    throw new ProductError(409, 'The review annotation changed. Read its current revision before editing')
  }
  const values = [
    entry.frameCursor, accountId, entry.rubricVersion, entry.contentHash, entry.category, entry.confidence,
    entry.actual.kind, entry.actual.text, entry.actual.card ?? null, entry.evidence.turn, entry.evidence.basis,
    entry.rationale, entry.benefit, entry.risk, entry.retrospective, entry.requiresFull, entry.evidence.frameQuality,
  ]
  const statement = stored ? [
    `UPDATE review_annotations SET frame_cursor=$1,reviewer_account_id=$2,rubric_version=$3,content_hash=$4,category=$5,
       confidence=$6,action_kind=$7,action_text=$8,action_card=$9,turn=$10,evidence_basis=$11,rationale=$12,benefit=$13,
       risk=$14,retrospective=$15,requires_full=(requires_full OR $16),frame_quality=$17,
       revision=revision+1,updated_at=now() WHERE id=$18 RETURNING id`,
    [...values, stored.id],
  ] : [
    `INSERT INTO review_annotations (frame_cursor,reviewer_account_id,rubric_version,content_hash,category,confidence,
       action_kind,action_text,action_card,turn,evidence_basis,rationale,benefit,risk,retrospective,requires_full,frame_quality,
       game_id,archive_revision,seat_key,event_cursor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id`,
    [...values, gameId, archiveRevision, entry.seatId, entry.cursor],
  ]
  const { rows: [{ id }] } = await db.query(...statement)
  await saveChildren(db, id, entry)
  return id
}

export function createReviewAnnotations(pool) {
  return {
    async read(gameId, archiveRevision, seatIds, { cursor, count, turn, fullAvailable }) {
      const { rows } = await pool.query(
        selectAnnotations + ` WHERE a.game_id=$1 AND a.archive_revision=$2 AND a.seat_key=ANY($3::text[])
         AND a.event_cursor >= $4 AND ($5::int IS NULL OR a.turn=$5) AND ($6 OR NOT a.requires_full)
         ORDER BY a.event_cursor LIMIT $7`,
        [gameId, archiveRevision, seatIds, cursor, turn ?? null, fullAvailable, count + 1],
      )
      return { annotations: rows.slice(0, count).map(row => display(row, fullAvailable)), next: rows[count]?.event_cursor ?? null }
    },
    async save({ game, actor, archiveRevision, receivedRevision, positions, seatIds, fullAvailable, authorize, entries }) {
      if (typeof receivedRevision !== 'string' || receivedRevision !== archiveRevision) {
        throw new ProductError(409, 'Replay archive changed. Open the current review evidence before saving')
      }
      if (!Array.isArray(entries) || entries.length === 0 || entries.length > maximumEntries) invalid()
      const known = new Map(positions.map(position => [position.cursor, position]))
      const seen = new Set()
      const annotations = entries.map(entry => {
        const position = known.get(entry?.cursor)
        if (!position || seen.has(entry.cursor) || entry.seatId !== position.seatId) invalid()
        if (!seatIds.includes(entry.seatId)) throw new ProductError(403, 'The requested replay perspective is unavailable')
        seen.add(entry.cursor)
        return normalizeReview(entry, position, fullAvailable)
      })
      return transaction(pool, async db => {
        // Serialize writers for the same game, including the first write to a cursor.
        const { rows: [lock] } = await db.query(`SELECT g.checksum,g.status,m.status AS match_status
          FROM games g JOIN matches m ON m.id=g.match_id WHERE g.id=$1 FOR UPDATE OF g`, [game.id])
        if (!lock || lock.checksum !== game.checksum || lock.status !== 'completed' || lock.match_status !== 'completed') {
          throw new ProductError(409, 'Replay is not ready for review')
        }
        await authorize(db)
        for (const seatId of seatIds) {
          const eligible = positions.filter(position => position.seatId === seatId).length
          await db.query(`INSERT INTO review_position_coverage(game_id,archive_revision,seat_key,eligible)
            VALUES($1,$2,$3,$4) ON CONFLICT (game_id,archive_revision,seat_key)
            DO UPDATE SET eligible=EXCLUDED.eligible`, [game.id, archiveRevision, seatId, eligible])
        }
        const ids = []
        for (const entry of annotations) ids.push(await saveAnnotation(db, game.id, archiveRevision, actor.accountId, entry))
        const { rows } = await db.query(selectAnnotations + ' WHERE a.id=ANY($1::bigint[]) ORDER BY a.event_cursor', [ids])
        return { annotations: rows.map(row => display(row, fullAvailable)), next: null }
      })
    },
    async counts(gameIds) {
      if (!gameIds.length) return []
      const { rows } = await pool.query(`
        SELECT game_id,archive_revision,seat_key,category,requires_full,count(*)::int AS total
        FROM review_annotations WHERE game_id=ANY($1::uuid[])
        GROUP BY game_id,archive_revision,seat_key,category,requires_full`, [gameIds])
      return rows
    },
    async coverage(gameIds) {
      if (!gameIds.length) return []
      const { rows } = await pool.query('SELECT * FROM review_position_coverage WHERE game_id=ANY($1::uuid[])', [gameIds])
      return rows
    },
  }
}
