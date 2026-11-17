import { isUuid, normalize, normalizeFormat, ProductError, transaction } from './decks.mjs'

const CHAT_MODES = new Set(['quiet', 'chatty', 'coach'])
const INVITATION_EVENT = 'game.invitation.created'

function invitationView(row) {
  if (!row) throw new ProductError(404, 'Invitation not found')
  return {
    tableId: row.table_id, roomId: row.room_id, format: row.format, mode: row.mode,
    ...(row.mode === 'mcp' ? { chatMode: row.chat_mode } : {}),
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

export function createInvitations(pool, identity, events) {
  async function list(actor, requestedLimit) {
    const limit = Math.max(1, Math.min(50, Number.parseInt(requestedLimit, 10) || 25))
    const { rows } = await pool.query(
      'SELECT * FROM invitations WHERE invitee_key=$1 AND expires_at>now() ORDER BY expires_at DESC,table_id LIMIT $2',
      [normalize(actor.engineName), limit],
    )
    return { invites: rows.map(invitationView) }
  }

  async function eventRivals(actor) {
    if (actor.agent) throw new ProductError(403, 'Sign in as the host account to view subscribed agents')
    const { rows } = await pool.query(`SELECT g.engine_name AS "engineName"
      FROM agent_grants g JOIN accounts a ON a.id=g.account_id
      WHERE g.account_id=$1 AND a.enabled AND g.revoked_at IS NULL AND 'play'=ANY(g.scopes)
      AND EXISTS (
        SELECT 1 FROM mcp_event_subscriptions s
        WHERE s.account_id=g.account_id AND s.engine_key=g.engine_key AND s.event_name=$2 AND s.expires_at>now()
        AND (s.connection_id IS NULL OR EXISTS (
          SELECT 1 FROM oauth_connections c
          WHERE c.id=s.connection_id AND c.account_id=g.account_id AND c.engine_key=g.engine_key
          AND c.revoked_at IS NULL AND c.expires_at>now()
        ))
      ) ORDER BY g.engine_key`, [actor.accountId, INVITATION_EVENT])
    return { rivals: rows }
  }

  async function create(actor, data) {
    const format = normalizeFormat(data?.format)
    if (!isUuid(data?.tableId) || !isUuid(data.roomId) || !format || typeof data.password !== 'string'
      || data.password.length < 12 || data.password.length > 100) throw new ProductError(400, 'Provide a valid protected table')
    const mode = data.mode ?? 'friend'
    if (mode !== 'friend' && mode !== 'mcp') throw new ProductError(400, 'Invalid invitation mode')
    if (data.chatMode !== undefined && (mode !== 'mcp' || !CHAT_MODES.has(data.chatMode))) {
      throw new ProductError(400, 'Choose quiet, chatty, or coach for an MCP invitation')
    }
    const chatMode = data.chatMode ?? 'quiet'
    const notify = data.notifyEngineName !== undefined
    if (notify && (mode !== 'mcp' || typeof data.notifyEngineName !== 'string' || !/^[a-z0-9_-]{3,24}$/i.test(data.notifyEngineName.trim()))) {
      throw new ProductError(400, 'Select a delegated agent for the MCP invitation')
    }
    if (notify && actor.agent) throw new ProductError(403, 'Sign in as the host account to select an agent')
    let friend = null
    if (mode === 'friend') {
      friend = await identity.fromEngine(data.guestEngineName)
      if (!friend || normalize(friend.engineName) === normalize(actor.engineName) || !friend.scopes.includes('play')) {
        throw new ProductError(400, 'Provide a provisioned guest seat')
      }
    } else if (data.guestEngineName !== undefined) {
      throw new ProductError(400, 'An MCP invitation cannot name a guest account')
    }
    return transaction(pool, async db => {
      let invitee = friend?.engineName ?? null
      if (notify) {
        const { rows: [agent] } = await db.query(`SELECT g.engine_name FROM agent_grants g JOIN accounts a ON a.id=g.account_id
          WHERE g.account_id=$1 AND g.engine_key=$2 AND a.enabled AND g.revoked_at IS NULL AND 'play'=ANY(g.scopes)
          FOR SHARE OF g,a`, [actor.accountId, normalize(data.notifyEngineName)])
        if (!agent) throw new ProductError(400, 'Select an active agent from this account with play access')
        invitee = agent.engine_name
      }
      const { rows: [invite] } = await db.query(`INSERT INTO invitations(table_id,room_id,format,creator_key,invitee_key,invitee_name,table_password,expires_at,mode,chat_mode)
        VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '48 hours',$8,$9) ON CONFLICT (table_id) DO NOTHING RETURNING *`,
      [data.tableId, data.roomId, format, normalize(actor.engineName), invitee ? normalize(invitee) : null,
        invitee, data.password, mode, chatMode])
      if (!invite) throw new ProductError(409, 'This table already has an invitation')
      if (notify) {
        const queued = await events.enqueue(db, {
          accountId: actor.accountId, engineName: invitee, name: INVITATION_EVENT, key: invite.table_id,
          data: { tableId: invite.table_id, format },
        })
        if (!queued) throw new ProductError(409, 'This agent is no longer subscribed to invitations')
      }
      return invitationView(invite)
    })
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

  return { list, eventRivals, create, inspect, claim, admit }
}
