import { canonicalArchetype } from './deck-performance-identity.mjs'

// Every place a deck's archetype label is stored, with the format that decides its catalog.
// Each query yields the row key (k1, k2, k3), the format and the stored label.
const stores = [
  {
    name: 'deckRevisions',
    select: `SELECT account_id::text AS k1, deck_id AS k2, revision::text AS k3, format, archetype AS label
      FROM deck_revisions WHERE archetype IS NOT NULL`,
    keys: 3,
    update: `UPDATE deck_revisions SET archetype=$4 WHERE account_id=$1::uuid AND deck_id=$2 AND revision=$3::integer`,
  },
  {
    name: 'registrations',
    select: `SELECT r.table_id::text AS k1, r.engine_key AS k2, NULL AS k3, r.archetype AS label,
      COALESCE((SELECT COALESCE(m.format,m.engine_format) FROM matches m WHERE m.table_id=r.table_id LIMIT 1),
        (SELECT d.format FROM deck_revisions d WHERE d.account_id=r.account_id AND d.deck_id=r.deck_id
          ORDER BY d.revision DESC LIMIT 1)) AS format
      FROM match_deck_registrations r WHERE r.archetype IS NOT NULL`,
    keys: 2,
    update: `UPDATE match_deck_registrations SET archetype=$3 WHERE table_id=$1::uuid AND engine_key=$2`,
  },
  {
    name: 'seats',
    select: `SELECT p.game_id::text AS k1, p.engine_key AS k2, NULL AS k3, COALESCE(m.format,m.engine_format) AS format,
      p.archetype AS label
      FROM game_players p JOIN games g ON g.id=p.game_id JOIN matches m ON m.id=g.match_id WHERE p.archetype IS NOT NULL`,
    keys: 2,
    update: `UPDATE game_players SET archetype=$3 WHERE game_id=$1::uuid AND engine_key=$2`,
  },
  {
    name: 'openingSeats',
    select: `SELECT p.game_id::text AS k1, p.engine_key AS k2, NULL AS k3, COALESCE(m.format,m.engine_format) AS format,
      p.opening_archetype AS label
      FROM game_players p JOIN games g ON g.id=p.game_id JOIN matches m ON m.id=g.match_id WHERE p.opening_archetype IS NOT NULL`,
    keys: 2,
    update: `UPDATE game_players SET opening_archetype=$3 WHERE game_id=$1::uuid AND engine_key=$2`,
  },
  {
    name: 'tournamentEntries',
    select: `SELECT e.id::text AS k1, NULL AS k2, NULL AS k3, t.format, e.opening_archetype AS label
      FROM tournament_entries e JOIN tournaments t ON t.id=e.tournament_id WHERE e.opening_archetype IS NOT NULL`,
    keys: 1,
    update: `UPDATE tournament_entries SET opening_archetype=$2 WHERE id=$1::uuid`,
  },
]

/**
 * Rewrite stored labels from earlier catalogs to the canonical names (Pioneer: MTGTop8).
 * Unknown labels are left alone. Idempotent: a second run changes nothing.
 */
export async function canonicalizeStoredArchetypes(db) {
  const changed = {}
  const heads = []
  for (const store of stores) {
    const { rows } = await db.query(store.select)
    let count = 0
    for (const row of rows) {
      const label = canonicalArchetype(row.format, row.label)
      if (!label || label === row.label) continue
      await db.query(store.update, [row.k1, row.k2, row.k3].slice(0, store.keys).concat(label))
      if (store.name === 'deckRevisions') heads.push([row.k1, row.k2, row.k3])
      count++
    }
    changed[store.name] = count
  }
  // Clients resynchronize a library deck when its head moves.
  for (const [account, deck, revision] of heads) {
    await db.query('UPDATE decks SET updated_at=updated_at+1 WHERE account_id=$1::uuid AND id=$2 AND head=$3::integer', [account, deck, revision])
  }
  return changed
}
