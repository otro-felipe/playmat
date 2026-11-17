import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import pg from 'pg'

const databaseUrl = process.env.PLAYMAT_TEST_DATABASE_URL
const signingKey = Buffer.alloc(32, 19)
const secret = 'whsec_' + signingKey.toString('base64')
const inviteEvent = 'game.invitation.created'
const decisionEvent = 'game.decision.required'
const callback = 'https://receiver.example.net/callback?sub=1'

test('the webhook resolves once and rejects nonpublic addresses even when DNS also returns a public address', async () => {
  const { resolveWebhookTarget } = await import('./mcp-events-webhook.mjs')
  const resolve = async () => [{ address: '8.8.8.8', family: 4 }]
  assert.deepEqual(await resolveWebhookTarget(callback, resolve), { url: new URL(callback), address: '8.8.8.8', family: 4 })
  const denied = [
    ['0.42.42.42', 4], ['10.0.0.1', 4], ['100.100.100.200', 4], ['127.9.8.7', 4], ['169.254.169.254', 4],
    ['172.31.255.254', 4], ['192.0.0.1', 4], ['192.168.1.10', 4], ['198.18.1.1', 4],
    ['168.63.129.16', 4], ['224.1.2.3', 4], ['240.1.2.3', 4], ['::1', 6], ['::ffff:8.8.8.8', 6],
    ['fc00::1', 6], ['fe80::1', 6], ['2001:db8::1', 6], ['2002:7f00:1::', 6], ['3fff::1', 6],
  ]
  for (const [address, family] of denied) {
    await assert.rejects(resolveWebhookTarget(callback, async () => [{ address: '8.8.8.8', family: 4 }, { address, family }]),
      error => error.reason === 'invalid_url')
  }
  for (const url of ['http://receiver.example.net', 'https://x@y.example.net', 'https://example.net#fragment',
    'https://localhost', 'https://host.internal', 'https://2130706433/', 'https://[::1]/']) {
    await assert.rejects(resolveWebhookTarget(url, resolve), error => error.reason === 'invalid_url')
  }
  assert.equal((await resolveWebhookTarget(callback, async () => [{ address: '2606:4700:4700::1111', family: 6 }])).family, 6)
})

test('Standard Webhooks headers sign the exact bytes and their delivery identity', async () => {
  const { signedWebhookRequest, decodeSecret } = await import('./mcp-events-webhook.mjs')
  const at = new Date('2026-11-17T22:10:00.902Z')
  const payload = { eventId: 'evt_test', name: inviteEvent, data: { format: 'Pioneer' } }
  const { headers, body } = signedWebhookRequest('sub_test', payload.eventId, payload, decodeSecret(secret), at)
  const seconds = String(Math.floor(at.valueOf() / 1000))
  const expected = createHmac('sha256', signingKey).update(['evt_test', seconds, JSON.stringify(payload)].join('.')).digest('base64')
  assert.equal(headers['webhook-id'], payload.eventId)
  assert.equal(headers['webhook-timestamp'], seconds)
  assert.equal(headers['x-mcp-subscription-id'], 'sub_test')
  assert.equal(headers['webhook-signature'], 'v1,' + expected)
  assert.deepEqual(JSON.parse(body), payload)
  for (const value of ['wrong', 'whsec_YQ==', 'whsec_' + 'A'.repeat(128), secret + 'x']) assert.throws(() => decodeSecret(value))
})

