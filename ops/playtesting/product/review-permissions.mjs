import { viewerNames } from './identity.mjs'
import { isUuid, normalize, ProductError, transaction } from './decks.mjs'

const reviewCaptureVersion = 2

function exactSeats(recorded, actual) {
  return recorded.length === actual.length && recorded.every(seat =>
    actual.some(other => other.engine_key === seat.engine_key && other.human === seat.human))
}

async function ownerAccounts(db, names, activeGrantsOnly) {
  const { rows } = await db.query(`
    SELECT username_key AS engine_key, id AS account_id
      FROM accounts WHERE enabled AND username_key=ANY($1::text[])
    UNION ALL
    SELECT g.engine_key, a.id AS account_id
      FROM agent_grants g JOIN accounts a ON a.id=g.account_id
      WHERE a.enabled AND g.engine_key=ANY($1::text[]) AND (NOT $2::boolean OR g.revoked_at IS NULL)`,
  [names, activeGrantsOnly])
  return new Map(rows.map(({ engine_key, account_id }) => [engine_key, account_id]))
}

export function createReviewPermissions(pool) {
  async function sealCapture({ matchId, tableId, seats } = {}) {
    if (!isUuid(matchId) || !isUuid(tableId) || !Array.isArray(seats) || seats.length < 1 || seats.length > 16
      || seats.some(seat => !seat || !isUuid(seat.playerId) || typeof seat.human !== 'boolean'
        || typeof seat.engineName !== 'string' || !seat.engineName.trim() || seat.engineName.length > 64)) {
      throw new ProductError(400, 'Invalid match capture metadata')
    }
    const players = seats.map(seat => ({ engine_key: normalize(seat.engineName), human: seat.human }))
    if (new Set(players.map(seat => seat.engine_key)).size !== players.length
      || new Set(seats.map(seat => seat.playerId.toLowerCase())).size !== seats.length) {
      throw new ProductError(400, 'Duplicate capture seats')
    }
    return transaction(pool, async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['playmat-review-table:' + tableId.toLowerCase()])
      const { rows: existing } = await db.query(
        'SELECT match_id,table_id,review_version FROM replay_review_captures WHERE match_id=$1 OR table_id=$2', [matchId, tableId])
      if (existing.length) {
        const saved = existing.find(row => row.match_id === matchId.toLowerCase() && row.table_id === tableId.toLowerCase())
        if (!saved?.review_version) return { reviewVersion: null }
        const { rows: recorded } = await db.query('SELECT engine_key,human FROM replay_review_capture_seats WHERE match_id=$1', [matchId])
        return { reviewVersion: exactSeats(recorded, players) ? saved.review_version : null }
      }
      const humanKeys = players.filter(({ human }) => human).map(({ engine_key }) => engine_key)
      const owners = await ownerAccounts(db, humanKeys, true)
      const reviewVersion = humanKeys.length > 0 && humanKeys.every(key => owners.has(key)) ? reviewCaptureVersion : null
      const saved = await db.query(`INSERT INTO replay_review_captures(match_id,table_id,review_version)
        VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING match_id`, [matchId, tableId, reviewVersion])
      if (!saved.rowCount) return { reviewVersion: null }
      for (const { engine_key, human } of players) {
        await db.query('INSERT INTO replay_review_capture_seats(match_id,engine_key,account_id,human) VALUES($1,$2,$3,$4)',
          [matchId, engine_key, owners.get(engine_key) ?? null, human])
      }
      return { reviewVersion }
    })
  }

  async function reviewAccess(actor, matchId, db = pool) {
    if (!isUuid(matchId)) throw new ProductError(404, 'Match not found')
    const { rows: [match] } = await db.query(`SELECT m.status, c.match_id AS capture_match_id FROM matches m
      JOIN retained_match_history h ON h.match_id=m.id AND h.account_id=$2
      LEFT JOIN replay_review_captures c ON c.match_id=m.id AND c.table_id=m.table_id WHERE m.id=$1`, [matchId, actor.accountId])
    if (!match) throw new ProductError(404, 'Match not found')
    const { rows: players } = await db.query(`SELECT p.engine_key, min(p.engine_name) AS name, bool_or(p.human) AS human
      FROM games g JOIN game_players p ON p.game_id=g.id WHERE g.match_id=$1
      GROUP BY p.engine_key ORDER BY p.engine_key`, [matchId])
    const humanKeys = players.filter(({ human }) => human).map(({ engine_key }) => engine_key)
    const captured = match.capture_match_id
      ? (await db.query('SELECT engine_key,account_id,human FROM replay_review_capture_seats WHERE match_id=$1', [matchId])).rows
      : null
    const owners = captured ? new Map(captured.map(row => [row.engine_key, row.account_id]))
      : await ownerAccounts(db, humanKeys, false)
    const perspectives = players.map(player => ({ seatId: player.engine_key, name: player.name,
      owned: owners.get(player.engine_key) === actor.accountId }))
    const viewer = viewerNames(actor).map(name => perspectives.find(seat => seat.owned && seat.seatId === name)).find(Boolean)
    if (!viewer) throw new ProductError(404, 'Match not found')
    const atEnd = match.status === 'completed'
    const ownersKnown = humanKeys.length > 0 && humanKeys.every(key => owners.get(key))
    const stableSeats = !captured || exactSeats(captured, players)
    const fullAvailable = atEnd && ownersKnown && stableSeats
    const reason = fullAvailable ? null : !atEnd ? 'match_not_completed'
      : !ownersKnown ? 'participant_authority_missing' : 'capture_participants_changed'
    return { status: match.status, fullAvailable, viewerSeatId: viewer.seatId, perspectives, reason }
  }

  return { sealCapture, reviewAccess }
}
