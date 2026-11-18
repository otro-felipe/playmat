import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'

const databaseUrl = process.env.PLAYMAT_TEST_DATABASE_URL
const password = 'synthetic-fixture-credential'

test('MCP decks have a reusable opponent shelf; only the owner moves legacy decks without losing revisions', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const owner = await signIn(f, 'LibraryOwner')
  const other = await signIn(f, 'OtherOwner')
  const agent = { Authorization: 'Bearer ' + await f.product.provisionAgent('LibraryOwner', 'LibraryMcp', ['library']) }
  const noLibrary = { Authorization: 'Bearer ' + await f.product.provisionAgent('LibraryOwner', 'PlayOnly', ['play']) }
  const root = '/api/playtesting/decks'
  assert.deepEqual((await (await f.path(root, { headers: owner })).json()).decks, [])
  const ownId = 'library', agentId = randomUUID()
  const data = { name: 'Reusable deck', format: 'Pioneer', library: 'agent', cards: [{ cardName: 'Forest', amount: 60 }], sideboard: [] }
  const put = (id, headers, expectedRevision = 0) => f.path(`${root}/${id}`, json('PUT', headers, { expectedRevision, data }))
  const personal = await (await put(ownId, owner)).json()
  const rival = await (await put(agentId, agent)).json()
  assert.equal(personal.library, 'personal', 'a browser cannot spoof the MCP shelf through metadata')
  assert.equal(rival.library, 'agent')
  assert.equal((await (await put(ownId, agent, 1)).json()).library, 'personal', 'editing does not reclassify existing decks')
  const listed = await (await f.path(root + '?library=agent', { headers: agent })).json()
  assert.deepEqual(listed.decks.map(deck => deck.id), [agentId])
  assert.equal((await f.path(root + '?library=invalid', { headers: owner })).status, 400)
  assert.equal((await f.path(root, { headers: noLibrary })).status, 403)
  assert.equal((await f.path(`${root}/${agentId}`, { headers: other })).status, 404)
  const move = (headers, revision, library = 'agent') => f.path(`${root}/${ownId}/library`, json('POST', headers, { expectedRevision: revision, library }))
  assert.equal((await move(agent, 2)).status, 403)
  assert.equal((await move(other, 2)).status, 409)
  assert.equal((await move(owner, 1)).status, 409)
  assert.equal((await move(owner, 2, 'unknown')).status, 400)
  const moved = await (await move(owner, 2)).json()
  assert.equal(moved.id, ownId)
  assert.equal(moved.revision, 2)
  assert.equal(moved.library, 'agent')
  assert.deepEqual(moved.data.cards, personal.data.cards)
  const firstRevision = await (await f.path(`${root}/${ownId}?revision=1`, { headers: owner })).json()
  assert.equal(firstRevision.revision, 1)
  assert.deepEqual(firstRevision.data.cards, personal.data.cards)
  assert.equal((await (await move(owner, 2, 'personal')).json()).library, 'personal')
})

async function fixture(t, store = new Map(), options = {}) {
  const { createProduct } = await import('./product.mjs')
  const replayDirectory = await mkdtemp(join(tmpdir(), 'playmat-replays-'))
  const schema = `test_${randomUUID().replaceAll('-', '')}`
  const product = await createProduct({ databaseUrl, schema, replayDirectory, store, insecureCookie: true, enableInternal: true, ...options })
  const server = product.server
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.close()
    await product.dropTestSchema()
    await product.close()
    await rm(replayDirectory, { recursive: true, force: true })
  })
  const endpoint = `http://127.0.0.1:${server.address().port}`
  return { product, replayDirectory, schema, endpoint, path: (route, init) => fetch(endpoint + route, init) }
}

async function signIn(f, name) {
  await f.product.provisionHuman(name, password)
  const response = await f.path('/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: name, password }),
  })
  assert.equal(response.status, 303)
  return { Cookie: response.headers.get('set-cookie').split(';')[0] }
}

function json(method, headers, body) {
  return { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

async function withTestDatabase(f, run) {
  const { default: pg } = await import('pg')
  const db = new pg.Client({ connectionString: databaseUrl, options: '-c search_path=' + f.schema })
  await db.connect()
  try {
    return await run(db)
  } finally {
    await db.end()
  }
}

test('recovery binds immutable account and grant IDs and rechecks grant revocation without trusting names', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'RecoveryOwner')
  const other = await signIn(f, 'RecoveryOther')
  const token = await f.product.provisionAgent('RecoveryOwner', 'RecoveryAgent', ['play'])
  const human = await f.path('/internal/verify?scope=play', { headers: alice })
  const accountId = human.headers.get('X-Playmat-Account')
  const seatId = human.headers.get('X-Playmat-Seat')
  assert.equal(seatId, 'human:' + accountId)
  const agent = await f.path('/internal/verify?scope=play', { headers: { Authorization: 'Bearer ' + token } })
  const grant = { accountId, seatId: agent.headers.get('X-Playmat-Seat') }
  assert.match(grant.seatId, /^agent:[a-f0-9-]{36}$/)
  const validate = principal => f.path('/internal/recovery/validate', json('POST', {}, principal))
  assert.equal((await validate(grant)).status, 200)
  const otherId = (await f.path('/internal/verify', { headers: other })).headers.get('X-Playmat-Account')
  assert.equal((await validate({ ...grant, accountId: otherId })).status, 403)
  assert.equal((await validate({ accountId, seatId: 'agent:' + randomUUID(), engineName: 'RecoveryAgent' })).status, 403)
  await f.product.revokeAgent(token)
  assert.equal((await validate(grant)).status, 403)
  await withTestDatabase(f, db => db.query('UPDATE accounts SET enabled=false WHERE id=$1', [accountId]))
  assert.equal((await validate({ accountId, seatId })).status, 403)
})

