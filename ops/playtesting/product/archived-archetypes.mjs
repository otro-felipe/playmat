import { deckListSignature, publicListArchetype, verifiedListArchetype } from './deck-performance-identity.mjs'

/** Keep private submissions inside the archive service. History receives only the resulting label. */
export async function seatArchetype(db, tableId, seat, format, deck, matchId) {
  const signature = deckListSignature(deck)
  const { rows: [source] } = await db.query(`
    SELECT (SELECT NULLIF(archetype,'Other') FROM match_deck_registrations
      WHERE table_id=$1 AND engine_key=$2) AS registration,
      (SELECT origin.archetype FROM game_players origin JOIN games first_game ON first_game.id=origin.game_id
       WHERE first_game.match_id=$5 AND origin.engine_key=$2
       AND first_game.game_number=1 AND origin.archetype IS NOT NULL LIMIT 1) AS opening,
      (SELECT CASE WHEN count(DISTINCT r.archetype)=1 THEN NULLIF(min(r.archetype),'Other') END
       FROM deck_revisions r JOIN decks d ON (d.account_id,d.id)=(r.account_id,r.deck_id)
       WHERE r.list_signature=$3 AND (r.format IN ($4, 'Constructed - ' || $4) OR $4 IS NULL OR $4 IN ('Freeform','Constructed - Freeform'))
       AND ((d.library='personal' AND r.account_id IN (SELECT id FROM accounts WHERE username_key=$2))
         OR (d.library='agent' AND r.account_id IN (SELECT account_id FROM agent_grants WHERE engine_key=$2)))) AS library`,
    [tableId, seat, signature, format, matchId])
  if (source.registration || source.opening || source.library) return source.registration ?? source.opening ?? source.library
  if (!signature || !deck.cards.length) return null
  return publicListArchetype(format, signature) ?? verifiedListArchetype(format, deck.name, deck.cards, deck.sideboard ?? [])
}

export async function backfillSeatArchetypes(db) {
  let after = null
  for (;;) {
    const { rows } = await db.query(`SELECT g.game_number,p.game_id,p.engine_key,p.deck_snapshot,m.table_id,m.id AS match_id,COALESCE(m.format,m.engine_format) AS format
      FROM game_players p JOIN games g ON g.id=p.game_id JOIN matches m ON m.id=g.match_id
      WHERE p.archetype IS NULL AND ($1::integer IS NULL OR (g.game_number,p.game_id,p.engine_key)>($1,$2,$3))
      ORDER BY g.game_number,p.game_id,p.engine_key LIMIT 100`, after ?? [null,null,null])
    for (const row of rows) {
      const label = await seatArchetype(db, row.table_id, row.engine_key, row.format, row.deck_snapshot, row.match_id)
      if (label) await db.query('UPDATE game_players SET archetype=$3 WHERE game_id=$1 AND engine_key=$2 AND archetype IS NULL',
        [row.game_id, row.engine_key, label])
    }
    if (rows.length < 100) return
    const last = rows.at(-1)
    after = [last.game_number, last.game_id, last.engine_key]
  }
}

export async function archetypeCoverage(db) {
  const { rows } = await db.query(`WITH subjects AS (
    SELECT 'seats' AS kind, archetype FROM game_players
    UNION ALL SELECT 'closedOpeningSeats',p.archetype FROM game_players p JOIN games g ON g.id=p.game_id JOIN matches m ON m.id=g.match_id
      WHERE m.status='completed' AND g.game_number=1
    UNION ALL SELECT 'revisions', archetype FROM deck_revisions
    UNION ALL SELECT 'mcpSeats', p.archetype FROM game_players p WHERE EXISTS (SELECT 1 FROM agent_grants a WHERE a.engine_key=p.engine_key)
    UNION ALL SELECT 'retiredRevisions',r.archetype FROM deck_revisions r JOIN decks d ON (d.account_id,d.id)=(r.account_id,r.deck_id) WHERE d.removed
    UNION ALL SELECT d.library || 'Decks', r.archetype FROM decks d JOIN deck_revisions r ON (d.account_id,d.id,d.head)=(r.account_id,r.deck_id,r.revision) WHERE NOT d.removed
  ) SELECT kind, count(*)::int AS total, count(NULLIF(archetype,'Other'))::int AS classified FROM subjects GROUP BY kind`)
  return Object.fromEntries(['seats','closedOpeningSeats','mcpSeats','revisions','retiredRevisions','personalDecks','agentDecks'].map(kind => {
    const { total = 0, classified = 0 } = rows.find(row => row.kind === kind) ?? {}
    return [kind, { total, classified, pending: total - classified }]
  }))
}