async function fixture(t) {
  const schema = 'test_events_' + randomUUID().replaceAll('-', '')
  const pool = new pg.Pool({ connectionString: databaseUrl, options: '-c search_path=' + schema })
  await pool.query('CREATE SCHEMA ' + schema)
  await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'))
  await pool.query(await readFile(new URL('./oauth-schema.sql', import.meta.url), 'utf8'))
  t.after(async () => {
    await pool.query('DROP SCHEMA ' + schema + ' CASCADE')
    await pool.end()
  })
  async function addAgent(engineName) {
    const accountId = randomUUID()
    await pool.query('INSERT INTO accounts(id,username,username_key,password_hash) VALUES($1,$2,$3,$4)',
      [accountId, engineName + 'Owner', (engineName + 'Owner').toLowerCase(), 'fixture'])
    await pool.query('INSERT INTO agent_grants(digest,account_id,engine_name,engine_key,scopes) VALUES($1,$2,$3,$4,$5)',
      [engineName + '-test-digest', accountId, engineName, engineName.toLowerCase(), ['play']])
    return { accountId, engineName, scopes: ['play'], agent: true }
  }
  return { pool, alice: await addAgent('ChessAlice'), bob: await addAgent('ChessBob') }
}

function params(name, args = {}, ttlMs) {
  return { name, arguments: args, delivery: { mode: 'webhook', url: callback, secret }, cursor: null, ttlMs }
}

function event(owner, name, data) {
  const { accountId, engineName } = owner
  return { accountId, engineName, name, key: randomUUID(), data }
}

test('a verified subscription survives worker restart, filters the game and deduplicates enqueue and retry', { skip: !databaseUrl }, async t => {
  const { createMcpEvents } = await import('./mcp-events.mjs')
  const { pool, alice, bob } = await fixture(t)
  const gameId = randomUUID()
  const verification = []
  const received = []
  const deliver = async (url, { headers, body }) => {
    assert.equal(url, callback)
    const data = JSON.parse(body)
    if (data.type === 'verification') {
      verification.push(data.challenge)
      return { status: 200, body: JSON.stringify({ challenge: data.challenge }) }
    }
    received.push({ data, headers })
    return { status: received.length === 1 ? 503 : 204, body: '' }
  }
  const initial = createMcpEvents(pool, { deliver })
  const granted = await initial.subscribe(alice, params(decisionEvent, { gameId }, 60_000))
  assert.equal(typeof granted.id, 'string')
  assert.equal(granted.cursor, null)
  assert.equal(granted.truncated, false)
  const refreshed = await initial.subscribe(alice, params(decisionEvent, { gameId }, 60_000))
  assert.equal(refreshed.id, granted.id)
  assert.equal(verification.length, 1)
  assert.deepEqual(initial.list({ ...alice, scopes: [] }), { events: [] })
  assert.deepEqual(initial.list(alice).events.map(item => item.name), [inviteEvent, decisionEvent])
  await initial.enqueue(pool, event(bob, decisionEvent, { gameId, decisionId: 'other', cursor: 1, kind: 'priority' }))
  await initial.enqueue(pool, event(alice, decisionEvent, { gameId: randomUUID(), decisionId: 'filter', cursor: 2, kind: 'priority' }))
  const pending = event(alice, decisionEvent, { gameId, decisionId: 'actual', cursor: 3, kind: 'priority' })
  await Promise.all([initial.enqueue(pool, pending), initial.enqueue(pool, pending)])
  const restarted = createMcpEvents(pool, { deliver })
  await restarted.drain()
  assert.equal(received.length, 1)
  assert.deepEqual(received[0].data.data, pending.data)
  assert.equal(received[0].headers['x-mcp-subscription-id'], granted.id)
  await pool.query("UPDATE mcp_event_deliveries SET available_at=now() - interval '1 second'")
  await restarted.drain()
  await restarted.drain()
  assert.equal(received.length, 2)
  assert.equal(received[1].data.eventId, received[0].data.eventId)
})