test('recovery revalidates the current OAuth connection independently of its durable grant identity', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const cookie = await signIn(f, 'RecoveryOAuth')
  await f.product.provisionAgent('RecoveryOAuth', 'RecoveryOA', ['play'])
  const accountId = (await f.path('/internal/verify', { headers: cookie })).headers.get('X-Playmat-Account')
  const connectionId = randomUUID()
  const seatId = await withTestDatabase(f, async db => {
    const { rows: [grant] } = await db.query("UPDATE agent_grants SET oauth_managed=true WHERE engine_key='recoveryoa' RETURNING recovery_id")
    await db.query("INSERT INTO oauth_connections(id,account_id,engine_key,client_id,audience,scopes_approved,refresh_digest,expires_at) VALUES($1,$2,'recoveryoa','fixture-client','fixture-resource',ARRAY['play'],$3,now()+interval '1 hour')", [connectionId, accountId, randomUUID()])
    return 'agent:' + grant.recovery_id
  })
  const validate = principal => f.path('/internal/recovery/validate', json('POST', {}, principal))
  assert.equal((await validate({ accountId, seatId })).status, 403)
  assert.equal((await validate({ accountId, seatId, connectionId })).status, 200)
  await withTestDatabase(f, db => db.query('UPDATE oauth_connections SET revoked_at=now() WHERE id=$1', [connectionId]))
  assert.equal((await validate({ accountId, seatId, connectionId })).status, 403)
})

test('[PM-AC-04] password sign-in and scoped forward auth reject forged or revoked identities', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  assert.equal((await f.path('/internal/verify', { headers: { 'X-Playmat-User': 'Alice' } })).status, 401)
  assert.equal((await f.path('/register', json('POST', {}, { username: 'guest', password }))).status, 404)
  const alice = await signIn(f, 'Alice')
  const verified = await f.path('/internal/verify', { headers: { ...alice, 'X-Playmat-User': 'Mallory' } })
  assert.equal(verified.headers.get('X-Playmat-User'), 'Alice')
  const grant = await f.product.provisionAgent('Alice', 'AgentAlice', ['play','library','history'])
  const agent = { Authorization: `Bearer ${grant}` }
  const identity = await (await f.path('/internal/verify', { headers: agent })).json()
  assert.equal(identity.engineName, 'AgentAlice')
  assert.notEqual(identity.engineName, 'Alice')
  await f.product.revokeAgent(grant)
  assert.equal((await f.path('/internal/verify', { headers: agent })).status, 401)
  assert.equal((await f.path('/logout', { method: 'POST', headers: alice, redirect: 'manual' })).status, 303)
  assert.equal((await f.path('/internal/verify', { headers: alice })).status, 401)
})

test('[PM-AC-04] the claimed guest and actual table host control admission', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  const bob = await signIn(f, 'Bob')
  const carol = await signIn(f, 'Carol')
  const tableId = randomUUID()
  const roomId = randomUUID()
  const route = '/api/playtesting/invites'
  const invite = await f.path(route, json('POST', alice, {
    tableId, roomId, guestEngineName: 'Bob', format: 'Pioneer', password,
  }))
  assert.equal(invite.status, 201)
  const friendInvitation = await invite.json()
  assert.equal(Object.hasOwn(friendInvitation, 'password'), false)
  assert.equal(Object.hasOwn(friendInvitation, 'chatMode'), false)
  assert.equal((await f.path(route, json('POST', alice, {
    tableId: randomUUID(), roomId, guestEngineName: 'Bob', format: 'Pioneer', password, chatMode: 'coach',
  }))).status, 400)
  assert.deepEqual((await (await f.path(route, { headers: alice })).json()).invites, [])
  assert.deepEqual((await (await f.path(route, { headers: carol })).json()).invites, [])
  assert.deepEqual((await (await f.path(route + '?limit=1', { headers: bob })).json()).invites.map(row => row.tableId), [tableId])
  const claim = route + '/' + tableId + '/claim'
  const gate = '/internal/invites/' + tableId + '?host=Alice&guest=Bob'
  assert.equal((await f.path(gate)).status, 404)
  assert.equal((await f.path(claim, { method: 'POST', headers: carol })).status, 404)
  const accepted = await Promise.all([1, 2].map(() => f.path(claim, { method: 'POST', headers: bob })))
  assert.deepEqual(accepted.map(response => response.status), [200, 200])
  assert.deepEqual(await accepted[0].json(), await accepted[1].json())
  assert.equal((await f.path(gate)).status, 200)
  assert.equal((await f.path(gate.replace('=Alice', '=Carol'))).status, 404)
})

