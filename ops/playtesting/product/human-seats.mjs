import { isUuid, normalize, ProductError } from './decks.mjs'

const missing = () => new ProductError(404, 'Human match seat not found')

function settings(row) {
  if (!row) throw missing()
  return { tableId: row.table_id, humanName: row.username, humanMcpAllowed: row.allowed, createdViaMcp: row.created_via_mcp,
    ...(row.chat_mode ? { chatMode: row.chat_mode } : {}) }
}

// Called only on loopback by the engine after it creates a table as the signed-in user.
// A table's owner and consent are fixed at creation, including on a retried registration.
export async function recordHumanSeat(pool, input) {
  if (!isUuid(input?.tableId) || typeof input.humanName !== 'string' || typeof input.humanMcpAllowed !== 'boolean'
      || typeof input.createdViaMcp !== 'boolean') throw new ProductError(400, 'Invalid human seat')
  const { rows } = await pool.query(`INSERT INTO human_match_seats AS h (table_id, account_id, allowed, created_via_mcp)
    SELECT $1, id, $3, $4 FROM accounts WHERE username_key=$2 AND enabled
    ON CONFLICT(table_id) DO UPDATE SET table_id=EXCLUDED.table_id
      WHERE h.account_id=EXCLUDED.account_id AND h.allowed=EXCLUDED.allowed AND h.created_via_mcp=EXCLUDED.created_via_mcp
    RETURNING table_id`, [input.tableId, normalize(input.humanName), input.humanMcpAllowed, input.createdViaMcp])
  if (!rows.length) throw new ProductError(409, 'Human seat could not be registered')
}

export async function readHumanSeat(pool, actor, tableId, { ownerOnly = false } = {}) {
  if (!isUuid(tableId)) throw missing()
  const { rows: [row] } = await pool.query(`SELECT h.*, a.username, i.chat_mode FROM human_match_seats h
    JOIN accounts a ON a.id=h.account_id
    LEFT JOIN invitations i ON i.table_id=h.table_id AND i.mode='mcp'
    WHERE h.table_id=$1 AND (h.account_id=$2 OR (NOT $3 AND EXISTS (
      SELECT 1 FROM invitations i WHERE i.table_id=h.table_id AND i.claimed_at IS NOT NULL AND i.invitee_key=$4)))`,
    [tableId, actor.accountId, ownerOnly, normalize(actor.engineName)])
  return settings(row)
}

// A delegated human connection carries the human recovery seat and the OAuth connection that requested it.
export async function authorizeHumanConnection(pool, input) {
  if (!isUuid(input?.accountId) || !isUuid(input.connectionId)
      || input.tableId !== undefined && !isUuid(input.tableId)
      || input.startOnly !== undefined && (input.startOnly !== true || !input.tableId)) return false
  const { rowCount } = await pool.query(`SELECT 1 FROM oauth_connections c
    JOIN accounts a ON a.id=c.account_id AND a.enabled
    JOIN agent_grants g ON g.engine_key=c.engine_key AND g.account_id=c.account_id
    WHERE c.id=$1 AND c.account_id=$2 AND g.oauth_managed AND g.revoked_at IS NULL AND 'play'=ANY(g.scopes)
      AND c.revoked_at IS NULL AND c.expires_at>now() AND 'play'=ANY(c.scopes_approved)
      AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM human_match_seats h
        WHERE h.table_id=$3 AND h.account_id=c.account_id AND (CASE WHEN $4 THEN h.created_via_mcp ELSE h.allowed END)))`,
    [input.connectionId, input.accountId, input.tableId ?? null, input.startOnly === true])
  return rowCount === 1
}

export async function listHumanMatches(pool, actor) {
  const url = new URL('http://127.0.0.1:17173/internal/human-tables')
  url.searchParams.set('owner', actor.username)
  let live
  try {
    const response = await fetch(url, { redirect:'error', signal:AbortSignal.timeout(3000) })
    if (!response.ok) throw Error()
    live = await response.json()
  } catch {
    throw new ProductError(503, 'Live match discovery is unavailable')
  }
  const ids = Object.keys(live).filter(isUuid)
  if (!ids.length) return { matches: [] }
  const { rows } = await pool.query(`SELECT table_id FROM human_match_seats
    WHERE account_id=$1 AND allowed AND table_id=ANY($2::uuid[])
    ORDER BY created_at DESC,table_id`, [actor.accountId, ids])
  return { matches: rows.map(({ table_id }) => ({ tableId:table_id, status:live[table_id] })) }
}

export async function humanBrowserMayPlay(pool, input) {
  if (!isUuid(input?.accountId) || !isUuid(input.tableId)) return false
  const { rowCount } = await pool.query(`SELECT 1 FROM accounts a WHERE a.id=$1 AND a.enabled AND NOT EXISTS(
    SELECT 1 FROM human_match_seats h WHERE h.table_id=$2 AND h.account_id=a.id AND h.allowed)`,
    [input.accountId, input.tableId])
  return rowCount === 1
}

export async function restoreHumanSeat(pool, { originalTableId, tableId }) {
  if (!isUuid(originalTableId) || !isUuid(tableId) || originalTableId === tableId) throw new ProductError(400, 'Invalid restored table')
  const {rows:[{ compatible }]} = await pool.query(`WITH original AS (
      SELECT account_id,allowed,created_via_mcp FROM human_match_seats WHERE table_id=$1
    ), copied AS (
      INSERT INTO human_match_seats AS h (table_id,account_id,allowed,created_via_mcp,restored_from)
      SELECT $2,account_id,allowed,created_via_mcp,$1 FROM original
      ON CONFLICT(table_id) DO UPDATE SET table_id=EXCLUDED.table_id
        WHERE h.restored_from=EXCLUDED.restored_from AND h.account_id=EXCLUDED.account_id
          AND h.allowed=EXCLUDED.allowed AND h.created_via_mcp=EXCLUDED.created_via_mcp
      RETURNING table_id
    ) SELECT EXISTS(SELECT 1 FROM copied)
      OR (NOT EXISTS(SELECT 1 FROM original) AND NOT EXISTS(SELECT 1 FROM human_match_seats WHERE table_id=$2)) AS compatible`,
    [originalTableId, tableId])
  if (!compatible) throw new ProductError(409, 'Restored table already belongs to another seat')
}
