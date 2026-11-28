import { normalize, ProductError, transaction } from './decks.mjs'

export function lockHistoryRetention(db) {
  return db.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':match-history-retention',0))")
}

export function setUnlimitedMatchHistory(pool, usernames, unlimited) {
  if (!Array.isArray(usernames) || usernames.length < 1 || usernames.length > 100 || typeof unlimited !== 'boolean'
    || usernames.some(name => typeof name !== 'string' || !/^[a-z0-9_-]{3,24}$/i.test(name.trim()))) {
    throw new ProductError(400, 'Supply valid account usernames and the history retention setting')
  }
  const names = [...new Set(usernames.map(normalize))].sort()
  return transaction(pool, async db => {
    await lockHistoryRetention(db)
    const { rowCount } = await db.query('UPDATE accounts SET unlimited_match_history=$2 WHERE username_key=ANY($1::text[])',
      [names, unlimited])
    if (rowCount !== names.length) throw new ProductError(404, 'One or more history exemption accounts were not found')
  })
}

export async function resetMatchHistory(pool, username, throughMs) {
  if (typeof username !== 'string' || !username.trim() || !Number.isSafeInteger(throughMs)
    || throughMs <= 0 || throughMs > Date.now()) {
    throw new ProductError(400, 'Supply an account and a history cutoff in the past')
  }
  return transaction(pool, async db => {
    await lockHistoryRetention(db)
    const { rows: [account] } = await db.query('SELECT id FROM accounts WHERE username_key=$1 FOR UPDATE', [normalize(username)])
    if (!account) throw new ProductError(404, 'History account was not found')
    const { rows: [counts] } = await db.query(`SELECT
        count(*) FILTER (WHERE COALESCE(m.ended_at,m.started_at)<=$2)::int AS hidden,
        count(*) FILTER (WHERE COALESCE(m.ended_at,m.started_at)>$2)::int AS remaining
      FROM retained_match_history h JOIN matches m ON m.id=h.match_id
      WHERE h.account_id=$1 AND m.status<>'active' AND NOT tournament_match_is_voided(m.table_id,m.id)`, [account.id, throughMs])
    await db.query('UPDATE accounts SET history_cleared_through_ms=GREATEST(history_cleared_through_ms,$2) WHERE id=$1',
      [account.id, throughMs])
    return { hidden: counts.hidden, remainingClosed: counts.remaining }
  })
}

export async function pruneMatchHistory(pool, protectedMatches) {
  await transaction(pool, async db => {
    await lockHistoryRetention(db)
    const { rows } = await db.query(`SELECT m.id FROM matches m
      WHERE m.status<>'active' AND m.id<>ALL($1::uuid[])
        AND NOT tournament_match_is_voided(m.table_id,m.id)
        AND NOT EXISTS(SELECT 1 FROM games g WHERE g.match_id=m.id AND g.status='active')
        AND NOT EXISTS(SELECT 1 FROM match_history_retention_window retained WHERE retained.match_id=m.id)
      ORDER BY m.started_at,m.id LIMIT 50 FOR UPDATE OF m SKIP LOCKED`, [[...protectedMatches]])
    if (!rows.length) return
    const matches = rows.map(({ id }) => id)
    await db.query('INSERT INTO purged_match_history(match_id) SELECT unnest($1::uuid[])', [matches])
    await db.query(`INSERT INTO replay_object_deletions(object_key)
      SELECT object_key FROM games WHERE match_id=ANY($1::uuid[]) AND object_key IS NOT NULL
      ON CONFLICT DO NOTHING`, [matches])
    await db.query('DELETE FROM replay_review_capture_seats WHERE match_id=ANY($1::uuid[])', [matches])
    await db.query('DELETE FROM replay_review_captures WHERE match_id=ANY($1::uuid[])', [matches])
    await db.query('DELETE FROM game_players WHERE game_id IN (SELECT id FROM games WHERE match_id=ANY($1::uuid[]))', [matches])
    await db.query('DELETE FROM games WHERE match_id=ANY($1::uuid[])', [matches])
    await db.query(`DELETE FROM match_deck_registrations r
      WHERE r.table_id IN (SELECT table_id FROM matches WHERE id=ANY($1::uuid[]))
        AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.table_id=r.table_id AND m.id<>ALL($1::uuid[]))`, [matches])
    await db.query('DELETE FROM matches WHERE id=ANY($1::uuid[])', [matches])
  })
}

export async function deleteExpiredReplayObjects(pool, store) {
  const { rows } = await pool.query(`UPDATE replay_object_deletions SET available_at=now() + interval '1 minute'
    WHERE object_key IN (
      SELECT object_key FROM replay_object_deletions WHERE available_at<=now()
      ORDER BY available_at,object_key LIMIT 10 FOR UPDATE SKIP LOCKED
    ) RETURNING object_key`)
  const results = await Promise.allSettled(rows.map(async ({ object_key: key }) => {
    await store.delete(key)
    await pool.query('DELETE FROM replay_object_deletions WHERE object_key=$1', [key])
  }))
  if (results.some(result => result.status === 'rejected')) console.warn('Playmat replay deletion retry scheduled')
}