test('[PM-AC-04] an existing legacy MCP link admits exactly one delegated identity with a display-only alias', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const host = await signIn(f, 'Host')
  const guest = await signIn(f, 'Guest')
  const engineNames = ['HostAgent', 'GuestAgent']
  const tokens = await Promise.all([
    f.product.provisionAgent('Host', engineNames[0], ['play']),
    f.product.provisionAgent('Guest', engineNames[1], ['play']),
  ])
  const grants = tokens.map(token => ({ Authorization: `Bearer ${token}` }))
  const restricted = { Authorization: `Bearer ${await f.product.provisionAgent('Guest', 'LibraryAgent', ['library'])}` }
  const tableId = randomUUID()
  const invitations = '/api/playtesting/invites'
  const invitation = `${invitations}/${tableId}`
  const createLegacy = async options => {
    const response = await f.path(invitations, json('POST', host, options))
    assert.equal(response.status, 201)
    await withTestDatabase(f, db => db.query('UPDATE invitations SET owner_account_id=NULL WHERE table_id=$1', [options.tableId]))
    return response
  }
  const created = await createLegacy({
    tableId, roomId: randomUUID(), format: 'Pioneer', password, mode: 'mcp', chatMode: 'coach',
  })
  assert.equal(created.status, 201)
  const createdInfo = await created.json()
  assert.equal(createdInfo.mode, 'mcp')
  assert.equal(createdInfo.chatMode, 'coach')
  assert.equal(createdInfo.guestEngineName, null)
  assert.equal(Object.hasOwn(createdInfo, 'password'), false)
  assert.deepEqual((await (await f.path(invitations, { headers: grants[0] })).json()).invites, [])
  assert.equal((await f.path(invitation, { headers: guest })).status, 404)
  assert.equal((await f.path(invitation + '/claim', json('POST', guest, {}))).status, 404)
  assert.equal((await f.path(invitation + '/claim', json('POST', restricted, {}))).status, 403)
  assert.equal((await f.path(invitation, { headers: grants[0] })).status, 200)
  assert.equal((await f.path(`${invitations}/${randomUUID()}`, { headers: grants[0] })).status, 404)

  const claim = headers => f.path(invitation + '/claim', json('POST', headers, { displayName: 'The Angel' }))
  assert.equal((await f.path(invitation + '/claim', json('POST', grants[0], { displayName: '<script>' }))).status, 400)
  const responses = await Promise.all(grants.map(claim))
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 404])
  const winner = responses.findIndex(response => response.status === 200)
  const claimed = await responses[winner].json()
  assert.equal(claimed.guestEngineName, engineNames[winner])
  assert.equal(claimed.guestDisplayName, 'The Angel')
  assert.equal(claimed.chatMode, 'coach')
  const repeated = await f.path(invitation + '/claim', json('POST', grants[winner], { displayName: 'Different alias', chatMode: 'chatty' }))
  assert.equal(repeated.status, 200)
  const repeatedInfo = await repeated.json()
  assert.equal(repeatedInfo.guestDisplayName, 'The Angel')
  assert.equal(repeatedInfo.chatMode, 'coach')
  assert.equal((await claim(grants[1 - winner])).status, 404)
  const shownToHost = await (await f.path(invitation, { headers: host })).json()
  assert.equal(shownToHost.guestDisplayName, 'The Angel')
  assert.equal(shownToHost.chatMode, 'coach')
  assert.equal(Object.hasOwn(shownToHost, 'password'), false)
  const gate = `/internal/invites/${tableId}?host=Host&guest=`
  assert.equal((await f.path(gate + engineNames[winner])).status, 200)
  assert.equal((await f.path(gate + encodeURIComponent('The Angel'))).status, 404)
  assert.equal((await f.path(gate + engineNames[1 - winner])).status, 404)
  assert.equal((await f.path('/api/playtesting/decks', { headers: grants[winner] })).status, 403)

  const ownSeat = randomUUID()
  await createLegacy({
    tableId: ownSeat, roomId: randomUUID(), format: 'Pioneer', password, mode: 'mcp',
  })
  const selfDelegation = await f.path(`${invitations}/${ownSeat}/claim`, json('POST', grants[0], {}))
  assert.equal(selfDelegation.status, 200)
  const ownSeatInfo = await selfDelegation.json()
  assert.equal(ownSeatInfo.guestEngineName, engineNames[0])
  assert.equal(ownSeatInfo.chatMode, 'quiet')
  assert.equal((await f.path(`/internal/invites/${ownSeat}?host=Host&guest=HostAgent`)).status, 200)

  for (const [chatMode, status] of [['chatty', 201], ['quiet', 201], ['invalid', 400], [null, 400]]) {
    const response = await f.path(invitations, json('POST', host, {
      tableId: randomUUID(), roomId: randomUUID(), format: 'Pioneer', password, mode: 'mcp', chatMode,
    }))
    assert.equal(response.status, status)
    if (status === 201) assert.equal((await response.json()).chatMode, chatMode)
  }

  const { default: pg } = await import('pg')
  const db = new pg.Client({ connectionString: databaseUrl, options: `-c search_path=${f.schema}` })
  await db.connect()
  try {
    await db.query("UPDATE invitations SET expires_at=now()-interval '1 minute' WHERE table_id=$1", [tableId])
  } finally {
    await db.end()
  }
  assert.equal((await claim(grants[winner])).status, 404)
  assert.equal((await f.path(gate + engineNames[winner])).status, 404)
  await f.product.revokeAgent(tokens[0])
  assert.equal((await f.path(`/internal/invites/${ownSeat}?host=Host&guest=HostAgent`)).status, 404)
})

