import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { createProduct } from './product.mjs'
import { createClientRegistry } from './oauth-clients.mjs'

const databaseUrl = process.env.PLAYMAT_TEST_DATABASE_URL
const issuer = 'https://playmat-oauth-fixture.example'
const resource = issuer + '/mcp'
const clientId = 'https://chatgpt.com/oauth/client.json'
const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect'
const state = 'synthetic-opaque-state'
const verifier = 'fixture-verifier'.padEnd(64, '0')
const challenge = createHash('sha256').update(verifier).digest('base64url')
const password = 'synthetic-browser-password'

async function fixture(t, oauthClients = [], oauthClientOptions) {
  const replayDirectory = await mkdtemp(join(tmpdir(), 'playmat-oauth-'))
  const schema = 'test_' + randomUUID().replaceAll('-', '')
  const delivered = []
  const eventOptions = { deliver: async (_url, { body }) => {
    const payload = JSON.parse(body)
    if (payload.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) }
    delivered.push({ type: payload.name, tableId: payload.data.tableId })
    return { status: 204, body: '' }
  } }
  const product = await createProduct({ databaseUrl, schema, replayDirectory, store: new Map(), publicUrl: issuer,
    oauthClients: [{ clientId, redirectUri: redirect, name: 'Fixture client' }, ...oauthClients], oauthClientOptions,
    insecureCookie: true, eventOptions })
  product.server.listen(0, '127.0.0.1')
  await once(product.server, 'listening')
  t.after(async () => {
    product.server.close()
    product.server.closeAllConnections()
    await product.dropTestSchema()
    await product.close()
    await rm(replayDirectory, { recursive: true, force: true })
  })
  const endpoint = 'http://127.0.0.1:' + product.server.address().port
  const request = (path, fields = {}, form, method = form ? 'POST' : 'GET') => new Promise((resolve, reject) => {
    const headers = { Host: new URL(issuer).host, ...fields }
    const mime = headers['Content-Type'] ?? headers['content-type'] ?? (method === 'PUT' ? 'application/json' : 'application/x-www-form-urlencoded')
    const payload = form && (mime === 'application/json' ? JSON.stringify(form) : new URLSearchParams(form).toString())
    if (form) {
      headers['Content-Type'] = mime
      headers['Content-Length'] = Buffer.byteLength(payload)
    }
    const req = httpRequest(endpoint + path, { method, headers }, reply => {
      const chunks = []
      reply.on('data', chunk => chunks.push(chunk))
      reply.on('error', reject)
      reply.on('end', () => {
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(reply.headers)) {
          for (const field of Array.isArray(value) ? value : [value]) responseHeaders.append(key, field)
        }
        resolve(new Response(chunks.length ? Buffer.concat(chunks) : null, { status: reply.statusCode, headers: responseHeaders }))
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
  async function login(name) {
    await product.provisionHuman(name, password)
    const signedIn = await request('/login', {}, { username: name, password })
    assert.equal(signedIn.status, 303)
    return { Cookie: signedIn.headers.get('Set-Cookie').split(';', 1)[0], Origin: issuer }
  }
  return { product, request, login, schema, delivered }
}

function authPath(fields = {}) {
  return '/oauth/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirect, resource,
    code_challenge: challenge, code_challenge_method: 'S256', state, ...fields,
  })
}

async function consent(f, headers, parameters = {}) {
  const approval = await f.request(authPath(parameters), headers)
  assert.equal(approval.status, 200)
  const html = await approval.text()
  assert.match(html, /mazos de la cuenta/)
  assert.match(html, /Conectar tu cuenta de Thoughtseize/)
  assert.doesNotMatch(html, /name="seat"|<select|OwnDot|AnotherDot|AnalysisOnly|mcp_[a-f0-9]{10}/)
  const request = /name="request" value="([a-f0-9-]{36})"/.exec(html)?.[1]
  assert.ok(Boolean(request), 'The browser consent request can be submitted')
  return request
}

test('[PM-AC-18] a Playmat account connects its library and rival without a preconfigured agent, then exchanges a single PKCE code', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await f.login('Alice')
  const bob = await f.login('Bob')
  const originalGrant = await f.product.provisionAgent('Bob', 'AnotherDot', ['play', 'chat'])

  const res = await f.request('/.well-known/oauth-protected-resource/mcp')
  assert.equal(res.status, 200)
  const protectedResource = await res.json()
  assert.equal(protectedResource.resource, resource)
  assert.deepEqual(protectedResource.authorization_servers, [issuer])
  const auth = await (await f.request('/.well-known/oauth-authorization-server')).json()
  assert.equal(auth.issuer, issuer)
  assert.equal(auth.authorization_response_iss_parameter_supported, true)
  assert.ok(auth.code_challenge_methods_supported.includes('S256'))

  const loginNeeded = await f.request(authPath())
  assert.equal(loginNeeded.status, 303)
  assert.equal(new URL(loginNeeded.headers.get('Location'), issuer).pathname, '/login')
  assert.equal((await f.request(authPath({ redirect_uri: 'https://untrusted.example/callback' }), alice)).status, 400)
  const plainPkce = await f.request(authPath({ code_challenge_method: 'plain' }), alice)
  assert.equal(plainPkce.status, 303)
  const invalid = new URL(plainPkce.headers.get('Location'))
  assert.equal(invalid.searchParams.get('error'), 'invalid_request')
  assert.equal(invalid.searchParams.get('iss'), issuer)
  assert.equal((await f.request(authPath(), { Authorization: 'Bearer ' + originalGrant })).status, 303)

  const request = await consent(f, alice)
  assert.equal((await f.request('/oauth/authorize', bob, { request, decision: 'allow' })).status, 400)
  assert.equal((await f.request('/oauth/authorize', alice, { request, seat: 'AnotherDot', decision: 'allow' })).status, 400)
  assert.equal((await f.request('/oauth/authorize', { ...alice, Origin: 'https://untrusted.example' }, { request, decision: 'allow' })).status, 403)
  assert.equal((await f.request('/oauth/authorize', { ...alice, Origin: 'null' }, { request, decision: 'allow' })).status, 403)
  assert.equal((await f.request('/oauth/authorize', { ...alice, 'Sec-Fetch-Site': 'cross-site' }, { request, decision: 'allow' })).status, 403)
  assert.equal((await f.request('/oauth/authorize', { Cookie: alice.Cookie }, { request, decision: 'allow' })).status, 403)

  const approved = await f.request('/oauth/authorize', alice, { request, decision: 'allow' })
  assert.equal(approved.status, 303)
  const returned = new URL(approved.headers.get('Location'))
  assert.equal(returned.origin + returned.pathname, redirect)
  assert.equal(returned.searchParams.get('iss'), issuer)
  assert.ok(returned.searchParams.get('state') === state, 'Client state round trips')
  const code = returned.searchParams.get('code')
  assert.ok(Boolean(code), 'Approved consent produces a code')
  const exchange = {
    grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirect, code_verifier: verifier, resource,
  }
  assert.equal((await f.request('/oauth/token', {}, { ...exchange, code_verifier: 'x'.repeat(64) })).status, 400)
  assert.equal((await f.request('/oauth/token', {}, { ...exchange, resource: issuer + '/other' })).status, 400)
  const tokenResponse = await f.request('/oauth/token', {}, exchange)
  assert.equal(tokenResponse.status, 200)
  const tokens = await tokenResponse.json()
  assert.equal(tokens.token_type, 'Bearer')
  assert.equal(tokens.scope, 'play library chat')
  assert.ok(Boolean(tokens.refresh_token) && Boolean(tokens.access_token), 'Both token types are issued')
  assert.equal((await f.request('/oauth/token', {}, exchange)).status, 400)
  assert.equal((await f.request('/oauth/authorize', alice, { request, decision: 'allow' })).status, 400)

  async function authenticate(accessToken) {
    return f.request('/internal/verify', { Authorization: 'Bearer ' + accessToken })
  }
  const authorized = await authenticate(tokens.access_token)
  assert.equal(authorized.headers.get('x-playmat-canonical-agent'), '1')
  const identity = await authorized.json()
  assert.equal(identity.engineName, 'mcp_Alice')
  assert.equal(identity.canonicalAgent, true)
  assert.equal(identity.agent, true)
  assert.equal(identity.accountAgent, true)
  assert.deepEqual(identity.scopes, ['play', 'library', 'chat'])
  assert.equal(identity.accountId, (await (await f.request('/api/playtesting/me', alice)).json()).accountId)
  assert.match(identity.connectionId, /^[a-f0-9-]{36}$/)
  const decks = '/api/playtesting/decks'
  const deckId = randomUUID()
  const deck = { name: 'Alice Forests', format: 'Pioneer', cards: [{ name: 'Forest', quantity: 60 }], sideboard: [] }
  const stored = await f.request(`${decks}/${deckId}`, { Authorization: 'Bearer ' + tokens.access_token },
    { expectedRevision: 0, data: deck }, 'PUT')
  assert.equal(stored.status, 200)
  const browserDecks = await (await f.request(decks, alice)).json()
  const foreignDecks = await (await f.request(decks, bob)).json()
  assert.equal(browserDecks.decks.some(entry => entry.id === deckId), true)
  assert.equal(foreignDecks.decks.some(entry => entry.id === deckId), false)
  assert.doesNotMatch(await (await f.request('/oauth/connections', alice)).text(), /mcp_[a-f0-9]{10}/)

  const jsonHeaders = { 'Content-Type': 'application/json' }
  const subscription = await f.request('/internal/mcp-events/subscribe', { ...jsonHeaders, Authorization: 'Bearer ' + tokens.access_token }, {
    name: 'game.invitation.created',
    delivery: { mode: 'webhook', url: 'https://mcp-events-fixture.example/callback', secret: 'whsec_' + Buffer.alloc(32, 44).toString('base64') },
  })
  assert.equal(subscription.status, 200)
  const ownInvite = { tableId: randomUUID(), roomId: randomUUID(), format: 'Pioneer', mode: 'mcp', password: 'synthetic-table-password' }
  const otherInvite = { ...ownInvite, tableId: randomUUID() }
  assert.equal((await f.request('/api/playtesting/invites', { ...alice, ...jsonHeaders }, ownInvite)).status, 201)
  assert.equal((await f.request('/api/playtesting/invites', { ...bob, ...jsonHeaders }, otherInvite)).status, 201)
  f.product.startMcpEvents()
  for (let attempt = 0; !f.delivered.length && attempt < 25; attempt += 1) await sleep(100)
  assert.deepEqual(f.delivered, [{ type: 'game.invitation.created', tableId: ownInvite.tableId }])

  const reconnect = await f.request('/oauth/authorize', alice, { request: await consent(f, alice), decision: 'allow' })
  assert.equal(reconnect.status, 303)
  const newCode = new URL(reconnect.headers.get('Location')).searchParams.get('code')
  const extraTokens = await (await f.request('/oauth/token', {}, { ...exchange, code: newCode })).json()
  const extraIdentity = await (await authenticate(extraTokens.access_token)).json()
  assert.equal(extraIdentity.engineName, identity.engineName)
  assert.notEqual(extraIdentity.connectionId, identity.connectionId)

  const refresh = { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource }
  const refreshed = await f.request('/oauth/token', {}, refresh)
  assert.equal(refreshed.status, 200)
  const next = await refreshed.json()
  assert.ok(next.refresh_token !== tokens.refresh_token, 'Refresh credentials rotate')
  assert.equal((await f.request('/oauth/token', {}, refresh)).status, 400)
  const again = await (await authenticate(next.access_token)).json()
  assert.equal(again.connectionId, identity.connectionId)

  assert.equal((await f.request('/oauth/connections', bob, { connection: identity.connectionId })).status, 404)
  assert.equal((await f.request('/oauth/connections', alice, { connection: identity.connectionId })).status, 303)
  assert.equal((await authenticate(next.access_token)).status, 401)
  assert.equal((await authenticate(originalGrant)).status, 200)
})

test('[PM-AC-20] DCR persists a generic native client and binds each code to the requested loopback port', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await f.login('Alice')
  const web = { Origin: 'https://generic-client.example', 'Content-Type': 'application/json' }
  const metadata = { client_name: 'Any MCP application', redirect_uris: ['http://localhost/callback'],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }
  const discovery = await (await f.request('/.well-known/oauth-authorization-server')).json()
  assert.equal(discovery.registration_endpoint, issuer + '/oauth/register')
  const preflight = await f.request('/oauth/register', web, undefined, 'OPTIONS')
  assert.equal(preflight.status, 204)
  const registered = await f.request('/oauth/register', web, metadata)
  assert.equal(registered.status, 201, await registered.clone().text())
  assert.equal(registered.headers.get('access-control-allow-origin'), '*')
  const client = await registered.json()
  assert.equal(client.application_type, 'native')
  assert.equal(client.token_endpoint_auth_method, 'none')
  assert.equal(client.client_secret, undefined)
  assert.equal(client.registration_access_token, undefined)
  assert.equal(typeof client.client_id, 'string')
  assert.notEqual(client.client_id, clientId)
  const db = new pg.Client({ connectionString: databaseUrl, options: '-c search_path=' + f.schema })
  await db.connect()
  t.after(() => db.end())
  const { rows: [persisted] } = await db.query('SELECT metadata FROM oauth_registered_clients WHERE client_id=$1', [client.client_id])
  assert.equal(persisted.metadata.application_type, 'native')
  const fresh = createClientRegistry(db, issuer)
  assert.equal((await fresh.get(client.client_id)).allows('http://localhost:45679/callback'), true, 'A new provider reads durable registrations')

  const destination = 'http://localhost:45678/callback'
  const parameters = { client_id: client.client_id, redirect_uri: destination }
  for (const bad of ['http://localhost:45678/other', 'http://localhost.evil.example:45678/callback',
    'http://127.0.0.1:45678/callback', 'https://localhost:45678/callback', 'http://localhost:45678/callback?changed=1']) {
    const response = await f.request(authPath({ ...parameters, redirect_uri: bad }), alice)
    assert.equal(response.status, 400, bad)
    assert.equal(response.headers.get('location'), null)
  }
  const id = await consent(f, alice, parameters)
  const page = await (await f.request(authPath(parameters), alice)).text()
  assert.match(page, /Any MCP application/)
  assert.match(page, /http:\/\/localhost:45678\/callback/)
  assert.match(page, /este dispositivo/)
  const approved = await f.request('/oauth/authorize', alice, { request: id, decision: 'allow' })
  const callback = new URL(approved.headers.get('location'))
  assert.equal(callback.origin + callback.pathname, destination)
  assert.equal(callback.searchParams.get('state'), state)
  assert.equal(callback.searchParams.get('iss'), issuer)
  const exchange = { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: destination,
    code: callback.searchParams.get('code'), code_verifier: verifier, resource }
  for (const changed of [{ redirect_uri: 'http://localhost:45679/callback' }, { client_id: clientId, redirect_uri: redirect },
    { resource: issuer + '/wrong' }, { code_verifier: 'wrong'.padEnd(64, '0') }]) {
    const denied = await f.request('/oauth/token', {}, { ...exchange, ...changed })
    assert.equal(denied.status, 400)
    assert.equal((await denied.json()).access_token, undefined)
  }
  const clientOrigin = { Origin: web.Origin }
  const outcomes = await Promise.all([f.request('/oauth/token', clientOrigin, exchange), f.request('/oauth/token', clientOrigin, exchange)])
  assert.deepEqual(outcomes.map(res => res.status).sort(), [200, 400], 'Concurrent code use succeeds exactly once')
  const tokens = await outcomes.find(res => res.status === 200).json()
  assert.equal((await f.request('/internal/verify', { Authorization: 'Bearer ' + tokens.access_token })).status, 200)
  const refresh = { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource }
  assert.equal((await f.request('/oauth/token', {}, { ...refresh, client_id: clientId })).status, 400)
  assert.equal((await f.request('/oauth/token', {}, { ...refresh, resource: issuer + '/wrong' })).status, 400)
  const rotated = await Promise.all([f.request('/oauth/token', {}, refresh), f.request('/oauth/token', {}, refresh)])
  assert.deepEqual(rotated.map(res => res.status).sort(), [200, 400])
  const next = await rotated.find(res => res.status === 200).json()
  assert.notEqual(next.refresh_token, tokens.refresh_token)
  assert.equal((await f.request('/oauth/revoke', clientOrigin, { client_id: client.client_id, token: next.refresh_token })).status, 200)
  assert.equal((await f.request('/internal/verify', { Authorization: 'Bearer ' + next.access_token })).status, 401)
  assert.equal((await f.request('/oauth/token', {}, { ...refresh, refresh_token: next.refresh_token })).status, 400)
  assert.equal((await db.query('SELECT count(*)::int AS count FROM oauth_authorization_codes')).rows[0].count, 0)
})

