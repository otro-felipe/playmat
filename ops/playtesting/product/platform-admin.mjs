import { archetypesFor, canonicalArchetype } from './deck-performance-identity.mjs'
import { ProductError, isId, isUuid, transaction } from './decks.mjs'

const engineNameFor = (playerId) => 'mcp_p' + playerId.replaceAll('-', '').slice(0, 18)
const time = (value) => (value == null ? null : Number(value))

/**
 * Every account with its MCP players (subagents) and agent grants, for platform staff.
 * Credentials never leave the database: grants report names, scopes and dates only.
 */
export async function platformOverview(pool) {
  const { rows: accounts } = await pool.query(`
    SELECT a.id,a.username,a.email,a.enabled,a.tournament_admin AS "tournamentAdmin",
      (SELECT count(*)::int FROM decks d WHERE d.account_id=a.id AND NOT d.removed AND d.library='personal') AS "personalDecks",
      (SELECT count(*)::int FROM decks d WHERE d.account_id=a.id AND NOT d.removed AND d.library<>'personal') AS "agentDecks",
      (SELECT count(*)::int FROM decks d JOIN deck_revisions r ON (r.account_id,r.deck_id,r.revision)=(d.account_id,d.id,d.head)
        WHERE d.account_id=a.id AND NOT d.removed AND r.archetype='Other') AS "unclassifiedDecks",
      (SELECT count(DISTINCT g.match_id)::int FROM game_players p JOIN games g ON g.id=p.game_id
        WHERE p.human AND p.engine_key=a.username_key) AS "humanMatches",
      (SELECT max(g.started_at) FROM game_players p JOIN games g ON g.id=p.game_id
        WHERE p.human AND p.engine_key=a.username_key) AS "lastHumanGameAt",
      (SELECT max(s.expires_at) FROM browser_sessions s WHERE s.account_id=a.id) AS "sessionExpiresAt"
    FROM accounts a ORDER BY lower(a.username)`)
  const { rows: players } = await pool.query(`
    SELECT p.id,p.account_id,p.display_name AS "displayName",p.flag,p.mcp_enabled AS "mcpEnabled",
      p.provider,p.model,p.reasoning_effort AS "reasoningEffort",p.retired_at AS "retiredAt",
      (SELECT count(DISTINCT g.match_id)::int FROM game_players gp JOIN games g ON g.id=gp.game_id WHERE gp.player_id=p.id) AS matches,
      (SELECT max(g.started_at) FROM game_players gp JOIN games g ON g.id=gp.game_id WHERE gp.player_id=p.id) AS "lastGameAt",
      (SELECT count(*)::int FROM decks d WHERE d.account_id=p.account_id AND d.owner_player_id=p.id AND NOT d.removed) AS decks
    FROM player_profiles p ORDER BY p.retired_at IS NOT NULL, lower(p.display_name)`)
  const { rows: grants } = await pool.query(`
    SELECT account_id,engine_name AS "engineName",scopes,oauth_managed AS "oauthManaged",player_id AS "playerId",
      created_at AS "createdAt",revoked_at AS "revokedAt"
    FROM agent_grants ORDER BY created_at`)
  const byAccount = new Map(accounts.map((account) => [account.id, { ...account, players: [], grants: [] }]))
  for (const { account_id: owner, ...player } of players) {
    byAccount.get(owner)?.players.push({
      ...player,
      engineName: engineNameFor(player.id),
      retiredAt: player.retiredAt?.toISOString() ?? null,
      lastGameAt: time(player.lastGameAt),
    })
  }
  for (const { account_id: owner, ...grant } of grants) {
    byAccount.get(owner)?.grants.push({
      ...grant,
      createdAt: grant.createdAt?.toISOString() ?? null,
      revokedAt: grant.revokedAt?.toISOString() ?? null,
    })
  }
  const list = [...byAccount.values()].map((account) => ({
    ...account,
    lastHumanGameAt: time(account.lastHumanGameAt),
    sessionExpiresAt: account.sessionExpiresAt?.toISOString() ?? null,
  }))
  return {
    accounts: list,
    totals: {
      accounts: list.length,
      enabledAccounts: list.filter((account) => account.enabled).length,
      players: players.filter((player) => !player.retiredAt).length,
      activeGrants: grants.filter((grant) => !grant.revokedAt).length,
    },
  }
}

/** Current library decks whose archetype is still Other, for manual curation. */
export async function unclassifiedDecks(pool) {
  const { rows } = await pool.query(`
    SELECT d.account_id AS "accountId",a.username,d.id AS "deckId",d.library,r.name,r.format,
      p.display_name AS "playerName",d.updated_at AS "updatedAt",
      (SELECT coalesce(sum(c.amount),0)::int FROM deck_revision_cards c
        WHERE (c.account_id,c.deck_id,c.revision)=(d.account_id,d.id,d.head) AND c.zone='cards') AS "mainCount"
    FROM decks d JOIN deck_revisions r ON (r.account_id,r.deck_id,r.revision)=(d.account_id,d.id,d.head)
    JOIN accounts a ON a.id=d.account_id LEFT JOIN player_profiles p ON p.id=d.owner_player_id
    WHERE NOT d.removed AND r.archetype='Other'
    ORDER BY lower(a.username),lower(r.name) LIMIT 500`)
  const formats = [...new Set(rows.map((row) => row.format))]
  return {
    decks: rows.map((row) => ({ ...row, updatedAt: time(row.updatedAt) })),
    archetypes: Object.fromEntries(formats.map((format) => [format, archetypesFor(format)])),
  }
}

/**
 * Staff assign the archetype of a deck's current list. The label is recorded as an
 * explicit choice, and seats registered with that list but still unlabelled follow it.
 */
export async function setDeckArchetype(pool, accountId, deckId, input) {
  if (!isUuid(accountId) || !isId(deckId)) throw new ProductError(404, 'Deck not found')
  return transaction(pool, async (db) => {
    const {
      rows: [head],
    } = await db.query(
      `SELECT r.revision,r.format,r.list_signature FROM decks d
       JOIN deck_revisions r ON (r.account_id,r.deck_id,r.revision)=(d.account_id,d.id,d.head)
       WHERE d.account_id=$1 AND d.id=$2 AND NOT d.removed FOR UPDATE OF d`,
      [accountId, deckId],
    )
    if (!head) throw new ProductError(404, 'Deck not found')
    const label = canonicalArchetype(head.format, input?.archetype)
    if (typeof label !== 'string' || !archetypesFor(head.format).includes(label))
      throw new ProductError(400, 'Choose a catalog archetype for this format')
    await db.query(
      'UPDATE deck_revisions SET archetype=$4, archetype_inferred=FALSE WHERE account_id=$1 AND deck_id=$2 AND revision=$3',
      [accountId, deckId, head.revision, label],
    )
    await db.query('UPDATE decks SET updated_at=updated_at+1 WHERE account_id=$1 AND id=$2', [accountId, deckId])
    await db.query(
      `UPDATE match_deck_registrations SET archetype=$4 WHERE account_id=$1 AND deck_id=$2 AND list_signature=$3
       AND (archetype IS NULL OR archetype='Other')`,
      [accountId, deckId, head.list_signature, label],
    )
    return { accountId, deckId, revision: head.revision, archetype: label }
  })
}