test('[PM-AC-16] an MCP table belongs to the signed-in account and notifies only its own connected agent', { skip: !databaseUrl }, async t => {
  const issuer = 'https://playmat-invitations.example'
  const f = await fixture(t, new Map(), {
    publicUrl: issuer,
    eventOptions: { deliver: async (_url, { body }) => {
      const { challenge } = JSON.parse(body)
      assert.ok(challenge)
      return { status: 200, body: JSON.stringify({ challenge }) }
    } },
  })
  const alice = await signIn(f, 'Alice')
  const bob = await signIn(f, 'Bob')
  const legacy = { Authorization: 'Bearer ' + await f.product.provisionAgent('Alice', 'LegacyAgent', ['play']) }
  const route = '/api/playtesting/invites'
  const tableId = randomUUID()
  const invite = { tableId, roomId: randomUUID(), format: 'Pioneer', password, mode: 'mcp' }
  const link = route + '/' + tableId

  const created = await f.path(route, json('POST', alice, invite))
  assert.equal(created.status, 201, 'the game can be created before connecting a client')
  assert.equal((await created.json()).guestEngineName, null)
  assert.equal((await f.path(link, { headers: legacy })).status, 404)

  const { digest, newToken } = await import('./identity.mjs')
  const oauth = (username, engineName) => withTestDatabase(f, async db => {
    const { rows: [{ id: accountId }] } = await db.query('SELECT id FROM accounts WHERE username=$1', [username])
    const connection = randomUUID()
    const access = newToken()
    await db.query(`INSERT INTO agent_grants(digest,account_id,engine_name,engine_key,scopes,oauth_managed)
      VALUES($1,$2,$3,$4,ARRAY['play','chat','library'],true)`, [digest(newToken()), accountId, engineName, engineName])
    await db.query(`INSERT INTO oauth_connections(id,account_id,engine_key,client_id,audience,scopes_approved,refresh_digest,expires_at)
      VALUES($1,$2,$3,'https://chatgpt.com/oauth/client.json',$4,ARRAY['play','chat','library'],$5,now()+interval '1 day')`,
    [connection, accountId, engineName, issuer + '/mcp', digest(newToken())])
    await db.query(`INSERT INTO oauth_access_tokens(digest,connection_id,expires_at)
      VALUES($1,$2,now()+interval '1 hour')`, [digest(access), connection])
    return { Authorization: 'Bearer ' + access }
  })
  const engineName = 'mcp_00000000000000000001'
  const owner = await oauth('Alice', engineName)
  const other = await oauth('Bob', 'mcp_00000000000000000002')

  const params = {
    name: 'game.invitation.created',
    delivery: { mode: 'webhook', url: 'https://receiver.example.net/mcp-events', secret: 'whsec_' + Buffer.alloc(32, 19).toString('base64') },
  }
  for (const headers of [owner, other, legacy]) {
    assert.equal((await f.path('/internal/mcp-events/subscribe', json('POST', headers, params))).status, 200)
  }
  assert.deepEqual((await (await f.path(route, { headers: owner })).json()).invites.map(row => row.tableId), [tableId])
  for (const headers of [bob, legacy, other]) {
    assert.deepEqual((await (await f.path(route, { headers })).json()).invites, [])
    assert.equal((await f.path(link, { headers })).status, 404)
    assert.equal((await f.path(link + '/claim', json('POST', headers, {}))).status, 404)
  }
  assert.equal((await f.path(link + '/claim', json('POST', alice, {}))).status, 404)
  assert.equal((await f.path(link, { headers: alice })).status, 200)
  assert.equal((await f.path(link, { headers: owner })).status, 200)

  const gate = '/internal/invites/' + tableId + '?host=Alice&guest=' + engineName
  assert.equal((await f.path(gate)).status, 404)
  const accepted = await f.path(link + '/claim', json('POST', owner, { displayName: 'Desk rival' }))
  assert.equal(accepted.status, 200)
  const acceptedInfo = await accepted.json()
  assert.equal(acceptedInfo.guestDisplayName, 'Desk rival')
  assert.equal(acceptedInfo.guestEngineName, engineName)
  assert.equal((await f.path(gate)).status, 200)

  const notifiedId = randomUUID()
  const notified = await f.path(route, json('POST', alice, { ...invite, tableId: notifiedId }))
  assert.equal(notified.status, 201)
  assert.equal((await notified.json()).guestEngineName, null, 'notification alone leaves the rival seat empty')
  assert.equal((await f.path(route, json('POST', alice, { ...invite, tableId: notifiedId }))).status, 409)
  const queue = await withTestDatabase(f, async db => (await db.query(`SELECT e.event_name, e.engine_key, e.table_id, e.format
    FROM mcp_events e JOIN mcp_event_deliveries d ON d.event_id=e.id`)).rows)
  assert.deepEqual(queue, [{
    event_name: 'game.invitation.created', engine_key: engineName, table_id: notifiedId, format: 'Pioneer',
  }])

  const fallback = await f.path(route + '/' + notifiedId + '/claim', json('POST', owner, {}))
  assert.equal(fallback.status, 200)
  assert.equal((await fallback.json()).guestDisplayName, 'Rival MCP')
})

test('[PM-AC-04] a prehashed provisioning import is idempotent and cannot rotate an existing identity', { skip: !databaseUrl }, async t => {
  const { newToken, prepareProvisionBundle } = await import('./identity.mjs')
  const f = await fixture(t)
  const grant = newToken()
  const replacement = newToken()
  const first = await prepareProvisionBundle({
    accounts: [{ username: 'Alice', password }],
    agents: [{ owner: 'Alice', engineName: 'AgentAlice', token: grant, scopes: ['play'] }],
  })
  assert.doesNotMatch(JSON.stringify(first), new RegExp(password + '|' + grant))
  await f.product.importProvisionBundle(first)
  await f.product.importProvisionBundle(first)
  await f.product.importProvisionBundle(await prepareProvisionBundle({
    accounts: [{ username: 'alice', password: 'different-synthetic-password' }],
    agents: [{ owner: 'Alice', engineName: 'agentalice', token: replacement, scopes: ['play', 'history'] }],
  }))
  const response = await f.path('/login', {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ username: 'Alice', password }),
  })
  assert.equal(response.status, 303)
  const initial = await f.path('/internal/verify', { headers: { Authorization: 'Bearer ' + grant } })
  assert.deepEqual((await initial.json()).scopes, ['play'])
  assert.equal((await f.path('/internal/verify', { headers: { Authorization: 'Bearer ' + replacement } })).status, 401)
})

