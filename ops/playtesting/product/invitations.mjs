import { isUuid, normalize, normalizeFormat, ProductError, transaction } from './decks.mjs'

const CHAT_MODES = new Set(['quiet', 'chatty', 'coach'])
const INVITATION_EVENT = 'game.invitation.created'

const rivalAccount = actor => actor.accountAgent === true ? actor.accountId : null

function invitationView(row) {
  if (!row) throw new ProductError(404, 'Invitation not found')
  return {
    tableId: row.table_id, roomId: row.room_id, format: row.format, mode: row.mode,
    ...(row.unlisted ? { unlisted: true } : {}),
    ...(row.mode === 'mcp' ? { chatMode: row.chat_mode } : {}),
    ...(row.guest_owner_name ? { guestOwnerName: row.guest_owner_name } : {}),
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

// Runtime details are declared by the participating client, never inferred from an OAuth client name.
function agentRuntime(actor, input) {
  const { model, reasoningEffort } = input ?? {}
  if ((model !== undefined || reasoningEffort !== undefined) && !actor.agent
      || model !== undefined && (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.:/_+-]{0,95}$/.test(model))
      || reasoningEffort !== undefined && (typeof reasoningEffort !== 'string' || !/^[a-z][a-z0-9_-]{0,23}$/.test(reasoningEffort))) {
    throw new ProductError(400, 'Invalid agent model or reasoning effort')
  }
  return [model ?? null, reasoningEffort ?? null]
}

const guestOwner = `(SELECT a.username FROM agent_grants g JOIN accounts a ON a.id=g.account_id
  WHERE g.engine_key=invitations.invitee_key) AS guest_owner_name`

export function createInvitations(pool, identity, events) {
  async function list(actor, requestedLimit) {
    const limit = Math.max(1, Math.min(50, Number.parseInt(requestedLimit, 10) || 25))
    const { rows } = await pool.query(
      `SELECT *, ${guestOwner} FROM invitations WHERE expires_at>now() AND NOT unlisted AND (
        (owner_account_id IS NULL AND invitee_key=$1)
        OR (owner_account_id=$2 AND (invitee_key IS NULL OR invitee_key=$1))
      ) ORDER BY expires_at DESC,table_id LIMIT $3`,
      [normalize(actor.engineName), rivalAccount(actor), limit],
    )
    return { invites: rows.map(invitationView) }
  }

  async function create(actor, data) {
    const runtime = agentRuntime(actor, data)
    const format = normalizeFormat(data?.format)
    if (!isUuid(data?.tableId) || !isUuid(data.roomId) || !format || typeof data.password !== 'string'
      || data.password.length < 12 || data.password.length > 100) throw new ProductError(400, 'Provide a valid protected table')
    const mode = data.mode ?? 'friend'
    if (mode !== 'friend' && mode !== 'mcp') throw new ProductError(400, 'Invalid invitation mode')
    if (mode === 'mcp' && actor.agent) throw new ProductError(403, 'Sign in as the host account to create an MCP invitation')
    if (data.chatMode !== undefined && (mode !== 'mcp' || !CHAT_MODES.has(data.chatMode))) {
      throw new ProductError(400, 'Choose quiet, chatty, or coach for an MCP invitation')
    }
    const chatMode = data.chatMode ?? 'quiet'
    if (data.notifyEngineName !== undefined) throw new ProductError(400, 'MCP invitations use the host account')
    const unlisted = mode === 'friend' && data.guestEngineName === undefined
    let friend = null
    if (mode === 'friend') {
      if (unlisted) {
        if (actor.agent) throw new ProductError(403, 'Sign in as the host account to create an unlisted invitation')
      } else {
        friend = await identity.fromEngine(data.guestEngineName)
        if (!friend || normalize(friend.engineName) === normalize(actor.engineName) || !friend.scopes.includes('play')) {
          throw new ProductError(400, 'Provide a provisioned guest seat')
        }
      }
    } else if (data.guestEngineName !== undefined) {
      throw new ProductError(400, 'An MCP invitation cannot name a guest account')
    }
    const ownerAccountId = mode === 'mcp' ? actor.accountId : null
    return transaction(pool, async db => {
      const invitee = friend?.engineName ?? null
      const { rows: [invite] } = await db.query(`INSERT INTO invitations(
        table_id,room_id,format,creator_key,invitee_key,invitee_name,table_password,expires_at,mode,chat_mode,owner_account_id,unlisted,creator_model,creator_effort
      ) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '48 hours',$8,$9,$10,$11,$12,$13) ON CONFLICT (table_id) DO NOTHING RETURNING *, ${guestOwner}`,
      [data.tableId, data.roomId, format, normalize(actor.engineName), invitee ? normalize(invitee) : null,
        invitee, data.password, mode, chatMode, ownerAccountId, unlisted, ...runtime])
      if (!invite) throw new ProductError(409, 'This table already has an invitation')
      if (ownerAccountId) {
        const { rows: [agent] } = await db.query(`SELECT engine_name FROM agent_grants
          WHERE account_id=$1 AND oauth_managed AND revoked_at IS NULL AND 'play'=ANY(scopes)`, [ownerAccountId])
        if (agent) await events.enqueue(db, {
          accountId: ownerAccountId, engineName: agent.engine_name, name: INVITATION_EVENT, key: invite.table_id,
          data: { tableId: invite.table_id, format },
        })
      }
      return invitationView(invite)
    })
  }

  async function inspect(actor, tableId) {
    const { rows: [invite] } = await pool.query(`SELECT *, ${guestOwner} FROM invitations WHERE table_id=$1 AND expires_at>now()
      AND (creator_key=$2
        OR (owner_account_id IS NULL AND (invitee_key=$2 OR (invitee_key IS NULL AND (
          (unlisted AND NOT $3) OR (mode='mcp' AND $3)))))
        OR (owner_account_id=$4 AND (invitee_key IS NULL OR invitee_key=$2)))`,
    [tableId, normalize(actor.engineName), actor.agent, rivalAccount(actor)])
    return invitationView(invite)
  }

  async function claim(actor, tableId, data) {
    const runtime = agentRuntime(actor, data)
    const alias = displayName(data?.displayName)
    const key = normalize(actor.engineName)
    const fallback = actor.accountAgent === true ? 'Rival MCP' : actor.engineName
    // The claim chooses the authenticated engine identity once. Retries by that identity keep the same alias.
    const { rows: [invite] } = await pool.query(`UPDATE invitations SET
      guest_model=CASE WHEN claimed_at IS NULL THEN $8 ELSE guest_model END,
      guest_effort=CASE WHEN claimed_at IS NULL THEN $9 ELSE guest_effort END,
      claimed_at=COALESCE(claimed_at,now()), invitee_key=COALESCE(invitee_key,$2), invitee_name=COALESCE(invitee_name,$3),
      guest_display_name=CASE WHEN mode='mcp' THEN COALESCE(guest_display_name,$4,$7) ELSE guest_display_name END
      WHERE table_id=$1 AND creator_key<>$2 AND expires_at>now()
        AND (owner_account_id IS NULL OR owner_account_id=$6) AND (
        (mode='friend' AND (invitee_key=$2 OR (unlisted AND invitee_key IS NULL AND NOT $5)))
        OR (mode='mcp' AND $5 AND (invitee_key IS NULL OR invitee_key=$2))
      ) RETURNING *, ${guestOwner}`, [tableId, key, actor.engineName, alias, actor.agent, rivalAccount(actor), fallback, ...runtime])
    return { ...invitationView(invite), password: invite.table_password }
  }

  async function admit(tableId, host, guest) {
    const { rowCount } = await pool.query(`SELECT 1 FROM invitations i
      WHERE table_id=$1 AND creator_key=$2 AND invitee_key=$3 AND claimed_at IS NOT NULL AND expires_at>now()
      AND (mode='friend' OR EXISTS (
        SELECT 1 FROM agent_grants g JOIN accounts a ON a.id=g.account_id
        WHERE g.engine_key=i.invitee_key AND g.revoked_at IS NULL AND 'play'=ANY(g.scopes) AND a.enabled
          AND (i.owner_account_id IS NULL OR (g.account_id=i.owner_account_id AND g.oauth_managed))
      ))`, [tableId, normalize(host), normalize(guest)])
    return Boolean(rowCount)
  }

  async function canViewByLink(tableId, host, viewer) {
    const { rowCount } = await pool.query(`SELECT 1 FROM invitations i
      JOIN accounts a ON a.username_key=$3 AND a.enabled
      WHERE i.table_id=$1 AND i.creator_key=$2 AND i.unlisted AND i.expires_at>now()
        AND (i.invitee_key IS NULL OR i.invitee_key=$3)`, [tableId, normalize(host), normalize(viewer)])
    return Boolean(rowCount)
  }

  return { list, create, inspect, claim, admit, canViewByLink }
}