test('[PM-AC-20] CIMD resolves unconfigured clients, accepts native loopbacks and preserves exact HTTPS callbacks', { skip: !databaseUrl }, async t => {
  let fetches = 0
  const documents = new Map()
  const genericId = 'https://generic-client.example/oauth/client.json'
  const callback = 'https://generic-client.example/connect?installation=fixture'
  documents.set(genericId, { client_id: genericId, client_name: '<Generic MCP client>', redirect_uris: [callback],
    token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    jwks_uri: 'https://generic-client.example/oauth/jwks.json',
    grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'] })
  const nativeId = 'https://native-client.example/oauth/client.json'
  documents.set(nativeId, { client_id: nativeId, client_name: 'Native MCP client', application_type: 'native',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback', 'http://[::1]/callback'], token_endpoint_auth_method: 'none' })
  const f = await fixture(t, [], { fetch: async url => {
    fetches++
    return new Response(JSON.stringify(documents.get(url)), { headers: { 'Cache-Control': 'max-age=60' } })
  } })
  const alice = await f.login('Alice')
  for (const [id, destination] of [[genericId, callback], [nativeId, 'http://localhost:43210/callback'],
    [nativeId, 'http://127.0.0.1:43211/callback'], [nativeId, 'http://[::1]:43212/callback']]) {
    const parameters = { client_id: id, redirect_uri: destination }
    const request = await consent(f, alice, parameters)
    const approved = await f.request('/oauth/authorize', alice, { request, decision: 'allow' })
    const returned = new URL(approved.headers.get('location'))
    if (id === genericId) assert.equal(returned.searchParams.get('installation'), 'fixture')
    assert.equal(returned.searchParams.get('state'), state)
    const token = await f.request('/oauth/token', {}, { grant_type: 'authorization_code', client_id: id,
      redirect_uri: destination, code: returned.searchParams.get('code'), code_verifier: verifier, resource })
    assert.equal(token.status, 200, await token.clone().text())
    assert.equal((await f.request('/internal/verify', { Authorization: 'Bearer ' + (await token.json()).access_token })).status, 200)
  }
  assert.equal(fetches, 2, 'Metadata is cached by the library across authorization and token requests')
  const page = await (await f.request(authPath({ client_id: genericId, redirect_uri: callback }), alice)).text()
  assert.match(page, /&lt;Generic MCP client&gt;/)
  assert.doesNotMatch(page, /<Generic MCP client>/)
  for (const bad of [callback + '&extra=1', 'https://generic-client.example/connect?installation=other',
    'https://generic-client.example/other?installation=fixture', 'https://evil.example/connect?installation=fixture']) {
    assert.equal((await f.request(authPath({ client_id: genericId, redirect_uri: bad }), alice)).status, 400)
  }
})

test('[PM-AC-20] DCR supports unnamed public web clients and matches their full HTTPS callback exactly', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await f.login('Alice')
  const destination = 'https://any-web-client.example:8443/callback?tenant=one'
  const registered = await f.request('/oauth/register', { 'Content-Type': 'application/json' },
    { redirect_uris: [destination], token_endpoint_auth_method: 'none' })
  assert.equal(registered.status, 201, await registered.clone().text())
  const client = await registered.json()
  assert.equal(client.client_name, 'Cliente MCP')
  assert.equal(client.application_type, 'web')
  for (const bad of ['https://any-web-client.example:8444/callback?tenant=one', 'https://any-web-client.example:8443/callback?tenant=two']) {
    assert.equal((await f.request(authPath({ client_id: client.client_id, redirect_uri: bad }), alice)).status, 400)
  }
  const request = await consent(f, alice, { client_id: client.client_id, redirect_uri: destination })
  const approved = await f.request('/oauth/authorize', alice, { request, decision: 'allow' })
  const callback = new URL(approved.headers.get('location'))
  assert.equal(callback.origin, 'https://any-web-client.example:8443')
  assert.equal(callback.searchParams.get('tenant'), 'one')
  const token = await f.request('/oauth/token', {}, { client_id: client.client_id, grant_type: 'authorization_code',
    code: callback.searchParams.get('code'), redirect_uri: destination, code_verifier: verifier, resource })
  assert.equal(token.status, 200)
})

test('[PM-AC-20] invalid DCR and CIMD never issue grants or redirect to unchecked destinations', { skip: !databaseUrl }, async t => {
  const badId = 'https://unconfigured-client.example/client.json'
  let document = { client_id: 'https://different.example/client.json', client_name: 'Impersonation', redirect_uris: ['https://evil.example/callback'] }
  const f = await fixture(t, [], { fetch: async () => new Response(typeof document === 'string' ? document : JSON.stringify(document),
    { headers: { 'Cache-Control': 'no-store' } }) })
  const alice = await f.login('Alice')
  for (const value of [document, 'not json', [], { client_id: badId, redirect_uris: [redirect] },
    { client_id: badId, client_name: 'Invalid', redirect_uris: ['http://10.0.0.1/callback'] },
    { client_id: badId, client_name: 'Invalid', redirect_uris: [redirect], token_endpoint_auth_method: 'client_secret_post' }]) {
    document = value
    const destination = value?.redirect_uris?.[0] ?? 'https://evil.example/callback'
    const result = await f.request(authPath({ client_id: badId, redirect_uri: destination }), alice)
    assert.equal(result.status, 400)
    assert.equal(result.headers.get('location'), null)
  }
  const headers = { 'Content-Type': 'application/json' }
  for (const redirectUri of ['http://evil.example/callback', 'https://user:pass@evil.example/callback',
    'https://evil.example/callback#fragment', 'https://*.example/callback', 'https://evil.example/callback?code=preexisting']) {
    const result = await f.request('/oauth/register', headers, { client_name: 'Invalid', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' })
    assert.equal(result.status, 400, redirectUri)
    assert.equal((await result.json()).error, 'invalid_client_metadata')
  }
  const confidential = await f.request('/oauth/register', headers, {
    client_name: 'Unsupported', redirect_uris: [redirect], token_endpoint_auth_method: 'client_secret_post',
  })
  assert.equal(confidential.status, 400)
  const db = new pg.Client({ connectionString: databaseUrl, options: '-c search_path=' + f.schema })
  await db.connect()
  t.after(() => db.end())
  for (const table of ['oauth_registered_clients', 'oauth_consent_requests', 'oauth_authorization_codes', 'oauth_connections', 'oauth_access_tokens']) {
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0, table)
  }
  await db.query("INSERT INTO oauth_registration_limits(hour,attempts) VALUES (date_trunc('hour',now()),200) ON CONFLICT(hour) DO UPDATE SET attempts=200")
  assert.equal((await f.request('/oauth/register', headers, { client_name: 'Rate limited', redirect_uris: [redirect] })).status, 429)
})

test('[PM-AC-20] expired consent, codes, access and refresh credentials fail independently', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await f.login('Alice')
  const db = new pg.Client({ connectionString: databaseUrl, options: '-c search_path=' + f.schema })
  await db.connect()
  t.after(() => db.end())
  const request = await consent(f, alice)
  await db.query("UPDATE oauth_consent_requests SET expires_at=now()-interval '1 second'")
  assert.equal((await f.request('/oauth/authorize', alice, { request, decision: 'allow' })).status, 400)
  async function code() {
    const approved = await f.request('/oauth/authorize', alice, { request: await consent(f, alice), decision: 'allow' })
    return new URL(approved.headers.get('location')).searchParams.get('code')
  }
  const exchange = { grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirect, code_verifier: verifier, resource, code: await code() }
  await db.query("UPDATE oauth_authorization_codes SET expires_at=now()-interval '1 second'")
  assert.equal((await f.request('/oauth/token', {}, exchange)).status, 400)
  exchange.code = await code()
  const tokens = await (await f.request('/oauth/token', {}, exchange)).json()
  const verify = () => f.request('/internal/verify', { Authorization: 'Bearer ' + tokens.access_token })
  assert.equal((await verify()).status, 200)
  await db.query("UPDATE oauth_access_tokens SET expires_at=now()-interval '1 second'")
  assert.equal((await verify()).status, 401)
  // Restore only access expiry: the independently expired connection must still reject it.
  await db.query("UPDATE oauth_access_tokens SET expires_at=now()+interval '1 minute'")
  assert.equal((await verify()).status, 200)
  await db.query("UPDATE oauth_connections SET expires_at=now()-interval '1 second'")
  assert.equal((await verify()).status, 401)
  assert.equal((await f.request('/oauth/token', {}, { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource })).status, 400)
})

test('[PM-AC-20] the official MCP SDK discovers, registers, authorizes and refreshes through standard HTTP',
  { skip: !databaseUrl || process.env.PLAYMAT_OAUTH_SDK_TEST !== '1' }, async t => {
    const requireMcp = createRequire(new URL('../mcp/package.json', import.meta.url))
    const { auth } = requireMcp('@modelcontextprotocol/sdk/client/auth.js')
    const f = await fixture(t)
    const alice = await f.login('Alice')
    let information, tokens, savedVerifier, authorization
    const provider = {
      redirectUrl: new URL('http://127.0.0.1:49152/callback'),
      clientMetadata: { client_name: 'Official SDK fixture', token_endpoint_auth_method: 'none',
        redirect_uris: ['http://127.0.0.1:49152/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
      clientInformation: () => information,
      saveClientInformation: value => { information = value },
      tokens: () => tokens,
      saveTokens: value => { tokens = value },
      state: () => state,
      codeVerifier: () => savedVerifier,
      saveCodeVerifier: value => { savedVerifier = value },
      redirectToAuthorization: value => { authorization = value },
    }
    const options = { serverUrl: resource, fetchFn: async (value, init = {}) => {
      const url = new URL(value)
      assert.equal(url.origin, issuer)
      const headers = Object.fromEntries(new Headers(init.headers))
      const payload = init.body && (headers['content-type']?.startsWith('application/json')
        ? JSON.parse(init.body) : new URLSearchParams(init.body))
      return f.request(url.pathname + url.search, headers, payload, init.method ?? 'GET')
    } }
    assert.equal(await auth(provider, options), 'REDIRECT')
    assert.equal(information.token_endpoint_auth_method, 'none')
    assert.equal(authorization.searchParams.get('resource'), resource)
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(authorization.searchParams.get('state'), state)
    const page = await f.request(authorization.pathname + authorization.search, alice)
    assert.equal(page.status, 200)
    const request = /name="request" value="([a-f0-9-]{36})"/.exec(await page.text())?.[1]
    assert.ok(request)
    const approved = await f.request('/oauth/authorize', alice, { request, decision: 'allow' })
    const callback = new URL(approved.headers.get('location'))
    assert.equal(callback.origin + callback.pathname, provider.redirectUrl.href)
    assert.equal(await auth(provider, { ...options, authorizationCode: callback.searchParams.get('code') }), 'AUTHORIZED')
    const first = tokens
    assert.equal((await f.request('/internal/verify', { Authorization: 'Bearer ' + first.access_token })).status, 200)
    assert.equal(await auth(provider, options), 'AUTHORIZED')
    assert.notEqual(tokens.refresh_token, first.refresh_token)
    assert.equal((await f.request('/internal/verify', { Authorization: 'Bearer ' + tokens.access_token })).status, 200)
  })

test('[PM-AC-19] the browser can approve OAuth and returns to the external client without a referrer',
  { skip: !databaseUrl || process.env.PLAYMAT_OAUTH_BROWSER_TEST !== '1' }, async t => {
    const requireWeb = createRequire(new URL('../../../Mage.Web.Client/package.json', import.meta.url))
    const { chromium } = requireWeb('playwright')
    let callback
    const client = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname !== '/callback') return res.writeHead(404).end()
      callback = {
        method: req.method, hasBody: Boolean(Number(req.headers['content-length']) || req.headers['transfer-encoding']),
        hasReferrer: Boolean(req.headers.referer), carriesCode: Boolean(url.searchParams.get('code')),
        preservesState: url.searchParams.get('state') === state,
      }
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>OAuth callback received</title>')
    })
    client.listen(0, '127.0.0.1')
    await once(client, 'listening')
    t.after(() => { client.close(); client.closeAllConnections() })
    const registered = { clientId: 'browser-fixture', redirectUri: `http://127.0.0.1:${client.address().port}/callback`, name: 'Browser fixture' }
    const f = await fixture(t, [registered])
    const alice = await f.login('Alice')
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
    t.after(() => browser.close())
    const page = await browser.newPage()
    const [name, value] = alice.Cookie.split('=')
    await page.context().addCookies([{ name, value, url: issuer, sameSite: 'Lax' }])

    let submitted
    // Bridge the virtual HTTPS issuer to the local product fixture, preserving browser-generated headers.
    await page.route(issuer + '/oauth/authorize*', async route => {
      const req = route.request()
      const method = req.method()
      const headers = await req.allHeaders()
      const fields = {}
      for (const key of ['cookie', 'origin', 'sec-fetch-site']) {
        if (key in headers) fields[key] = headers[key]
      }
      const form = method === 'POST' ? new URLSearchParams(req.postData()) : undefined
      const url = new URL(req.url())
      const response = await f.request(url.pathname + url.search, fields, form, method)
      if (method === 'POST') submitted = { status: response.status, origin: headers.origin }
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
    })

    await page.goto(issuer + authPath({ client_id: registered.clientId, redirect_uri: registered.redirectUri }))
    await page.getByRole('button', { name: 'Autorizar' }).click()
    assert.deepEqual(submitted, { status: 303, origin: issuer })
    await page.waitForFunction(() => document.title === 'OAuth callback received', null, { timeout: 5000 })
    assert.deepEqual(callback, { method: 'GET', hasBody: false, hasReferrer: false, carriesCode: true, preservesState: true })
  })

test('[PM-AC-18] denial returns an issuer-bound error and sign-out invalidates pending consent', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await f.login('Alice')
  const request = await consent(f, alice)
  const denied = await f.request('/oauth/authorize', alice, { request, decision: 'deny' })
  assert.equal(denied.status, 303)
  const response = new URL(denied.headers.get('Location'))
  assert.equal(response.searchParams.get('iss'), issuer)
  assert.equal(response.searchParams.get('error'), 'access_denied')
  const next = await consent(f, alice)
  assert.equal((await f.request('/logout', alice, {})).status, 303)
  assert.equal((await f.request('/oauth/authorize', alice, { request: next, decision: 'allow' })).status, 400)
})

test('[PM-AC-18] a legacy OAuth connection cannot authenticate, refresh, or keep delivering events after the migration', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await f.login('Alice')
  const originalGrant = await f.product.provisionAgent('Alice', 'PreviousRival', ['play', 'chat'])
  const { accountId } = await (await f.request('/api/playtesting/me', alice)).json()
  const connectionId = randomUUID()
  const oldAccess = 'a'.repeat(43)
  const oldRefresh = 'r'.repeat(43)
  const sha256 = value => createHash('sha256').update(value).digest('hex')
  const client = new pg.Client({ connectionString: databaseUrl, options: '-c search_path=' + f.schema })
  await client.connect()
  try {
    await client.query(`INSERT INTO oauth_connections (id,account_id,engine_key,client_id,audience,scopes_approved,refresh_digest,expires_at)
      VALUES ($1,$2,'previousrival',$3,$4,ARRAY['play'],$5,now()+interval '1 day')`,
    [connectionId, accountId, clientId, resource, sha256(oldRefresh)])
    await client.query("INSERT INTO oauth_access_tokens(digest,connection_id,expires_at) VALUES ($1,$2,now()+interval '1 day')",
      [sha256(oldAccess), connectionId])
    assert.equal((await f.request('/internal/verify', { Authorization: 'Bearer ' + oldAccess })).status, 401)
    const refresh = await f.request('/oauth/token', {}, { grant_type: 'refresh_token', client_id: clientId, resource, refresh_token: oldRefresh })
    assert.equal(refresh.status, 400)
    await client.query(await readFile(new URL('./oauth-schema.sql', import.meta.url), 'utf8'))
    const { rows: [row] } = await client.query('SELECT revoked_at IS NOT NULL AS revoked FROM oauth_connections WHERE id=$1', [connectionId])
    assert.equal(row.revoked, true)
    assert.equal((await f.request('/internal/verify', { Authorization: 'Bearer ' + originalGrant })).status, 200)
  } finally {
    await client.end()
  }
})