test('[PM-AC-04] provisioning revokes only the targeted grant and preserves independently scoped replacements', { skip: !databaseUrl }, async t => {
  const { digest, newToken, prepareProvisionBundle } = await import('./identity.mjs')
  const f = await fixture(t)
  await f.product.provisionHuman('Alice', password)
  const original = await f.product.provisionAgent('Alice', 'AgentAlice', ['play', 'library', 'history', 'chat'])
  const rival = newToken()
  const analyst = newToken()
  const verify = token => f.path('/internal/verify', { headers: { Authorization: 'Bearer ' + token } })
  const provision = await prepareProvisionBundle({
    agents: [
      { owner: 'Alice', engineName: 'AliceRival', token: rival, scopes: ['play', 'chat'] },
      { owner: 'Alice', engineName: 'AliceLab', token: analyst, scopes: ['library', 'history'] },
    ],
    revocations: [{ token: original }],
  })
  assert.equal((await verify(original)).status, 200)
  await f.product.importProvisionBundle(provision)
  assert.equal((await verify(original)).status, 401)
  assert.deepEqual(provision.revocations, [{ tokenDigest: digest(original) }])
  assert.doesNotMatch(JSON.stringify(provision), new RegExp(original))
  await f.product.importProvisionBundle(provision)
  await f.product.importProvisionBundle({ revocations: [{ tokenDigest: digest(newToken()) }] })
  await f.product.importProvisionBundle(await prepareProvisionBundle({
    agents: [{ owner: 'Alice', engineName: 'agentalice', token: original, scopes: ['play'] }],
  }))
  assert.equal((await verify(original)).status, 401)
  assert.deepEqual((await (await verify(rival)).json()).scopes, ['play', 'chat'])
  assert.deepEqual((await (await verify(analyst)).json()).scopes, ['library', 'history'])
  await assert.rejects(prepareProvisionBundle({ revocations: [{ token: 'invalid' }] }), { status: 400 })
  await assert.rejects(f.product.importProvisionBundle({
    revocations: [{ tokenDigest: digest(rival) }, { tokenDigest: 'invalid' }],
  }), { status: 400 })
  assert.equal((await verify(rival)).status, 200)
})

test('[PM-AC-05] browser and delegated agent share immutable owned revisions and reject stale writes', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  const bob = await signIn(f, 'Bob')
  const token = await f.product.provisionAgent('Alice', 'AgentAlice', ['library'])
  const agent = { Authorization: `Bearer ${token}` }
  const deckId = randomUUID()
  const route = `/api/playtesting/decks/${deckId}`
  const deck = { name: 'Mono Red', format: 'Pioneer', cards: [{ name: 'Mountain', set: 'DMU', number: '280', quantity: 60 }], sideboard: [] }
  assert.equal((await f.path(route, json('PUT', alice, { expectedRevision: 0, data: deck }))).status, 200)
  assert.equal((await f.path(route, { headers: bob })).status, 404)
  assert.equal((await (await f.path(route, { headers: agent })).json()).revision, 1)
  const results = await Promise.all([alice, agent].map((headers, i) => f.path(route, json('PUT', headers, {
    expectedRevision: 1, data: { ...deck, name: `Version ${i}` },
  }))))
  assert.deepEqual(results.map(x => x.status).sort(), [200, 409])
  const saved = await (await f.path(route, { headers: alice })).json()
  assert.equal(saved.revision, 2)
  assert.equal((await f.path(route + '?revision=1', { headers: agent })).status, 200)
  assert.equal((await (await f.path(route + '?revision=1', { headers: agent })).json()).data.name, 'Mono Red')
})

test('[PM-AC-05] the account library saves browser drafts and preserves their chosen engine formats', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = { ...await signIn(f, 'Alice'), 'X-Playmat-Deck-Owner': 'Alice' }
  const bob = { ...await signIn(f, 'Bob'), 'X-Playmat-Deck-Owner': 'Bob' }
  const library = '/api/playtesting/decks'
  const deck = { name: 'New deck', cards: [], sideboard: [] }
  const formats = [
    [undefined, 'Constructed - Freeform'],
    [' ', 'Constructed - Freeform'],
    ['Freeform', 'Constructed - Freeform'],
    ['Constructed - Freeform', 'Constructed - Freeform'],
    ['Variant Magic - Commander', 'Variant Magic - Commander'],
    ['Block Constructed Custom - Star Wars', 'Block Constructed Custom - Star Wars'],
    ['Constructed Custom - Custom fixture', 'Constructed Custom - Custom fixture'],
    ['Constructed - Pioneer', 'Pioneer'],
  ]
  for (const [format, storedFormat] of formats) {
    const route = `${library}/${randomUUID()}`
    const saved = await f.path(route, json('PUT', alice, { expectedRevision: 0, data: { ...deck, format } }))
    assert.equal(saved.status, 200, `The library accepts ${format ?? 'a missing format'}`)
    const { revision, data } = await saved.json()
    assert.equal(revision, 1)
    assert.deepEqual([data.format, data.cards, data.sideboard], [storedFormat, [], []])
    assert.equal((await f.path(route, { headers: bob })).status, 404)

    const edited = { expectedRevision: revision, data: { ...data, name: 'Edited draft' } }
    assert.equal((await f.path(route, json('PUT', alice, edited))).status, 200)
    assert.equal((await f.path(route, json('PUT', alice, edited))).status, 409)
    const history = await (await f.path(route + '?revision=1', { headers: alice })).json()
    assert.deepEqual([history.revision, history.data.format, history.data.name], [1, storedFormat, 'New deck'])
  }
  for (const format of ['Constructed - ' + 'x'.repeat(120), 'Constructed - Bad\nFormat', 'constructor', 42]) {
    assert.equal((await f.path(`${library}/${randomUUID()}`, json('PUT', alice, {
      expectedRevision: 0, data: { ...deck, format },
    }))).status, 400)
  }
  const rejectedInvite = await f.path('/api/playtesting/invites', json('POST', alice, {
    tableId: randomUUID(), roomId: randomUUID(), format: 'Constructed - Freeform', mode: 'mcp', password,
  }))
  assert.equal(rejectedInvite.status, 400)
})