test('verification failure, cross-owner unsubscribe, expiration, invalidation and revocation are enforced', { skip: !databaseUrl }, async t => {
  const { createMcpEvents } = await import('./mcp-events.mjs')
  const { pool, alice, bob } = await fixture(t)
  const received = []
  const deliver = async (url, { body }) => {
    const data = JSON.parse(body)
    if (data.type === 'verification') return {
      status: 200, body: JSON.stringify({ challenge: url.endsWith('=1') ? data.challenge : 'unrelated' }),
    }
    received.push(data)
    return { status: 204, body: '' }
  }
  const service = createMcpEvents(pool, { deliver })
  await assert.rejects(service.subscribe(alice, { ...params(inviteEvent), delivery: { mode: 'webhook', secret, url: callback + '2' } }),
    error => error.rpcCode === -32015 && error.reason === 'challenge_failed')
  await assert.rejects(service.subscribe(alice, params(inviteEvent, { gameId: randomUUID() })), error => error.status === 400)
  await assert.rejects(service.subscribe({ ...alice, agent: false }, params(inviteEvent)), error => error.status === 403)
  await service.subscribe(alice, params(inviteEvent))
  await service.unsubscribe(bob, params(inviteEvent))
  function invite() { return event(alice, inviteEvent, { tableId: randomUUID(), format: 'Pioneer' }) }
  await service.enqueue(pool, invite())
  await service.drain()
  assert.equal(received.length, 1)
  const stale = invite()
  await service.enqueue(pool, stale)
  await service.invalidate(pool, stale)
  await service.enqueue(pool, { ...invite(), expiresAt: new Date(Date.now() - 300) })
  await service.drain()
  assert.equal(received.length, 1)
  await service.enqueue(pool, invite())
  await service.unsubscribe(alice, params(inviteEvent))
  await service.drain()
  assert.equal(received.length, 1)
  await service.subscribe(alice, params(inviteEvent))
  await service.enqueue(pool, invite())
  await pool.query('UPDATE agent_grants SET revoked_at=now() WHERE account_id=$1', [alice.accountId])
  await service.drain()
  assert.equal(received.length, 1)
})

test('OAuth revocation removes only its subscriptions and signing-key rotation keeps a short overlap', { skip: !databaseUrl }, async t => {
  const { createMcpEvents } = await import('./mcp-events.mjs')
  const { pool, alice } = await fixture(t)
  const connectionId = randomUUID()
  const connected = { ...alice, connectionId }
  await pool.query(`
    INSERT INTO oauth_connections(id,account_id,engine_key,audience,client_id,scopes_approved,refresh_digest,expires_at)
    VALUES($1,$2,$3,$4,'fixture-client',ARRAY['play'],$5,now()+interval '1 day')
  `, [connectionId, alice.accountId, alice.engineName.toLowerCase(), 'https://playmat.example.net/mcp', 'fixture-refresh'])
  const received = []
  const service = createMcpEvents(pool, {
    async deliver(_url, { body, headers }) {
      const payload = JSON.parse(body)
      if (payload.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) }
      received.push({ body, headers })
      return { status: 204, body: '' }
    },
  })
  const manual = await service.subscribe(alice, params(inviteEvent))
  const oauth = await service.subscribe(connected, params(inviteEvent))
  assert.notEqual(manual.id, oauth.id)
  const replacement = Buffer.alloc(32, 8)
  const refresh = await service.subscribe(connected, {
    ...params(inviteEvent),
    delivery: { mode: 'webhook', url: callback, secret: 'whsec_' + replacement.toString('base64') },
  })
  assert.equal(refresh.id, oauth.id)
  await service.enqueue(pool, event(alice, inviteEvent, { tableId: randomUUID(), format: 'Pioneer' }))
  await service.drain()
  const signed = received.find(entry => entry.headers['x-mcp-subscription-id'] === oauth.id)
  const verify = key => 'v1,' + createHmac('sha256', key)
    .update(signed.headers['webhook-id'] + '.' + signed.headers['webhook-timestamp'] + '.').update(signed.body).digest('base64')
  assert.equal(signed.headers['webhook-signature'], [verify(replacement), verify(signingKey)].join(' '))
  received.length = 0
  await service.enqueue(pool, event(alice, inviteEvent, { tableId: randomUUID(), format: 'Standard' }))
  await pool.query('UPDATE oauth_connections SET revoked_at=now() WHERE id=$1', [connectionId])
  await service.drain()
  assert.deepEqual(received.map(entry => entry.headers['x-mcp-subscription-id']), [manual.id])
  await assert.rejects(service.subscribe(connected, params(inviteEvent)), error => error.status === 403)
})
