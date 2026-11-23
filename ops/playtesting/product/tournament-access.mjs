import { getDeck, isUuid, ProductError, transaction } from './decks.mjs'

export async function tournamentActor(pool, actor) {
  if (!actor) return null
  const {
    rows: [account],
  } = await pool.query('SELECT tournament_admin FROM accounts WHERE id=$1 AND enabled', [actor.accountId])
  if (!account) throw new ProductError(401, 'Account unavailable')
  return {
    ...actor,
    ownerIsAdmin: account.tournament_admin,
    isAdmin: !actor.agent && !!actor.browserSession && account.tournament_admin,
  }
}

// Only configured, already-provisioned account IDs can receive the role.
export async function setTournamentAdmins(pool, ids) {
  const unique = [...new Set(ids)]
  if (!unique.every(isUuid)) throw new Error('Tournament administrators require existing account IDs')
  await transaction(pool, async (db) => {
    const found = await db.query('SELECT id FROM accounts WHERE id=ANY($1::uuid[]) AND enabled FOR UPDATE', [
      unique,
    ])
    if (found.rowCount !== unique.length) throw new Error('Unknown tournament administrator account')
    await db.query(
      'UPDATE accounts SET tournament_admin=(id=ANY($1::uuid[])) WHERE tournament_admin IS DISTINCT FROM (id=ANY($1::uuid[]))',
      [unique],
    )
  })
}

export async function ownedPlayer(db, actor, playerId, requireEnabled = false) {
  if (!isUuid(playerId) || actor.agent) throw new ProductError(403, 'Select one of your players')
  const {
    rows: [p],
  } = await db.query(
    `SELECT p.id,p.display_name,g.engine_name FROM player_profiles p
    JOIN agent_grants g ON g.player_id=p.id WHERE p.account_id=$1 AND p.id=$2
    AND p.retired_at IS NULL AND (NOT $3 OR (p.mcp_enabled AND g.revoked_at IS NULL))`,
    [actor.accountId, playerId, requireEnabled],
  )
  if (!p) throw new ProductError(404, 'Player unavailable')
  return p
}

export function readTournamentDeck(db, actor, deckId) {
  return getDeck(
    db,
    actor.accountId,
    deckId,
    null,
    actor.playerId ? 'agent' : 'personal',
    actor.playerId ?? null,
  )
}

export async function validateTournamentDeck(_db, _actor, deck, format) {
  let response
  try {
    response = await fetch('http://127.0.0.1:17173/internal/tournament/deck-validation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      redirect: 'error',
      body: JSON.stringify({
        format,
        deck: { name: deck.name, cards: deck.data.cards, sideboard: deck.data.sideboard },
      }),
      signal: AbortSignal.timeout(12000),
    })
  } catch {
    throw new ProductError(503, 'Deck validation temporarily unavailable')
  }
  if (response.status === 422)
    throw new ProductError(422, 'XMage could not load this deck for the selected format')
  if (!response.ok) throw new ProductError(503, 'Deck validation temporarily unavailable')
  const result = await response.json()
  if (result.valid !== true)
    throw new ProductError(422, result.errors?.[0]?.message || 'Illegal deck for this tournament')
}
