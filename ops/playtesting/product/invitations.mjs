import { randomBytes } from 'node:crypto'
import { canonicalAccountScope } from './players.mjs'
import { issuePublicSpectatorLink } from './spectator-links.mjs'
import { checkInvitationReservation } from './player-reservations.mjs'
import { isUuid, normalize, normalizeFormat, ProductError, transaction } from './decks.mjs'
import { declaredRuntime, readPlayerRuntime, runtimeFields } from './player-runtime.mjs'

const CHAT_MODES = new Set(['quiet', 'chatty', 'coach'])
const INVITATION_EVENT = 'game.invitation.created'

const assignmentAccount = actor => actor.accountSelected || canonicalAccountScope(actor,'play') ? actor.accountId : null
const inboxConnection = actor => canonicalAccountScope(actor,'play') ? actor.connectionId : null
const profileInvite = parameter => `EXISTS (SELECT 1 FROM playable_oauth_seats s WHERE s.connection_id=${parameter}
  AND s.delegated AND s.engine_key=invitations.invitee_key)`
const rivalAccount = actor => actor.accountAgent === true ? actor.accountId : null

// A blank human-hosted Rival MCP carries the authenticated host owner even in historical rows.
// An unowned legacy link or an expressly named seat is never inferred from an engine name.
const assignmentOwner = `COALESCE(recipient_account_id,CASE WHEN mode='mcp' AND NOT unlisted
  AND ((invitee_key IS NULL AND invitee_name IS NULL AND claimed_at IS NULL) OR (claimed_at IS NOT NULL AND invitee_key IS NOT NULL))
  AND EXISTS (SELECT 1 FROM accounts h WHERE h.id=invitations.owner_account_id AND h.username_key=invitations.creator_key)
  THEN owner_account_id END)`
const externalLink = `EXISTS (SELECT 1 FROM external_mcp_invite_links e WHERE e.table_id=invitations.table_id)`
const externalSeat = (token,account,key) => `(mode='mcp' AND owner_account_id<>${account} AND (invitee_key IS NULL OR invitee_key=${key})
  AND EXISTS (SELECT 1 FROM external_mcp_invite_links e WHERE e.table_id=invitations.table_id AND e.capability=${token}))`
const linkForPilot = (actor,token)=>actor.agent && actor.scopes.includes('play') && typeof token==='string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null