test('[PM-AC-05] startup upgrades existing deck storage without changing its saved decks', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const owner = await signIn(f, 'Alice')
  const route = `/api/playtesting/decks/${randomUUID()}`
  const deck = { name: 'Existing list', format: 'Pioneer', cards: [], sideboard: [] }
  assert.equal((await f.path(route, json('PUT', owner, { expectedRevision: 0, data: deck }))).status, 200)
  await withTestDatabase(f, db => db.query(`ALTER TABLE deck_revisions
    DROP CONSTRAINT IF EXISTS deck_revisions_library_format_check,
    DROP CONSTRAINT IF EXISTS deck_revisions_format_check,
    ADD CONSTRAINT deck_revisions_format_check CHECK (format IN ('Standard', 'Pioneer', 'Modern'))`))
  await withTestDatabase(f, db => db.query('ALTER TABLE decks DROP COLUMN library'))

  const { createProduct } = await import('./product.mjs')
  const reopened = await createProduct({ databaseUrl, schema: f.schema, replayDirectory: f.replayDirectory, store: new Map() })
  await reopened.close()

  const saved = await f.path(route, json('PUT', owner, { expectedRevision: 1, data: { ...deck, format: 'Constructed - Freeform' } }))
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).revision, 2)
  const previous = await (await f.path(route + '?revision=1', { headers: owner })).json()
  assert.deepEqual([previous.revision, previous.data.name, previous.data.format], [1, 'Existing list', 'Pioneer'])
  assert.equal(previous.data.library, 'personal')
})

async function addReplay(f, matchId, gameId, names, events) {
  const now = Date.now()
  const info = {
    gameId, matchId, tableId: matchId, startedAt: now - 1000, endedAt: now,
    result: 'Game finished', winner: names[0], turns: 4, events: 2, deckType: 'Constructed - Pioneer',
    players: names.map(name => ({ name, human: true, deck: { cards: [`private:${name}`] } })),
  }
  await writeFile(join(f.replayDirectory, gameId + '.json'), JSON.stringify(info))
  const data = events ?? [
    { t: 100, view: { turn: 1, players: names.map(name => ({ name })) }, hands: Object.fromEntries(names.map(name => [name, [`secret:${name}`]])) },
    { t: 105, log: { messageType: 'TALK', message: 'private chat' } },
  ]
  await writeFile(join(f.replayDirectory, gameId + '.ndjson.gz'), gzipSync(data.map(row => JSON.stringify(row)).join('\n')))
}

test('[PM-AC-15] the judge receives pre-action evidence from its own final timeline and scores only supported choices', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  const bob = await signIn(f, 'Bob')
  const outsider = await signIn(f, 'Carol')
  const matchId = randomUUID()
  const gameId = randomUUID()
  const forest = { name: 'Forest', cardTypes: ['LAND'] }
  const swamp = { name: 'Swamp', cardTypes: ['LAND'] }
  const frame = ({ turn, battlefield = {}, hand = {}, time }) => ({
    t: time,
    view: { turn, step: 'PRECOMBAT_MAIN', phase: 'PRECOMBAT_MAIN', priorityPlayerName: 'Alice', activePlayerName: 'Alice',
      players: [{ name: 'Alice', life: 20, battlefield }, { name: 'Bob', life: 20, topCard: { name: 'Private top card' } }] },
    hands: { Alice: hand, Bob: { unknown: { name: 'Hidden answer' } } },
  })
  await addReplay(f, matchId, gameId, ['Alice', 'Bob'], [
    frame({ turn: 2, time: 100, hand: { swamp, forest } }),
    frame({ turn: 2, time: 200, hand: { swamp }, battlefield: { forest } }),
    { t: 250, kind: 'rollback', turn: 2 },
    frame({ turn: 2, time: 300, hand: { swamp, forest } }),
    frame({ turn: 2, time: 400, hand: { forest }, battlefield: { swamp } }),
    frame({ turn: 3, time: 500, hand: { forest, future: { name: 'Future Draw' } }, battlefield: { swamp } }),
  ])
  await f.product.archiveGames()
  const path = '/api/playtesting/evaluations/' + gameId
  assert.equal((await f.path(path, { headers: outsider })).status, 404)
  const packet = await (await f.path(path, { headers: alice })).json()
  assert.equal(packet.perspective, 'Alice')
  assert.equal(packet.total, 1)
  assert.equal(packet.positions[0].action.card, 'Swamp')
  assert.equal(packet.positions[0].before.hand.length, 2)
  assert.doesNotMatch(JSON.stringify(packet), /Hidden answer|Private top card|Future Draw|winner/)
  const other = await (await f.path(path, { headers: bob })).json()
  assert.equal(other.total, 0)
  const entry = { index: packet.positions[0].index, played: 75, best: 100, confidence: 'high', alternative: 'Forest', reason: 'Keeps green available.' }
  const submit = (positions, headers = alice) => f.path(path, json('POST', headers, { positions }))
  assert.equal((await submit([entry], outsider)).status, 404)
  assert.equal((await submit([{ ...entry, index: 9999 }])).status, 400)
  assert.equal((await submit([entry, entry])).status, 400)
  const report = await (await submit([entry])).json()
  assert.equal(report.accuracy, 75)
  assert.equal(report.scored, 1)
  assert.equal(report.total, 1)
  const uncertain = await (await submit([{ ...entry, confidence: 'low' }])).json()
  assert.equal(uncertain.accuracy, null)
  assert.equal(uncertain.scored, 0)
})

