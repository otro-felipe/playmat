import { isUuid, ProductError, transaction } from './decks.mjs'
import { viewerNames } from './identity.mjs'

function validateId(id) {
  if (!isUuid(id)) throw new ProductError(404, 'Match not found')
}

export function exclusionView(row) {
  return row.reason ? { reason: row.reason, author: row.author, markedAt: row.marked_at.toISOString() } : null
}

async function mark(pool, matchId, rawReason, actor) {
  validateId(matchId)
  const reason = typeof rawReason === 'string' ? rawReason.trim() : ''
  if (!reason || reason.length > 500 || /\p{Cc}/u.test(reason)) throw new ProductError(400, 'Provide a reason of up to 500 characters')
  return transaction(pool, async db => {
    const access = actor ? `AND EXISTS (
      SELECT 1 FROM retained_match_history h JOIN games g ON g.match_id=h.match_id
      JOIN game_players p ON p.game_id=g.id
      WHERE h.match_id=m.id AND h.account_id=$2 AND p.engine_key=ANY($3::text[])
    )` : ''
    const values = actor ? [matchId, actor.accountId, viewerNames(actor)] : [matchId]
    const { rows: [match] } = await db.query(`SELECT m.status FROM matches m WHERE m.id=$1 ${access} FOR UPDATE OF m`, values)
    if (!match) throw new ProductError(404, 'Match not found')
    if (match.status === 'active') throw new ProductError(409, 'Wait until the match has ended')
    const { rows: [existing] } = await db.query('SELECT reason, author, marked_at FROM match_statistics_exclusions WHERE match_id=$1', [matchId])
    if (existing) {
      if (existing.reason !== reason) throw new ProductError(409, 'This match was already excluded for a different reason')
      return exclusionView(existing)
    }
    const { rows: [saved] } = await db.query(`INSERT INTO match_statistics_exclusions(match_id,reason,author,author_account_id)
      VALUES ($1,$2,$3,$4) RETURNING reason,author,marked_at`, [matchId, reason, actor?.username ?? 'service-operator', actor?.accountId ?? null])
    return exclusionView(saved)
  })
}

export function excludeAsParticipant(pool, actor, matchId, reason) {
  if (!actor || actor.agent) throw new ProductError(403, 'A participating account must mark this match')
  return mark(pool, matchId, reason, actor)
}

export function excludeAsOperator(pool, matchId, reason) {
  return mark(pool, matchId, reason, null)
}

export async function inspectMatchStatistics(pool, matchId) {
  validateId(matchId)
  const { rows: [row] } = await pool.query(`SELECT m.id, m.status, x.reason, x.author, x.marked_at,
    eligible.id IS NOT NULL AS included,
    (SELECT count(*)::int FROM games WHERE match_id=m.id AND status='completed') AS completed_games,
    (SELECT count(*)::int FROM games WHERE match_id=m.id AND object_key IS NOT NULL) AS replays
    FROM matches m LEFT JOIN match_statistics_exclusions x ON x.match_id=m.id
    LEFT JOIN statistically_eligible_matches eligible ON eligible.id=m.id WHERE m.id=$1`, [matchId])
  if (!row) throw new ProductError(404, 'Match not found')
  return { matchId: row.id, status: row.status, included: row.included, completedGames: row.completed_games,
    eligibleGames: row.included ? row.completed_games : 0, archivedReplays: row.replays, exclusion: exclusionView(row) }
}