test('[PM-AC-18] a registered OAuth client is bound to its exact callback and selected non-play scopes', { skip: !databaseUrl }, async t => {
  const client = { clientId: 'sample-mcp-client', redirectUri: 'https://mcp-client-fixture.example/connect', name: 'Sample MCP client' }
  const f = await fixture(t, [client])
  const alice = await f.login('Alice')
  const parameters = { client_id: client.clientId, redirect_uri: client.redirectUri, scope: 'history library' }
  assert.equal((await f.request(authPath({ ...parameters, redirect_uri: client.redirectUri + '/wrong' }), alice)).status, 400)
  const consentPage = await f.request(authPath(parameters), alice)
  assert.match(consentPage.headers.get('content-security-policy'), /form-action 'self' https:\/\/mcp-client-fixture\.example;/)
  assert.doesNotMatch(consentPage.headers.get('content-security-policy'), /chatgpt\.com/)
  const html = await consentPage.text()
  assert.match(html, /Sample MCP client/)
  assert.match(html, /historial de la cuenta/)
  assert.doesNotMatch(html, /name="seat"|<select|juego e invitaciones/)
  const request = /name="request" value="([a-f0-9-]{36})"/.exec(html)?.[1]
  assert.ok(Boolean(request), 'Registered OAuth client offers consent')
  const approved = await f.request('/oauth/authorize', alice, { request, decision: 'allow' })
  assert.equal(approved.status, 303)
  const callback = new URL(approved.headers.get('Location'))
  assert.equal(callback.origin + callback.pathname, client.redirectUri)
  const code = callback.searchParams.get('code')
  assert.ok(Boolean(code), 'Consent returns a code to the registered callback')
  const exchange = { grant_type: 'authorization_code', code, code_verifier: verifier, resource }
  assert.equal((await f.request('/oauth/token', {}, { ...exchange, client_id: clientId, redirect_uri: redirect })).status, 400)
  const tokenResponse = await f.request('/oauth/token', {}, { ...exchange, client_id: client.clientId, redirect_uri: client.redirectUri })
  assert.equal(tokenResponse.status, 200)
  const tokens = await tokenResponse.json()
  assert.equal(tokens.scope, 'history library')
  const authorization = { Authorization: 'Bearer ' + tokens.access_token }
  const identity = await (await f.request('/internal/verify', authorization)).json()
  assert.deepEqual(identity.scopes, ['history', 'library'])
  assert.equal((await f.request('/internal/verify?scope=play', authorization)).status, 403)
  assert.equal((await f.request('/oauth/revoke', {}, { client_id: clientId, token: tokens.refresh_token })).status, 200)
  assert.equal((await f.request('/internal/verify', authorization)).status, 200)
  assert.equal((await f.request('/oauth/revoke', {}, { client_id: client.clientId, token: tokens.refresh_token })).status, 200)
  assert.equal((await f.request('/internal/verify', authorization)).status, 401)
})

