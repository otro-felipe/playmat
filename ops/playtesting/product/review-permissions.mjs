import { isUuid, normalize, ProductError, transaction } from './decks.mjs'

export const reviewPolicyVersion = 2

function requireBrowserOwner(actor) {
  if (actor.agent || !actor.browserSession) throw new ProductError(403, 'Only the signed-in account can grant replay permission')
}

export function requireReviewPolicyVersion(value) {
  if (value !== reviewPolicyVersion) throw new ProductError(400, 'Read and accept the current replay notice')
}

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

async function lock(db, kind, id) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`playmat-review-${kind}:${id.toLowerCase()}`])
}

export function createReviewPermissions(pool) {
  async function tableConsent(actor, tableId, granted) {
    requireBrowserOwner(actor)
    if (!isUuid(tableId)) throw new ProductError(404, 'Table not found')
    const params = [tableId, actor.accountId, reviewPolicyVersion]
    async function read(db) {
      const { rowCount } = await db.query(`SELECT 1 FROM replay_review_table_consents
        WHERE table_id=$1 AND account_id=$2 AND policy_version=$3 AND revoked_at IS NULL`, params)
      return { version: reviewPolicyVersion, granted: rowCount === 1 }
    }
    if (granted === undefined) return read(pool)
    return transaction(pool, async db => {
      await lock(db, 'table', tableId)
      const sealed = await db.query(`SELECT 1 FROM replay_review_captures c
        JOIN replay_review_capture_seats s USING(match_id) WHERE c.table_id=$1 AND s.account_id=$2`, [tableId, actor.accountId])
      if (sealed.rowCount) throw new ProductError(409, 'The replay policy has already been set for this encounter')
      if (granted) await db.query(`INSERT INTO replay_review_table_consents(table_id,account_id,policy_version)
        VALUES($1,$2,$3) ON CONFLICT(table_id,account_id,policy_version)
        DO UPDATE SET granted_at=now(), revoked_at=NULL WHERE replay_review_table_consents.revoked_at IS NOT NULL`, params)
      else await db.query(`UPDATE replay_review_table_consents SET revoked_at=now()
        WHERE table_id=$1 AND account_id=$2 AND policy_version=$3 AND revoked_at IS NULL`, params)
      return read(db)
    })
  }

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
      await lock(db, 'table', tableId)
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
      const { rows: accepted } = await db.query(`SELECT account_id FROM replay_review_table_consents
        WHERE table_id=$1 AND policy_version=$2 AND revoked_at IS NULL`, [tableId, reviewPolicyVersion])
      const acknowledged = new Set(accepted.map(row => row.account_id))
      const reviewVersion = humanKeys.length && humanKeys.every(key => acknowledged.has(owners.get(key))) ? reviewPolicyVersion : null
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
    const { rows: [match] } = await db.query(`SELECT m.status, c.review_version FROM matches m
      LEFT JOIN replay_review_captures c ON c.match_id=m.id AND c.table_id=m.table_id WHERE m.id=$1`, [matchId])
    if (!match) throw new ProductError(404, 'Match not found')
    const { rows: players } = await db.query(`SELECT p.engine_key, min(p.engine_name) AS name, bool_or(p.human) AS human
      FROM games g JOIN game_players p ON p.game_id=g.id WHERE g.match_id=$1
      GROUP BY p.engine_key ORDER BY p.engine_key`, [matchId])
    const humanKeys = players.filter(({ human }) => human).map(({ engine_key }) => engine_key)
    const { rows: captured } = await db.query('SELECT engine_key,account_id,human FROM replay_review_capture_seats WHERE match_id=$1', [matchId])
    const fresh = match.review_version === reviewPolicyVersion
    const owners = fresh ? new Map(captured.map(row => [row.engine_key, row.account_id]))
      : await ownerAccounts(db, humanKeys, false)
    const perspectives = players.map(player => ({ seatId: player.engine_key, name: player.name,
      owned: owners.get(player.engine_key) === actor.accountId }))
    const viewer = perspectives.find(seat => seat.owned && seat.seatId === normalize(actor.engineName))
      ?? perspectives.find(seat => seat.owned && seat.seatId === normalize(actor.username))
    if (!viewer) throw new ProductError(404, 'Match not found')
    const atEnd = match.status === 'completed'
    const ownersKnown = humanKeys.length > 0 && humanKeys.every(key => owners.get(key))
    const legacyEligible = atEnd && !fresh && ownersKnown
    const legacy = legacyEligible ? await db.query(`SELECT account_id FROM replay_review_legacy_consents
      WHERE match_id=$1 AND policy_version=$2 AND revoked_at IS NULL`, [matchId, reviewPolicyVersion]) : { rows: [] }
    const granted = new Set(legacy.rows.map(row => row.account_id))
    const fullAvailable = atEnd && ownersKnown && (fresh ? exactSeats(captured, players) : humanKeys.every(key => granted.has(owners.get(key))))
    const reason = fullAvailable ? null : !atEnd ? 'match_not_completed' : !ownersKnown ? 'participant_authority_missing'
      : fresh ? 'capture_participants_changed' : 'participant_consent_required'
    return { status: match.status, fullAvailable, canGrantLegacy: legacyEligible && !actor.agent && !!actor.browserSession,
      legacyGranted: granted.has(actor.accountId), viewerSeatId: viewer.seatId, perspectives, reason }
  }

  async function changeLegacyConsent(actor, matchId, granted) {
    requireBrowserOwner(actor)
    if (!isUuid(matchId)) throw new ProductError(404, 'Match not found')
    return transaction(pool, async db => {
      await lock(db, 'match', matchId)
      const permission = await reviewAccess(actor, matchId, db)
      if (!permission.canGrantLegacy) throw new ProductError(409, 'This encounter cannot receive retrospective permission')
      const params = [matchId, actor.accountId, reviewPolicyVersion]
      if (granted) await db.query(`INSERT INTO replay_review_legacy_consents(match_id,account_id,policy_version)
        VALUES($1,$2,$3) ON CONFLICT(match_id,account_id,policy_version)
        DO UPDATE SET granted_at=now(), revoked_at=NULL WHERE replay_review_legacy_consents.revoked_at IS NOT NULL`, params)
      else await db.query(`UPDATE replay_review_legacy_consents SET revoked_at=now()
        WHERE match_id=$1 AND account_id=$2 AND policy_version=$3 AND revoked_at IS NULL`, params)
      return reviewAccess(actor, matchId, db)
    })
  }

  return { tableConsent, sealCapture, reviewAccess, changeLegacyConsent }
}