function invitationView(row,actor) {
  if (!row) throw new ProductError(404, 'Invitation not found')
  let guestAccountName=row.recipient_name
  if (row.allow_external_mcp) {
    guestAccountName=row.invitee_key ? row.guest_owner_name : row.owner_account_id===actor.accountId ? row.recipient_name : null
  }
  return {
    tableId: row.table_id, roomId: row.room_id, format: row.format, mode: row.mode, claimed:!!row.claimed_at,
    ...(row.spectator_both_hands ? {spectatorVisibility:'both-hands',requiresSpectatorAcceptance:row.spectator_guest_consent_required} : {}),
    ...(row.unlisted ? { unlisted: true } : {}),
    ...(row.mode === 'mcp' ? { chatMode: row.chat_mode } : {}),
    ...(row.guest_owner_name ? { guestOwnerName: row.guest_owner_name } : {}),
    ...(row.allow_external_mcp ? {allowExternalMcp:true} : {}),
    ...(guestAccountName ? {guestAccountName} : {}),
    ...(row.recipient_name ? {requiresPlayerAssignment:!row.invitee_key} : {}),
    ...(row.guest_player_id ? {guestPlayerId:row.guest_player_id} : {}),
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
  const runtime = declaredRuntime(runtimeFields(input))
  if (!actor.agent && Object.keys(runtime).length) throw new ProductError(400,'Only MCP players can declare a runtime')
  return runtime
}

const guestOwner = `(SELECT a.username FROM agent_grants g JOIN accounts a ON a.id=g.account_id
  WHERE g.engine_key=invitations.invitee_key) AS guest_owner_name,
  (SELECT g.player_id FROM agent_grants g WHERE g.engine_key=invitations.invitee_key) AS guest_player_id,
  (SELECT a.username FROM accounts a WHERE a.id=${assignmentOwner}) AS recipient_name, ${externalLink} AS allow_external_mcp`

export function createInvitations(pool, identity, events) {
  async function list(actor, requestedLimit,tableId=null,token=null) {
    if (tableId!==null && !isUuid(tableId)) throw new ProductError(400,'Provide a valid table ID')
    const limit = Math.max(1, Math.min(50, Number.parseInt(requestedLimit, 10) || 25))
    const { rows } = await pool.query(
      `SELECT *, ${guestOwner} FROM invitations WHERE expires_at>now() AND NOT cancel_pending AND NOT unlisted AND ($6::uuid IS NULL OR table_id=$6)
        AND (NOT ${externalLink} OR owner_account_id=$8 OR ($6 IS NOT NULL AND ${externalSeat('$7','$8','$1')})) AND (
        (owner_account_id IS NULL AND invitee_key=$1)
        OR (owner_account_id=$2 AND (invitee_key IS NULL OR invitee_key=$1))
        OR (${assignmentOwner}=$4 AND (invitee_key IS NULL OR invitee_key=$1)) OR ${profileInvite('$5')}
        OR ($6 IS NOT NULL AND ${externalSeat('$7','$8','$1')})
      ) ORDER BY (claimed_at IS NULL) DESC,expires_at DESC,table_id LIMIT $3`,
      [normalize(actor.engineName), rivalAccount(actor), limit, assignmentAccount(actor),inboxConnection(actor),tableId,linkForPilot(actor,token),actor.accountId],
    )
    return { invites: rows.map(row=>invitationView(row,actor)) }
  }

  async function create(actor, data, {trustedPilot=false}={}) {
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
    const selectors=[data.guestEngineName,data.guestPlayerId,data.guestAccountName].filter(value=>value!==undefined)
    if (selectors.length>1 || (mode==='mcp' && data.guestEngineName!==undefined)) throw new ProductError(400,'Choose one valid invitation recipient')
    if (data.allowExternalMcp!==undefined && (typeof data.allowExternalMcp!=='boolean' || mode!=='mcp' || actor.agent || selectors.length)) {
      throw new ProductError(400,'External MCP invitations require a human host and an open MCP opponent')
    }
    const unlisted = mode === 'friend' && !selectors.length
    if (unlisted && actor.agent) throw new ProductError(403,'Sign in as the host account to create an unlisted invitation')
    let friend=null, recipient=null
    if (data.guestAccountName !== undefined) {
      if (typeof data.guestAccountName!=='string' || !/^[a-z0-9_-]{3,24}$/i.test(data.guestAccountName)) throw new ProductError(400,'Provide a valid recipient account')
      const {rows:[account]}=await pool.query('SELECT id FROM accounts WHERE username_key=$1 AND enabled',[normalize(data.guestAccountName)])
      if (!account) throw new ProductError(400,'Provide a valid recipient account')
      recipient=account.id
    } else if (selectors.length) {
      if (data.guestPlayerId !== undefined) {
        if (isUuid(data.guestPlayerId)) {
          const {rows:[slot]}=await pool.query(`SELECT g.engine_name AS "engineName",g.account_id AS "accountId",true AS agent,g.scopes
            FROM player_profiles p JOIN accounts a ON a.id=p.account_id AND a.enabled
            JOIN agent_grants g ON g.player_id=p.id AND g.revoked_at IS NULL WHERE p.id=$1 AND p.mcp_enabled`,[data.guestPlayerId])
          friend=slot
        }
      } else friend=await identity.fromEngine(data.guestEngineName)
      if (!friend || normalize(friend.engineName)===normalize(actor.engineName) || !friend.scopes.includes('play'))
        throw new ProductError(400,'Provide a provisioned guest seat')
    }
    const visibility=data.spectatorVisibility??'public-board'
    if (!['public-board','both-hands'].includes(visibility)) throw new ProductError(400,'Unknown spectator visibility')
    const bothHands=visibility==='both-hands'
    if (bothHands && !(trustedPilot && actor.agent && mode==='friend' && (friend?.agent || recipient))) {
      throw new ProductError(403,'Both hands requires a trusted MCP host and an invited MCP guest')
    }
    const guestConsent=bothHands && actor.accountId!==(recipient??friend?.accountId)
    const ownerAccountId = mode === 'mcp' && !selectors.length ? actor.accountId : null
    const title=typeof data.tableName==='string' ? [...data.tableName.trim()].slice(0,80).join('') || null : null
    return transaction(pool, async db => {
      await checkInvitationReservation(db,actor,data.tableId)
      const { provider, model, reasoningEffort } = { ...await readPlayerRuntime(db,actor), ...runtime }
      const invitee = friend?.engineName ?? null
      const { rows: [invite] } = await db.query(`INSERT INTO invitations(
        table_id,room_id,format,creator_key,invitee_key,invitee_name,table_password,expires_at,mode,chat_mode,owner_account_id,unlisted,creator_model,creator_effort,recipient_account_id,broadcast_on_assignment,table_name,spectator_both_hands,spectator_guest_consent_required,creator_provider
      ) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '48 hours',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT (table_id) DO NOTHING RETURNING *, ${guestOwner}`,
      [data.tableId, data.roomId, format, normalize(actor.engineName), invitee ? normalize(invitee) : null,
        invitee, data.password, mode, chatMode, ownerAccountId, unlisted, model,reasoningEffort,recipient,
        !!(trustedPilot && actor.agent && recipient),title,bothHands,guestConsent,provider])
      // Only a trusted adapter creates public broadcasts for MCP seats. External product
      // requests cannot nominate an arbitrary engine table for public sharing.
      const automatic = trustedPilot && actor.agent && friend?.agent
      if (!invite) {
        if (automatic || recipient || data.guestPlayerId) {
          const {rows:[same]} = await db.query(`SELECT *, ${guestOwner} FROM invitations WHERE table_id=$1 AND room_id=$2
            AND creator_key=$3 AND format=$5 AND table_password=$6 AND mode=$7 AND NOT cancel_pending AND expires_at>now()
            AND recipient_account_id IS NOT DISTINCT FROM $8::uuid AND ($8::uuid IS NOT NULL OR invitee_key=$4)
            AND spectator_both_hands=$10 AND (NOT $9 OR EXISTS (SELECT 1 FROM spectator_links l WHERE l.table_id=$1 AND l.public_host=$3 AND l.public_guest=$4))`,
            [data.tableId,data.roomId,normalize(actor.engineName),friend ? normalize(friend.engineName) : null,format,data.password,mode,recipient,Boolean(automatic),bothHands])
          if (same) return invitationView(same,actor)
        }
        throw new ProductError(409, 'This table already has an invitation')
      }
      if (data.allowExternalMcp) {
        await db.query('INSERT INTO external_mcp_invite_links(table_id,capability) VALUES($1,$2)',[data.tableId,randomBytes(32).toString('base64url')])
        invite.allow_external_mcp=true
      }
      if (automatic || invite.broadcast_on_assignment) await issuePublicSpectatorLink(db,data.tableId,actor,friend,title,bothHands)
      if (ownerAccountId) {
        const { rows: [agent] } = await db.query(`SELECT engine_name FROM agent_grants
          WHERE account_id=$1 AND oauth_managed AND player_id IS NULL AND revoked_at IS NULL AND 'play'=ANY(scopes)`, [ownerAccountId])
        if (agent) await events.enqueue(db, {
          accountId: ownerAccountId, engineName: agent.engine_name, name: INVITATION_EVENT, key: invite.table_id,
          data: { tableId: invite.table_id, format },
        })
      }
      return invitationView(invite,actor)
    })
  }

  async function shareLink(actor,tableId) {
    if (actor.agent) throw new ProductError(403,'Only the browser host can share an invitation')
    const {rows:[row]}=await pool.query(`SELECT owner_account_id=$2 AS owned,CASE WHEN owner_account_id=$2 THEN e.capability END AS capability
      FROM invitations i LEFT JOIN external_mcp_invite_links e USING(table_id) WHERE table_id=$1 AND i.expires_at>now()
        AND NOT i.cancel_pending`,[tableId,actor.accountId])
    if (!row?.owned) throw new ProductError(403,'Only the browser host can share an invitation')
    if (!row.capability) throw new ProductError(404,'External invitation not found')
    return {path:'/join/mcp/'+tableId+'#invite='+row.capability}
  }

  async function inspect(actor, tableId,token=null) {
    const { rows: [invite] } = await pool.query(`SELECT *, ${guestOwner} FROM invitations WHERE table_id=$1 AND NOT cancel_pending AND expires_at>now()
      AND (NOT ${externalLink} OR owner_account_id=$9 OR ${externalSeat('$8','$9','$2')})
      AND (creator_key=$2 OR ${externalSeat('$8','$9','$2')}
        OR (owner_account_id IS NULL AND (invitee_key=$2 OR (recipient_account_id IS NULL AND invitee_key IS NULL AND (
          (unlisted AND NOT $3) OR (mode='mcp' AND $3)))))
        OR (owner_account_id=$4 AND (invitee_key IS NULL OR invitee_key=$2))
        OR (${assignmentOwner}=$6 AND (invitee_key IS NULL OR invitee_key=$2)) OR ${profileInvite('$7')})
      AND (NOT $5 OR creator_key=$2 OR invitee_key=$2 OR ${externalSeat('$8','$9','$2')} OR (${assignmentOwner}=$6 AND (invitee_key IS NULL OR invitee_key=$2)))`,
    [tableId, normalize(actor.engineName), actor.agent, rivalAccount(actor), !!actor.playerId, assignmentAccount(actor),inboxConnection(actor),linkForPilot(actor,token),actor.accountId])
    return invitationView(invite,actor)
  }

  async function claim(actor, tableId, data,token=null) {
    const runtime = agentRuntime(actor, data)
    const alias = actor.playerId ? actor.displayName : displayName(data?.displayName)
    const key = normalize(actor.engineName)
    const fallback = actor.accountAgent === true ? 'Rival MCP' : actor.engineName
    // The claim chooses the authenticated engine identity once. Retries by that identity keep the same alias.
    return transaction(pool,async db => {
      await checkInvitationReservation(db,actor,tableId)
      const { provider, model, reasoningEffort } = { ...await readPlayerRuntime(db,actor), ...runtime }
      const { rows: [invite] } = await db.query(`UPDATE invitations SET
        spectator_settings_locked=true,
        spectator_guest_consent_required=spectator_guest_consent_required AND NOT $12,
        guest_model=CASE WHEN claimed_at IS NULL THEN $8 ELSE guest_model END,
        guest_effort=CASE WHEN claimed_at IS NULL THEN $9 ELSE guest_effort END,
        guest_provider=CASE WHEN claimed_at IS NULL THEN $15 ELSE guest_provider END,
        claimed_at=COALESCE(claimed_at,now()), invitee_key=COALESCE(invitee_key,$2), invitee_name=COALESCE(invitee_name,$3),
        guest_display_name=CASE WHEN $10 THEN $4 WHEN mode='mcp' THEN COALESCE(guest_display_name,$4,$7) ELSE guest_display_name END
        WHERE table_id=$1 AND NOT cancel_pending AND creator_key<>$2 AND expires_at>now()
          AND (NOT ${externalLink} OR owner_account_id=$14 OR ${externalSeat('$13','$14','$2')})
          AND (${externalSeat('$13','$14','$2')} OR (${assignmentOwner}=$11 AND (invitee_key IS NULL OR invitee_key=$2))
            OR (recipient_account_id IS NULL OR invitee_key=$2) AND (owner_account_id IS NULL OR owner_account_id=$6) AND (NOT $10 OR invitee_key=$2) AND (
          (mode='friend' AND (invitee_key=$2 OR (unlisted AND invitee_key IS NULL AND NOT $5)))
          OR (mode='mcp' AND $5 AND (invitee_key IS NULL OR invitee_key=$2))
        )) RETURNING *, ${guestOwner}`, [tableId, key, actor.engineName, alias, actor.agent, rivalAccount(actor), fallback,
        model,reasoningEffort,!!actor.playerId,actor.accountSelected ? actor.accountId : null,
        data?.acceptSpectatorVisibility==='both-hands',linkForPilot(actor,token),actor.accountId,provider])
      const projection=invitationView(invite,actor)
      if (data?.expectedSpectatorVisibility!==undefined && data.expectedSpectatorVisibility!==(invite.spectator_both_hands?'both-hands':'public-board')) {
        throw new ProductError(409,'Spectator visibility changed. Review this invitation again before joining')
      }
      if (invite.spectator_guest_consent_required && data?.acceptSpectatorVisibility!=='both-hands') {
        throw new ProductError(403,'Explicitly accept both-hands spectating before joining this invitation')
      }
      if (invite.broadcast_on_assignment) {
        const {rows:[host]}=await db.query(`SELECT g.account_id AS "accountId",g.engine_name AS "engineName"
          FROM agent_grants g JOIN accounts a ON a.id=g.account_id AND a.enabled
          WHERE g.engine_key=$1 AND g.revoked_at IS NULL AND 'play'=ANY(g.scopes)`,[invite.creator_key])
        if (!host) throw new ProductError(409,'The host seat is no longer eligible')
        await issuePublicSpectatorLink(db,tableId,host,actor,invite.table_name,invite.spectator_both_hands)
      }
      return { ...projection, password: invite.table_password }
    })
  }

  async function admit(tableId, host, guest) {
    const { rowCount } = await pool.query(`SELECT 1 FROM invitations i
      WHERE table_id=$1 AND creator_key=$2 AND invitee_key=$3 AND claimed_at IS NOT NULL AND expires_at>now()
      AND ((mode='friend' AND NOT EXISTS (SELECT 1 FROM agent_grants agent WHERE agent.engine_key=i.invitee_key)) OR EXISTS (
        SELECT 1 FROM agent_grants g JOIN accounts a ON a.id=g.account_id
        WHERE g.engine_key=i.invitee_key AND g.revoked_at IS NULL AND 'play'=ANY(g.scopes) AND a.enabled
          AND (i.owner_account_id IS NULL OR (g.account_id=i.owner_account_id AND g.oauth_managed)
            OR (g.account_id<>i.owner_account_id AND EXISTS (SELECT 1 FROM external_mcp_invite_links e WHERE e.table_id=i.table_id)))
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

  return { list, create, inspect, claim, admit, canViewByLink, shareLink }
}