test('[PM-AC-15] a public action can anchor a coalesced frame without inventing the state before later actions', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  const gameId = randomUUID()
  const forest = { name: 'Forest', cardTypes: ['LAND'] }
  const elf = { name: 'Llanowar Elves', cardTypes: ['CREATURE'] }
  const view = { turn: 1, step: 'PRECOMBAT_MAIN', activePlayerName: 'Alice',
    priorityPlayerName: 'Bob', players: [{ name: 'Alice' }, { name: 'Bob' }] }
  await addReplay(f, randomUUID(), gameId, ['Alice', 'Bob'], [
    { t: 100, view, hands: { Alice: { forest, elf } } },
    { t: 200, log: { messageType: 'GAME', message: '<font>Alice</font> plays <a>Forest</a> [bea]' } },
    { t: 300, log: { messageType: 'GAME', message: 'Alice casts Llanowar Elves [dec] from hand' } },
    { t: 400, view: { ...view, players: [{ name: 'Alice', battlefield: { forest } }, { name: 'Bob' }] }, hands: { Alice: {} } },
  ])
  await f.product.archiveGames()
  const path = '/api/playtesting/evaluations/' + gameId
  const packet = await (await f.path(path, { headers: alice })).json()
  assert.equal(packet.total, 1)
  assert.deepEqual(packet.positions[0].action, { kind: 'play_land', card: 'Forest' })
  assert.equal(packet.positions[0].evidence, 'engine_log')
  assert.equal(packet.positions[0].before.hand.length, 2)
  assert.equal(packet.positions[0].before.players[0].battlefield.total, 0)
})

test('[PM-AC-11] archive outage leaves the game visible and idempotent retry marks one verified artifact ready', { skip: !databaseUrl }, async t => {
  const objects = new Map()
  let shouldFail = true
  const f = await fixture(t, {
    async put(key, body) {
      if (shouldFail) throw Error('fixture archive unavailable')
      objects.set(key, body)
    },
    async get(key) { return objects.get(key) },
  })
  const alice = await signIn(f, 'Alice')
  await signIn(f, 'Bob')
  const match = randomUUID()
  const game = randomUUID()
  await addReplay(f, match, game, ['Alice', 'Bob'])
  await f.product.archiveGames()
  let history = await (await f.path('/api/playtesting/matches', { headers: alice })).json()
  assert.equal(history.matches[0].id, match)
  assert.equal(history.matches[0].games[0].archiveState, 'pending')
  shouldFail = false
  await f.product.archiveGames()
  await f.product.archiveGames()
  history = await (await f.path('/api/playtesting/matches', { headers: alice })).json()
  assert.equal(history.matches[0].games[0].archiveState, 'ready')
  assert.equal(objects.size, 1)
  const response = await f.path(`/api/playtesting/replays/${game}`, { headers: alice })
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.match(text, /secret:Alice/)
  assert.doesNotMatch(text, /secret:Bob|private:Bob|private chat|objectKey/)
})

test('[PM-AC-11] restart interrupts sideboarding even after the prior game archive was collected', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  await signIn(f, 'Bob')
  const matchId = randomUUID()
  const gameId = randomUUID()
  const path = '/api/playtesting/matches/' + matchId
  await addReplay(f, matchId, gameId, ['Alice', 'Bob'])
  await f.product.archiveGames()
  let match = await (await f.path(path, { headers: alice })).json()
  assert.equal(match.status, 'active')
  assert.equal(match.games[0].archiveState, 'ready')
  await f.product.archiveGames({ markInterrupted: true })
  match = await (await f.path(path, { headers: alice })).json()
  assert.equal(match.status, 'interrupted')
  assert.equal(match.games[0].status, 'completed')
  assert.equal(match.games[0].archiveState, 'ready')
})

test('[PM-AC-11] startup ingests a finalized match before archiving and keeps its terminal status after retries', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  await signIn(f, 'Bob')
  const finishedMatch = '00000000-0000-0000-0000-000000000001'
  const completedGame = 'ffffffff-ffff-ffff-ffff-fffffffffff1'
  const abandonedMatch = randomUUID()
  const abandonedGame = randomUUID()
  await writeFile(join(f.replayDirectory, finishedMatch + '.match.json'), JSON.stringify({
    matchId: finishedMatch, endedAt: Date.now(), winner: 'Alice',
  }))
  await addReplay(f, finishedMatch, completedGame, ['Alice', 'Bob'])
  await addReplay(f, abandonedMatch, abandonedGame, ['Alice', 'Bob'])
  const abandonedFile = join(f.replayDirectory, abandonedGame + '.json')
  const { readFile } = await import('node:fs/promises')
  const abandoned = JSON.parse(await readFile(abandonedFile, 'utf8'))
  abandoned.result = null
  abandoned.winner = null
  await writeFile(abandonedFile, JSON.stringify(abandoned))

  await f.product.archiveGames({ markInterrupted: true })
  async function matches() {
    const response = await f.path('/api/playtesting/matches', { headers: alice })
    assert.equal(response.status, 200)
    return (await response.json()).matches
  }
  let history = await matches()
  assert.equal(history.find(match => match.id === finishedMatch)?.status, 'completed')
  assert.equal(history.find(match => match.id === abandonedMatch)?.status, 'interrupted')
  await f.product.archiveGames()
  await f.product.archiveGames()
  history = await matches()
  const finished = history.find(match => match.id === finishedMatch)
  assert.equal(finished.status, 'completed')
  assert.equal(finished.games[0].archiveState, 'ready')
  const interrupted = history.find(match => match.id === abandonedMatch)
  assert.equal(interrupted.status, 'interrupted')
  assert.equal(interrupted.games[0].status, 'abandoned')
  assert.equal(interrupted.games[0].archiveState, 'partial')
})

