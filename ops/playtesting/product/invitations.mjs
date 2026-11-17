import { isUuid, normalize, normalizeFormat, ProductError } from './decks.mjs'

function invitationView(row) {
  if (!row) throw new ProductError(404, 'Invitation not found')
  return {
    tableId: row.table_id, roomId: row.room_id, format: row.format, mode: row.mode,
    guestEngineName: row.invitee_name, guestDisplayName: row.guest_display_name, expiresAt: row.expires_at,
  }
}

function displayName(value) {
  if (value === undefined) return null
  const name = typeof value === 'string' && value.trim().normalize('NFC')
  if (!name || !/^[\p{L}\p{N}][\p{L}\p{N}\p{M} ._-]{0,23}$/u.test(name)) {
    throw new ProductError(400, 'Display name must be 1–24 letters or numbers, with spaces, dots, dashes, or underscores')
  }
  return name
}

export function createInvitations(pool, identity) {
  async function list(actor, requestedLimit) {
    const limit = Math.max(1, Math.min(50, Number.parseInt(requestedLimit, 10) || 25))
    const { rows } = await pool.query(
      'SELECT * FROM invitations WHERE invitee_key=$1 AND expires_at>now() ORDER BY expires_at DESC,table_id LIMIT $2',
      [normalize(actor.engineName), limit],
    )
    return { invites: rows.map(invitationView) }
  }

  async function create(actor, data) {
    const format = normalizeFormat(data?.format)
    if (!isUuid(data?.tableId) || !isUuid(data.roomId) || !format || typeof data.password !== 'string'
      || data.password.length < 12 || data.password.length > 100) throw new ProductError(400, 'Provide a valid protected table')
    const mode = data.mode ?? 'friend'
    if (mode !== 'friend' && mode !== 'mcp') throw new ProductError(400, 'Invalid invitation mode')
    let invitee = null
    if (mode === 'friend') {
      invitee = await identity.fromEngine(data.guestEngineName)
      if (!invitee || normalize(invitee.engineName) === normalize(actor.engineName) || !invitee.scopes.includes('play')) {
        throw new ProductError(400, 'Provide a provisioned guest seat')
      }
    } else if (data.guestEngineName !== undefined) {
      throw new ProductError(400, 'An MCP invitation cannot name a guest account')
    }
    const { rows: [invite] } = await pool.query(`INSERT INTO invitations(table_id,room_id,format,creator_key,invitee_key,invitee_name,table_password,expires_at,mode)
      VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '48 hours',$8) ON CONFLICT (table_id) DO NOTHING RETURNING *`,
    [data.tableId, data.roomId, format, normalize(actor.engineName), invitee ? normalize(invitee.engineName) : null,
      invitee?.engineName ?? null, data.password, mode])
    if (!invite) throw new ProductError(409, 'This table already has an invitation')
    return invitationView(invite)
  }

  async function inspect(actor, tableId) {
    const { rows: [invite] } = await pool.query(`SELECT * FROM invitations WHERE table_id=$1 AND expires_at>now()
      AND (creator_key=$2 OR invitee_key=$2 OR (mode='mcp' AND invitee_key IS NULL AND $3))`,
    [tableId, normalize(actor.engineName), actor.agent])
    return invitationView(invite)
  }

  async function claim(actor, tableId, data) {
    const alias = displayName(data?.displayName)
    const key = normalize(actor.engineName)
    // The claim chooses the authenticated engine identity once. Retries by that identity keep the same alias.
    const { rows: [invite] } = await pool.query(`UPDATE invitations SET
      claimed_at=COALESCE(claimed_at,now()), invitee_key=COALESCE(invitee_key,$2), invitee_name=COALESCE(invitee_name,$3),
      guest_display_name=CASE WHEN mode='mcp' THEN COALESCE(guest_display_name,$4,$3) ELSE guest_display_name END
      WHERE table_id=$1 AND creator_key<>$2 AND expires_at>now() AND (
        (mode='friend' AND invitee_key=$2) OR (mode='mcp' AND $5 AND (invitee_key IS NULL OR invitee_key=$2))
      ) RETURNING *`, [tableId, key, actor.engineName, alias, actor.agent])
    return { ...invitationView(invite), password: invite.table_password }
  }

  async function admit(tableId, host, guest) {
    const { rowCount } = await pool.query(`SELECT 1 FROM invitations i
      WHERE table_id=$1 AND creator_key=$2 AND invitee_key=$3 AND claimed_at IS NOT NULL AND expires_at>now()
      AND (mode='friend' OR EXISTS (
        SELECT 1 FROM agent_grants g JOIN accounts a ON a.id=g.account_id
        WHERE g.engine_key=i.invitee_key AND g.revoked_at IS NULL AND 'play'=ANY(g.scopes) AND a.enabled
      ))`, [tableId, normalize(host), normalize(guest)])
    return Boolean(rowCount)
  }

  return { list, create, inspect, claim, admit }
}
