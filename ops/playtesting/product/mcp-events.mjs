import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { isUuid, normalize, ProductError, transaction } from './decks.mjs'
import { callbackError, decodeSecret, matchesChallenge, postWebhook, signedWebhookRequest, webhookUrl } from './mcp-events-webhook.mjs'

const invite = 'game.invitation.created'
const decision = 'game.decision.required'
const formats = ['Standard', 'Pioneer', 'Modern']
const day = 24 * 60 * 60 * 1000
const verificationLifetime = 60 * 60 * 1000
const subscriptionLimit = 20
const maxAttempts = 5
const verificationWindow = 60_000
const verificationLimit = 12
const uuid = { type: 'string', format: 'uuid' }
const string = { type: 'string', minLength: 1, maxLength: 120 }
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const definitions = [
  {
    name: invite,
    description: 'A Thoughtseize host privately invited your connected agent to an MCP table.',
    delivery: ['webhook'],
    inputSchema: schema({}),
    payloadSchema: schema({ tableId: uuid, format: { type: 'string', enum: formats } }, ['tableId', 'format']),
  },
  {
    name: decision,
    description: 'XMage is waiting for a legal action from your agent seat. Reload state before responding.',
    delivery: ['webhook'],
    inputSchema: schema({ gameId: uuid }),
    payloadSchema: schema({ gameId: uuid, decisionId: string, cursor: { type: 'integer', minimum: 0 }, kind: string },
      ['gameId', 'decisionId', 'cursor', 'kind']),
  },
]

const activeGrant = "g.revoked_at IS NULL AND a.enabled AND 'play'=ANY(g.scopes)"
const activeConnection = `(
  s.connection_id IS NULL OR EXISTS (
    SELECT 1 FROM oauth_connections c WHERE c.id=s.connection_id AND c.account_id=s.account_id
      AND c.engine_key=s.engine_key AND c.expires_at>now() AND c.revoked_at IS NULL
      AND 'play'=ANY(c.scopes_approved)
  )
)`

const asObject = value => value && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
const playable = actor => !!actor?.agent && isUuid(actor.accountId) && nonempty(actor.engineName, 36) && actor.scopes?.includes('play')

function principal(actor) {
  if (!playable(actor) || (actor.connectionId != null && !isUuid(actor.connectionId))) {
    throw new ProductError(403, 'A delegated play credential is required for game events.')
  }
  return [actor.accountId, normalize(actor.engineName), actor.connectionId ?? null]
}

function subscriptionRequest(actor, params) {
  const owner = principal(actor)
  if (!asObject(params) || !definitions.some(item => item.name === params.name)) {
    throw new ProductError(400, 'Choose a supported game event.')
  }
  const { name, delivery, arguments: args = {} } = params
  const game = args?.gameId
  if (!asObject(args) || Object.keys(args).some(key => key !== 'gameId')
      || (name === invite && Object.keys(args).length > 0) || (Object.hasOwn(args, 'gameId') && !isUuid(game))) {
    throw new ProductError(400, 'Use the event’s supported subscription filters.')
  }
  if (delivery?.mode !== 'webhook') throw new ProductError(400, 'Game events support webhook delivery.')
  const url = webhookUrl(delivery.url).href
  const match = [name, game?.toLowerCase() ?? null, url]
  const id = 'sub_' + createHash('sha256').update(JSON.stringify([...owner, ...match])).digest('base64url')
  return { owner, match, id }
}

function expiresIn(ttlMs) {
  if (ttlMs == null) return day
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new ProductError(400, 'Subscription lifetime must be positive.')
  return Math.min(day, ttlMs)
}

