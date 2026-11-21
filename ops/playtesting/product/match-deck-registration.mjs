import { isId } from './decks.mjs'
import { deckListSignature } from './deck-performance-identity.mjs'

// The engine supplies the seat and the list actually submitted for game one.
// A client-supplied library ID is only a hint within that seat owner's library.
export async function registerSelectedDeck(db, tableId, seat, deck) {
  if (!isId(deck?.libraryDeckId)) return
  const signature = deckListSignature(deck)
  if (!signature) return
  await db.query(`
    INSERT INTO match_deck_registrations
      (table_id, engine_key, account_id, deck_id, list_version, archetype, list_signature, deck_name)
    SELECT $1, $2, r.account_id, r.deck_id, r.list_version, r.archetype, r.list_signature, r.name
    FROM deck_revisions r
    WHERE r.deck_id=$3 AND r.list_signature=$4 AND r.account_id IN (
      SELECT id FROM accounts WHERE username_key=$2
      UNION SELECT account_id FROM agent_grants WHERE engine_key=$2
    )
    ORDER BY r.revision DESC LIMIT 1
    ON CONFLICT (table_id,engine_key) DO NOTHING`, [tableId, seat, deck.libraryDeckId, signature])
}