test('[PM-AC-12] bounded batch export preserves only the requesting seat and rejects mixed ownership', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  const bob = await signIn(f, 'Bob')
  await signIn(f, 'Carol')
  const game1 = randomUUID()
  const game2 = randomUUID()
  const game3 = randomUUID()
  await addReplay(f, randomUUID(), game1, ['Alice', 'Bob'])
  await addReplay(f, randomUUID(), game2, ['Alice', 'Carol'])
  await addReplay(f, randomUUID(), game3, ['Bob', 'Carol'])
  await f.product.archiveGames()
  assert.equal((await f.path(`/api/playtesting/replays/${game2}`, { headers: bob })).status, 404)
  const exportRoute = '/api/playtesting/exports'
  assert.equal((await f.path(exportRoute, json('POST', alice, { gameIds: [game1, game3] }))).status, 404)
  const result = await f.path(exportRoute, json('POST', alice, { gameIds: [game1, game2] }))
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('content-type'), 'application/zip')
  const { unzipSync, strFromU8 } = await import('fflate')
  const archive = unzipSync(new Uint8Array(await result.arrayBuffer()))
  const content = Object.values(archive).map(strFromU8).join('\n')
  assert.match(content, /secret:Alice/)
  assert.doesNotMatch(content, /secret:Bob|secret:Carol|private:Bob|private:Carol|private chat|objectKey/)
  assert.ok(archive['manifest.json'])
  assert.ok(archive['summary.csv'])
  const response = await f.path(exportRoute, json('POST', alice, { gameIds: [game1, game2], mode: 'handle' }))
  assert.equal(response.status, 201)
  const { path } = await response.json()
  assert.equal((await f.path(path, { headers: alice })).status, 200)
  assert.equal((await f.path(path, { headers: bob })).status, 404)
})

test('[PM-AC-12] grouped stats use finalized games and the requesting player’s deck rather than a global view', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await signIn(f, 'Alice')
  const carol = await signIn(f, 'Carol')
  await signIn(f, 'Bob')
  const match = randomUUID()
  const first = randomUUID()
  const second = randomUUID()
  await addReplay(f, match, first, ['Alice', 'Bob'])
  await addReplay(f, match, second, ['Bob', 'Alice'])
  for (const [gameId, mulligans] of [[first, 0], [second, 2]]) {
    const file = join(f.replayDirectory, gameId + '.json')
    const { readFile } = await import('node:fs/promises')
    const info = JSON.parse(await readFile(file, 'utf8'))
    info.startPlayer = 'Alice'
    info.players.find(seat => seat.name === 'Alice').mulligans = mulligans
    await writeFile(file, JSON.stringify(info))
  }
  await f.product.archiveGames()
  let response = await f.path('/api/playtesting/stats?format=Pioneer', { headers: alice })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { groups: [] })
  await writeFile(join(f.replayDirectory, match + '.match.json'), JSON.stringify({ matchId: match, endedAt: Date.now(), winner: 'Alice' }))
  await f.product.archiveGames()
  response = await f.path('/api/playtesting/stats?format=Pioneer', { headers: alice })
  const { groups: [group] } = await response.json()
  assert.equal(group.games, 2)
  assert.equal(group.wins, 1)
  assert.equal(group.onPlay, 2)
  assert.equal(group.onDraw, 0)
  assert.equal(group.averageMulligans, 1)
  assert.equal(group.averageTurns, 4)
  assert.doesNotMatch(JSON.stringify(group), /private:Bob/)
  assert.deepEqual(await (await f.path('/api/playtesting/stats', { headers: carol })).json(), { groups: [] })
})

test('social discovery classifies real delegated identities without guessing from names or deleting progress', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  await signIn(f, 'SocialOwner')
  await signIn(f, 'mcp_abcdef1234') // a real human can have a technical-looking name
  const grant = await f.product.provisionAgent('SocialOwner', 'LegacyRival', ['play', 'chat'])
  const before = await f.path('/internal/verify?scope=play', { headers: { Authorization: 'Bearer ' + grant } })
  assert.equal(before.status, 200)
  await withTestDatabase(f, db => db.query(`INSERT INTO agent_grants(digest,account_id,engine_name,engine_key,scopes,oauth_managed)
    SELECT $1,id,'mcp_1234567890','mcp_1234567890',ARRAY['play','chat'],true FROM accounts WHERE username_key='socialowner'`, [randomUUID()]))
  const response = await f.path('/internal/social/agents')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), ['legacyrival', 'mcp_1234567890'])
  assert.equal((await f.path('/internal/verify?scope=play', { headers: { Authorization: 'Bearer ' + grant } })).status, 200)
  await withTestDatabase(f, async db => {
    const { rows: [row] } = await db.query("SELECT count(*)::int AS count FROM agent_grants WHERE engine_key='legacyrival'")
    assert.equal(row.count, 1)
    await db.query("UPDATE agent_grants SET revoked_at=now() WHERE engine_key='legacyrival'")
  })
  assert.deepEqual(await (await f.path('/internal/social/agents')).json(), ['legacyrival', 'mcp_1234567890'])
  const external = await fixture(t, new Map(), { enableInternal: false })
  assert.equal((await external.path('/internal/social/agents')).status, 404)
})