function eventFields(name, data) {
  if (!asObject(data)) throw new ProductError(400, 'Invalid event payload.')
  if (name === invite && isUuid(data.tableId) && formats.includes(data.format) && Object.keys(data).length === 2) {
    return [data.tableId, data.format, null, null, null, null]
  }
  if (name === decision && isUuid(data.gameId) && nonempty(data.decisionId, 120) && nonempty(data.kind, 120)
      && Number.isSafeInteger(data.cursor) && data.cursor >= 0 && Object.keys(data).length === 4) {
    return [null, null, data.gameId, data.decisionId, data.cursor, data.kind]
  }
  throw new ProductError(400, 'Invalid event payload.')
}

export function createMcpEvents(pool, { deliver = postWebhook, intervalMs = 400 } = {}) {
  let timer
  let draining
  let sweptAt = 0
  const verificationAttempts = new Map()

  function throttleVerification(accountId) {
    const now = Date.now()
    const previous = verificationAttempts.get(accountId)
    const bucket = previous?.until > now ? previous : { count: 0, until: now + verificationWindow }
    if (++bucket.count > verificationLimit) throw new ProductError(429, 'Too many webhook verification requests.')
    verificationAttempts.set(accountId, bucket)
  }

  async function stillAuthorized(db, owner, lock = false) {
    const { rowCount } = await db.query(`
      SELECT 1 FROM agent_grants g JOIN accounts a ON a.id=g.account_id
      WHERE g.account_id=$1 AND g.engine_key=$2 AND ${activeGrant}
        AND ($3::uuid IS NULL OR EXISTS (
          SELECT 1 FROM oauth_connections c WHERE c.id=$3 AND c.account_id=$1 AND c.engine_key=$2
            AND c.expires_at>now() AND c.revoked_at IS NULL AND 'play'=ANY(c.scopes_approved)
        )) ${lock ? 'FOR UPDATE OF g' : ''}
    `, owner)
    if (!rowCount) throw new ProductError(403, 'This game event credential is inactive.')
  }

  function list(actor) {
    return { events: playable(actor) ? definitions : [] }
  }

  async function subscribe(actor, params) {
    const { owner, match, id } = subscriptionRequest(actor, params)
    const secret = decodeSecret(params.delivery.secret)
    const [name, game, url] = match
    const lifetime = expiresIn(params.ttlMs)
    await stillAuthorized(pool, owner)
    const { rows: [cached] } = await pool.query(`
      SELECT verified_at FROM mcp_event_subscriptions
      WHERE account_id=$1 AND engine_key=$2 AND connection_id IS NOT DISTINCT FROM $3::uuid
        AND callback_url=$4 AND secret=$5 AND verified_at>now()-($6::bigint*interval '1 millisecond')
      ORDER BY verified_at DESC LIMIT 1
    `, [...owner, url, secret, verificationLifetime])
    if (!cached) {
      throttleVerification(owner[0])
      const challenge = randomBytes(32).toString('base64url')
      const body = { type: 'verification', challenge }
      const result = await deliver(url, signedWebhookRequest(id, 'vfy_' + randomUUID(), body, secret))
      if (result.status < 200 || result.status >= 300 || !matchesChallenge(result.body, challenge)) {
        throw callbackError('challenge_failed')
      }
    }
    const expires = await transaction(pool, async db => {
      await stillAuthorized(db, owner, true)
      const { rows: [limit] } = await db.query(`
        SELECT count(*)::int AS count FROM mcp_event_subscriptions
        WHERE account_id=$1 AND engine_key=$2 AND expires_at>now() AND id<>$3
      `, [owner[0], owner[1], id])
      if (limit.count >= subscriptionLimit) throw new ProductError(429, 'This agent reached its game event subscription limit.')
      const { rows: [row] } = await db.query(`
        INSERT INTO mcp_event_subscriptions(id,account_id,engine_key,connection_id,event_name,game_filter,
          callback_url,secret,verified_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,now()),now()+($10::bigint*interval '1 millisecond'))
        ON CONFLICT(id) DO UPDATE SET
          previous_secret=CASE WHEN mcp_event_subscriptions.secret<>EXCLUDED.secret
            THEN mcp_event_subscriptions.secret ELSE mcp_event_subscriptions.previous_secret END,
          previous_secret_until=CASE WHEN mcp_event_subscriptions.secret<>EXCLUDED.secret
            THEN now()+interval '5 minutes' ELSE mcp_event_subscriptions.previous_secret_until END,
          secret=EXCLUDED.secret,verified_at=EXCLUDED.verified_at,expires_at=EXCLUDED.expires_at
        RETURNING expires_at
      `, [id, ...owner, name, game, url, secret, cached?.verified_at ?? null, lifetime])
      return row.expires_at
    })
    return { id, refreshBefore: expires.toISOString(), cursor: null, truncated: false }
  }

  async function unsubscribe(actor, params) {
    const { id, owner } = subscriptionRequest(actor, params)
    await pool.query(`
      DELETE FROM mcp_event_subscriptions
      WHERE id=$1 AND account_id=$2 AND engine_key=$3 AND connection_id IS NOT DISTINCT FROM $4::uuid
    `, [id, ...owner])
    return {}
  }

  async function enqueue(db, { accountId, engineName, name, key, data, expiresAt, occurredAt }) {
    const fields = eventFields(name, data)
    const expires = new Date(expiresAt ?? Date.now() + (name === decision ? 15_000 : 600_000))
    const occurred = new Date(occurredAt ?? Date.now())
    if (!isUuid(accountId) || !nonempty(engineName, 36) || !nonempty(key, 240)
        || !Number.isFinite(expires.getTime()) || !Number.isFinite(occurred.getTime())) {
      throw new ProductError(400, 'Invalid game event recipient or lifetime.')
    }
    const { rowCount } = await db.query(`
      WITH accepted AS MATERIALIZED (
        SELECT s.id FROM mcp_event_subscriptions s
        JOIN agent_grants g ON g.engine_key=s.engine_key AND g.account_id=s.account_id
        JOIN accounts a ON a.id=s.account_id
        WHERE s.account_id=$2 AND s.engine_key=$3 AND s.event_name=$4
          AND (s.game_filter IS NULL OR s.game_filter=$8) AND s.expires_at>now()
          AND ${activeGrant} AND ${activeConnection}
        FOR KEY SHARE OF s
      ), published AS (
        INSERT INTO mcp_events(id,account_id,engine_key,event_name,event_key,
          table_id,format,game_id,decision_id,cursor,kind,expires_at,occurred_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
        WHERE EXISTS (SELECT 1 FROM accepted) AND $12>now()
        ON CONFLICT(account_id,engine_key,event_name,event_key) DO NOTHING
        RETURNING id
      )
      INSERT INTO mcp_event_deliveries(event_id,subscription_id)
      SELECT published.id,accepted.id FROM published CROSS JOIN accepted
    `, ['evt_' + randomUUID(), accountId, normalize(engineName), name, key, ...fields, expires, occurred])
    return rowCount
  }

  async function invalidate(db, { accountId, engineName, name, key }) {
    await db.query(`
      UPDATE mcp_events SET expires_at=least(expires_at,now())
      WHERE account_id=$1 AND engine_key=$2 AND event_name=$3 AND event_key=$4
    `, [accountId, normalize(engineName), name, key])
  }

  async function eligibleDelivery(eventId, subscriptionId, leaseId) {
    const { rows: [row] } = await pool.query(`
      SELECT e.*,s.id AS subscription_id,s.callback_url,s.secret,s.previous_secret,
        s.previous_secret_until,d.attempts
      FROM mcp_event_deliveries d
      JOIN mcp_events e ON e.id=d.event_id
      JOIN mcp_event_subscriptions s ON s.id=d.subscription_id
      JOIN agent_grants g ON g.engine_key=s.engine_key AND g.account_id=s.account_id
      JOIN accounts a ON a.id=s.account_id
      WHERE d.event_id=$1 AND d.subscription_id=$2 AND d.lease_id=$3
        AND s.expires_at>now() AND e.expires_at>now() AND ${activeGrant} AND ${activeConnection}
    `, [eventId, subscriptionId, leaseId])
    return row
  }

  async function attempt(eventId, subId, leaseId) {
    const row = await eligibleDelivery(eventId, subId, leaseId)
    let retry = false
    if (row) {
      const data = row.event_name === invite
        ? { tableId: row.table_id, format: row.format }
        : { gameId: row.game_id, decisionId: row.decision_id, cursor: Number(row.cursor), kind: row.kind }
      const event = { eventId, name: row.event_name, timestamp: row.occurred_at.toISOString(), data, cursor: null }
      const now = new Date()
      const previous = row.previous_secret_until > now ? row.previous_secret : null
      try {
        const response = await deliver(row.callback_url, signedWebhookRequest(subId, eventId, event, row.secret, now, previous))
        retry = response.status === 429 || response.status >= 500
      } catch (error) {
        retry = error.reason !== 'invalid_url' && error.reason !== 'response_too_large'
      }
    }
    if (retry && row.attempts + 1 < maxAttempts) {
      const delay = Math.min(30_000, 1000 * 2 ** row.attempts)
      await pool.query(`
        UPDATE mcp_event_deliveries
        SET attempts=attempts+1,available_at=now()+($4::bigint*interval '1 millisecond'),lease_id=NULL,lease_until=NULL
        WHERE event_id=$1 AND subscription_id=$2 AND lease_id=$3
      `, [eventId, subId, leaseId, delay])
    } else {
      await pool.query(`
        DELETE FROM mcp_event_deliveries WHERE event_id=$1 AND subscription_id=$2 AND lease_id=$3
      `, [eventId, subId, leaseId])
    }
  }

  async function sweep() {
    const now = Date.now()
    if (now - sweptAt < 60_000) return
    sweptAt = now
    for (const [accountId, { until }] of verificationAttempts) {
      if (until <= now) verificationAttempts.delete(accountId)
    }
    await pool.query(`
      UPDATE mcp_event_subscriptions SET previous_secret=NULL,previous_secret_until=NULL
        WHERE previous_secret_until<=now();
      DELETE FROM mcp_event_subscriptions s WHERE s.expires_at<=now()
        OR NOT EXISTS (SELECT 1 FROM agent_grants g JOIN accounts a ON a.id=g.account_id
          WHERE g.account_id=s.account_id AND g.engine_key=s.engine_key AND ${activeGrant})
        OR NOT ${activeConnection};
      DELETE FROM mcp_events WHERE expires_at<now()-interval '1 day';
    `)
  }

  async function batch() {
    const leaseId = randomUUID()
    const { rows } = await pool.query(`
      WITH pending AS (
        SELECT event_id,subscription_id FROM mcp_event_deliveries
        WHERE available_at<=now() AND (lease_until IS NULL OR lease_until<=now())
        ORDER BY available_at,event_id,subscription_id LIMIT 8 FOR UPDATE SKIP LOCKED
      )
      UPDATE mcp_event_deliveries d SET lease_id=$1,lease_until=now()+interval '30 seconds'
      FROM pending p WHERE d.event_id=p.event_id AND d.subscription_id=p.subscription_id
      RETURNING d.event_id,d.subscription_id
    `, [leaseId])
    await Promise.all(rows.map(({ event_id: eventId, subscription_id: subId }) => attempt(eventId, subId, leaseId)))
    await sweep()
  }

  function drain() {
    if (!draining) draining = batch().finally(() => { draining = undefined })
    return draining
  }

  function start() {
    if (timer) return
    const run = () => { void drain().catch(() => console.warn('Playmat event delivery will retry.')) }
    timer = setInterval(run, intervalMs)
    timer.unref()
    run()
  }

  async function stop() {
    clearInterval(timer)
    timer = undefined
    await draining?.catch(() => {})
  }

  return { list, subscribe, unsubscribe, enqueue, invalidate, start, stop, drain }
}