test('owner delegates four named players to isolated OAuth pilots with exclusive table reservations', {skip: !databaseUrl}, async t => {
  const f = await fixture(t)
  const owner = await f.login('Owner')
  const other = await f.login('OtherOwner')
  const api = '/api/playtesting/players'
  const write = (path, headers, data, method = 'POST') => f.request(path, {...headers, 'Content-Type':'application/json'}, data, method)
  const list = async headers => (await (await f.request(api, headers)).json()).players
  const players = []
  for (const displayName of ['One','Two','Three','Four']) {
    const created = await write(api, owner, {displayName, flag:'CL', mcpEnabled:true})
    assert.equal(created.status, 201)
    players.push(await created.json())
  }
  assert.equal(new Set(players.map(p => p.engineName)).size, 4)
  assert.equal(new Set(players.map(p => p.playerId)).size, 4)
  assert.equal((await list(owner)).length, 4)
  assert.equal((await list(other)).length, 0)
  const [one, two] = players
  assert.equal((await write(api+'/'+one.playerId, other, {displayName:'Hijack'}, 'PATCH')).status, 404)
  assert.equal((await write(api+'/'+one.playerId, owner, {flag:'invalid'}, 'PATCH')).status, 400)
  const changed = await write(api+'/'+one.playerId, owner, {displayName:'First pilot', flag:'us'}, 'PATCH')
  assert.equal((await changed.json()).engineName, one.engineName)
  const publicIds = await (await f.request('/api/playtesting/player-identities?names='+one.engineName, owner)).json()
  assert.equal(publicIds.players[0].displayName, 'First pilot')
  assert.equal(publicIds.players[0].flag, 'US')

  async function approval(headers, profile) {
    const consentPage = await f.request(authPath({scope:'play library history chat'}), headers)
    const request = /name="request" value="([a-f0-9-]{36})"/.exec(await consentPage.text())?.[1]
    assert.ok(request)
    return f.request('/oauth/authorize', headers, {request, playerId:profile.playerId, decision:'allow'})
  }
  async function connect(profile) {
    const approved = await approval(owner, profile)
    assert.equal(approved.status, 303)
    const code = new URL(approved.headers.get('Location')).searchParams.get('code')
    const issued = await f.request('/oauth/token', {}, {grant_type:'authorization_code', code, client_id:clientId,
      redirect_uri:redirect, code_verifier:verifier, resource})
    assert.equal(issued.status, 200)
    const tokens = await issued.json()
    assert.ok(!tokens.scope.split(' ').includes('history'))
    return {Authorization:'Bearer '+tokens.access_token}
  }
  assert.equal((await approval(other, one)).status, 404)
  const pilots = []
  for (const player of players) pilots.push(await connect(player))
  const [pilot, second] = pilots
  assert.deepEqual((await list(pilot)).map(p=>p.playerId),[one.playerId])
  assert.equal((await write(api, pilot, {displayName:'Hidden sibling'})).status,403)
  assert.equal((await f.request('/api/playtesting/matches',pilot)).status,403)
  const deck = {expectedRevision:0,data:{name:'Fixture deck',format:'Pioneer',cards:[],sideboard:[]}}
  const decks = '/api/playtesting/decks'
  assert.equal((await write(decks+'/personal',owner,deck,'PUT')).status,200)
  assert.equal((await write(decks+'/shared',pilot,deck,'PUT')).status,200)
  assert.deepEqual((await (await f.request(decks,second)).json()).decks.map(d=>d.id),['shared'])
  assert.equal((await f.request(decks+'/personal',pilot)).status,404)
  assert.equal((await write(decks+'/personal',pilot,{...deck,expectedRevision:1},'PUT')).status,404)
  assert.equal((await f.request(decks+'?library=personal',pilot)).status,403)
  const tableA=randomUUID(), tableB=randomUUID()
  assert.equal((await f.request('/api/playtesting/human-seat/'+tableA,pilot)).status,403)
  assert.equal((await f.request('/internal/verify?scope=play',{...pilot,'X-Playmat-Client-IP':'192.0.2.1'})).status,403)
  const reserve = (headers,id,operation,reservationId,tableId) =>
    write('/internal/player-reservations/'+id, headers, {operation,reservationId,tableId})
  const claims = players.map(()=>randomUUID())
  assert.equal((await reserve(pilot,two.playerId,'reserve',randomUUID())).status,403)
  const competing = [claims[0],randomUUID()]
  const races = await Promise.all(competing.map(id => reserve(pilot,one.playerId,'reserve',id)))
  assert.deepEqual(races.map(r=>r.status).sort(),[200,409])
  claims[0] = competing[races.findIndex(r=>r.status===200)]
  assert.equal((await reserve(pilot,one.playerId,'reserve',claims[0])).status,200)
  const contender = await connect(one)
  assert.equal((await reserve(contender,one.playerId,'reserve',randomUUID())).status,409)
  assert.equal((await reserve(contender,one.playerId,'release',claims[0])).status,409)
  assert.equal((await (await f.request('/internal/verify',contender)).json()).ownsReservation,false)
  assert.equal((await list(contender))[0].reservationId,undefined)
  for (let i=0;i<4;i++) {
    const target = i<2?tableA:tableB
    if (i) assert.equal((await reserve(pilots[i],players[i].playerId,'reserve',claims[i])).status,200)
    assert.equal((await reserve(pilots[i],players[i].playerId,'bind',claims[i],target)).status,200)
    assert.equal((await reserve(pilots[i],players[i].playerId,'bind',claims[i],target)).status,200)
    assert.equal((await (await f.request('/internal/verify',pilots[i])).json()).activeTableId,target)
  }
  assert.equal((await reserve(second,two.playerId,'bind',claims[1],tableB)).status,409)
  const renamed = await write(api+'/'+one.playerId,owner,{displayName:'Renamed'},'PATCH')
  assert.equal((await renamed.json()).activeTableId,tableA)
  const before = await (await f.request('/internal/verify',pilot)).json()
  const principal = {accountId: before.accountId, seatId: before.recoverySeatId, connectionId: before.connectionId}
  assert.equal((await write('/internal/recovery/validate',{},principal)).status,200)
  const restored = randomUUID()
  assert.equal((await write('/internal/human-seat/restore',{}, {originalTableId:tableA,tableId:restored})).status,200)
  assert.equal((await (await f.request('/internal/verify',pilot)).json()).activeTableId,restored)
  assert.equal((await (await f.request('/internal/verify',second)).json()).activeTableId,restored)
  assert.equal((await (await f.request('/internal/verify',pilots[2])).json()).activeTableId,tableB)
  assert.equal((await write(api+'/'+one.playerId,owner,{mcpEnabled:false},'PATCH')).status,200)
  assert.equal((await f.request('/internal/verify',pilot)).status,401)
  assert.equal((await write('/internal/recovery/validate',{},principal)).status,403)
  assert.equal((await write(api+'/'+one.playerId,owner,{mcpEnabled:true},'PATCH')).status,200)
  assert.equal((await f.request('/internal/verify',pilot)).status,401)
  const renewed = await connect(one)
  const rebound = await (await f.request('/internal/verify',renewed)).json()
  assert.equal(rebound.reservationId,claims[0])
  assert.equal(rebound.activeTableId,restored)
  assert.notEqual(rebound.connectionId,before.connectionId)
  assert.equal(rebound.displayName,'Renamed')
  assert.equal(rebound.flag,'US')
  assert.equal((await reserve(renewed,one.playerId,'release',claims[0])).status,200)
  assert.equal((await (await f.request('/internal/verify',renewed)).json()).activeTableId,null)
})
