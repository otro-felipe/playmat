import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
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

async function fixture(t, oauthClients = [], oauthClientOptions, readSpectatorEngine) {
  const replayDirectory = await mkdtemp(join(tmpdir(), 'playmat-oauth-'))
  const schema = 'test_' + randomUUID().replaceAll('-', '')
  const store = new Map()
  const delivered = []
  const eventOptions = { deliver: async (_url, { body }) => {
    const payload = JSON.parse(body)
    if (payload.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) }
    delivered.push({ type: payload.name, tableId: payload.data.tableId })
    return { status: 204, body: '' }
  } }
  const product = await createProduct({ databaseUrl, schema, replayDirectory, store, publicUrl: issuer,
    oauthClients: [{ clientId, redirectUri: redirect, name: 'Fixture client' }, ...oauthClients], oauthClientOptions,
    insecureCookie: true, eventOptions, readSpectatorEngine })
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
  return { product, request, login, schema, delivered, replayDirectory, endpoint, store }
}

function authPath(fields = {}) {
  return '/oauth/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirect, resource,
    code_challenge: challenge, code_challenge_method: 'S256', state, ...fields,
  })
}

async function authorizePilot(f,owner,scope,playerId,manageSlots=false) {
  const page = await f.request(authPath(scope===undefined ? {} : {scope}),owner)
  const request = /name="request" value="([a-f0-9-]{36})"/.exec(await page.text())?.[1]
  const consent = await f.request('/oauth/authorize',owner,{request,decision:'allow',...(playerId && {playerId}),...(manageSlots && {manageSlots:'yes'})})
  assert.equal(consent.status,303)
  const code = new URL(consent.headers.get('Location')).searchParams.get('code')
  const token = await f.request('/oauth/token',{}, {grant_type:'authorization_code',code,client_id:clientId,redirect_uri:redirect,code_verifier:verifier,resource})
  assert.equal(token.status,200)
  return {Authorization:'Bearer '+(await token.json()).access_token}
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

test('[PM-AC-20] public clients register slot management and reauthorize only with owner consent', { skip: !databaseUrl }, async t => {
  const destination = 'https://slot-client.example/callback'
  const metadataId = 'https://slot-client.example/client.json'
  const narrowMetadataId = 'https://slot-client.example/play-only.json'
  const scopes = 'play library chat players:manage'
  const metadata = { client_name: 'Slot manager', redirect_uris: [destination], token_endpoint_auth_method: 'none', scope: scopes }
  const f = await fixture(t, [], { fetch: async url => Response.json({
    ...metadata, client_id: url, scope: url === narrowMetadataId ? 'play' : scopes,
  }) })
  const owner = await f.login('Owner')
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp']) {
    assert.ok((await (await f.request(path)).json()).scopes_supported.includes('players:manage'))
  }
  const register = async scope => {
    const response = await f.request('/oauth/register', { 'Content-Type': 'application/json' }, { ...metadata, scope })
    assert.equal(response.status, 201, 'DCR must accept its advertised scopes')
    const registered = await response.json()
    assert.equal(registered.scope, scope)
    return registered.client_id
  }
  async function connect(id, requested, manageSlots, expectCheckbox) {
    const fields = { client_id: id, redirect_uri: destination, ...(requested && { scope: requested }) }
    const consentPage = await f.request(authPath(fields), owner)
    assert.equal(consentPage.status, 200)
    const page = await consentPage.text()
    assert.equal(page.includes('name="manageSlots"'), expectCheckbox)
    const request = /name="request" value="([a-f0-9-]{36})"/.exec(page)?.[1]
    assert.ok(Boolean(request))
    const approved = await f.request('/oauth/authorize', owner, { request, decision: 'allow', ...(manageSlots && { manageSlots: 'yes' }) })
    assert.equal(approved.status, 303)
    const code = new URL(approved.headers.get('location')).searchParams.get('code')
    const response = await f.request('/oauth/token', {}, { client_id: id, redirect_uri: destination,
      grant_type: 'authorization_code', code_verifier: verifier, code, resource })
    assert.equal(response.status, 200)
    return response.json()
  }
  const create = (token, displayName) => f.request('/api/playtesting/player-slots',
    { Authorization: 'Bearer ' + token.access_token, 'Content-Type': 'application/json' }, { requestId: randomUUID(), displayName })
  const dcrId = await register(scopes)
  for (const id of [dcrId, metadataId]) {
    const previous = await connect(id, undefined, false, true)
    assert.equal((await create(previous, 'Unapproved')).status, 403)
    const approved = await connect(id, undefined, true, true)
    assert.ok(approved.scope.split(' ').includes('players:manage'))
    assert.equal((await create(approved, 'Approved')).status, 201)
    const oldRefresh = await f.request('/oauth/token', {}, { client_id: id, grant_type: 'refresh_token', refresh_token: previous.refresh_token })
    assert.equal(oldRefresh.status, 200)
    assert.equal((await create(await oldRefresh.json(), 'Old grant')).status, 403)
  }
  const declined = await connect(dcrId, 'play players:manage', false, true)
  assert.equal(declined.scope, 'play')
  const explicit = await connect(dcrId, 'play players:manage', true, true)
  assert.equal(explicit.scope, 'play players:manage')
  assert.equal((await create(explicit, 'Explicit consent')).status, 201)
  for (const narrowId of [await register('play'), narrowMetadataId]) {
    const narrow = await connect(narrowId, undefined, true, false)
    assert.equal(narrow.scope, 'play')
    assert.equal((await create(narrow, 'Not registered')).status, 403)
    const denied = await f.request(authPath({ client_id: narrowId, redirect_uri: destination, scope: 'play players:manage' }), owner)
    assert.equal(denied.status, 303)
    assert.equal(new URL(denied.headers.get('location')).searchParams.get('error'), 'invalid_scope')
  }
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

test('[PM-AC-20] a live OAuth connection renews its 365-day term from rotation while access lasts 15 minutes', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await f.login('Alice')
  const bob = await f.login('Bob')
  const db = new pg.Client({ connectionString: databaseUrl, options: '-c search_path=' + f.schema })
  await db.connect()
  t.after(() => db.end())

  const approval = await f.request('/oauth/authorize', alice, {
    request: await consent(f, alice, { scope: 'play library' }), decision: 'allow',
  })
  assert.equal(approval.status, 303)
  const code = new URL(approval.headers.get('Location')).searchParams.get('code')
  const issue = { grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirect, code_verifier: verifier, code, resource }
  const refresh = refreshToken => ({ grant_type: 'refresh_token', client_id: clientId, resource, refresh_token: refreshToken })

  async function exchange(form) {
    const before = Date.now()
    const reply = await f.request('/oauth/token', {}, form)
    const after = Date.now()
    assert.equal(reply.status, 200)
    const tokens = await reply.json()
    assert.equal(tokens.expires_in, 15 * 60)
    assert.equal(tokens.scope, 'play library')
    const verification = await f.request('/internal/verify', { Authorization: 'Bearer ' + tokens.access_token })
    assert.equal(verification.status, 200)
    const identity = await verification.json()
    const { rows: [expiry] } = await db.query(`
      SELECT c.expires_at AS connection_expires, max(a.expires_at) AS access_expires
      FROM oauth_connections c JOIN oauth_access_tokens a ON a.connection_id = c.id
      WHERE c.id = $1 GROUP BY c.id`, [identity.connectionId])
    for (const [name, milliseconds] of [['connection_expires', 365 * 24 * 60 * 60 * 1000], ['access_expires', 15 * 60 * 1000]]) {
      const issuedAt = expiry[name].getTime() - milliseconds
      assert.ok(before <= issuedAt && issuedAt <= after, name + ' must be based on this exchange')
    }
    return { tokens, identity }
  }

  const original = await exchange(issue)
  // A live connection created under the former policy keeps its authorization on the next rotation.
  await db.query("UPDATE oauth_connections SET expires_at = now() + interval '30 days' WHERE id = $1", [original.identity.connectionId])
  assert.equal((await f.request('/oauth/connections', bob, { connection: original.identity.connectionId })).status, 404)
  const renewed = await exchange(refresh(original.tokens.refresh_token))
  for (const field of ['connectionId', 'accountId', 'engineName', 'scopes']) {
    assert.deepEqual(renewed.identity[field], original.identity[field])
  }
  assert.ok(renewed.tokens.refresh_token !== original.tokens.refresh_token, 'Rotation replaces the credential')
  assert.equal((await f.request('/oauth/token', {}, refresh(original.tokens.refresh_token))).status, 400)
  assert.equal((await f.request('/oauth/connections', alice, { connection: renewed.identity.connectionId })).status, 303)
  assert.equal((await f.request('/oauth/token', {}, refresh(renewed.tokens.refresh_token))).status, 400)
  assert.equal((await f.request('/internal/verify', { Authorization: 'Bearer ' + renewed.tokens.access_token })).status, 401)
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
    assert.ok(authorization.searchParams.get('scope').split(' ').includes('players:manage'), 'SDK requests scopes advertised by the protected resource')
    assert.equal(first.scope.split(' ').includes('players:manage'), false, 'Authorizing play without checking management must not grant it')
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

  async function approval(headers, profile, scope = 'play library history chat') {
    const consentPage = await f.request(authPath({scope}), headers)
    const request = /name="request" value="([a-f0-9-]{36})"/.exec(await consentPage.text())?.[1]
    assert.ok(request)
    return f.request('/oauth/authorize', headers, {request, playerId:profile.playerId, decision:'allow'})
  }
  async function connect(profile, scope) {
    const approved = await approval(owner, profile, scope)
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
  const pending = randomUUID()
  const changeOne = (operation,tableId) => reserve(pilot,one.playerId,operation,pending,tableId)
  assert.equal((await changeOne('reserve')).status,200)
  assert.equal((await changeOne('cancel')).status,200)
  assert.equal((await changeOne('cancel')).status,200)
  assert.equal((await changeOne('begin')).status,409)
  assert.equal((await changeOne('reserve')).status,200)
  assert.equal((await changeOne('begin')).status,200)
  assert.equal((await changeOne('cancel')).status,409)
  const waiting = randomUUID()
  assert.equal((await changeOne('bind',waiting)).status,200)
  const waitingInvite = {tableId:waiting,roomId:randomUUID(),format:'Pioneer',password:'fixture-only-code',guestEngineName:two.engineName}
  assert.equal((await write('/api/playtesting/invites',pilot,waitingInvite)).status,201)
  assert.equal((await changeOne('cancel',waiting)).status,409)
  assert.equal((await changeOne('lock_cancel',waiting)).status,200)
  assert.equal((await changeOne('lock_cancel',waiting)).status,200)
  const freezing = await (await f.request('/internal/verify',pilot)).json()
  assert.equal(freezing.reservationStarted,true)
  assert.equal(freezing.reservationCancelPending,true)
  const paired = randomUUID()
  assert.equal((await reserve(second,two.playerId,'reserve',paired)).status,200)
  assert.equal((await reserve(second,two.playerId,'bind',paired,waiting)).status,200)
  assert.equal((await write('/api/playtesting/invites/'+waiting+'/claim',second,{})).status,404)
  assert.equal((await reserve(second,two.playerId,'release',paired)).status,200)
  assert.equal((await changeOne('cancel',waiting)).status,200)
  assert.equal((await changeOne('cancel',waiting)).status,200)
  assert.equal((await f.request('/api/playtesting/invites/'+waiting,second)).status,404)
  const taken = randomUUID()
  assert.equal((await changeOne('reserve')).status,200)
  assert.equal((await changeOne('bind',taken)).status,200)
  assert.equal((await write('/api/playtesting/invites',pilot,{...waitingInvite,tableId:taken})).status,201)
  assert.equal((await reserve(second,two.playerId,'reserve',paired)).status,200)
  assert.equal((await reserve(second,two.playerId,'bind',paired,taken)).status,200)
  assert.equal((await write('/api/playtesting/invites/'+taken+'/claim',second,{})).status,200)
  assert.equal((await changeOne('lock_cancel',taken)).status,409)
  assert.equal((await changeOne('release')).status,409)
  const finish = async tableId => {
    const fixtureDb = new pg.Client({connectionString:databaseUrl,options:'-c search_path='+f.schema})
    await fixtureDb.connect()
    const matchId = randomUUID()
    try {
      await fixtureDb.query("INSERT INTO matches(id,table_id,wins_needed,started_at,status) VALUES($1,$2,2,$3,'active')",[matchId,tableId,Date.now()])
    } finally {
      await fixtureDb.end()
    }
    return async () => {
      await writeFile(join(f.replayDirectory,matchId+'.match.json'), JSON.stringify({matchId,endedAt:Date.now()}))
      await f.product.archiveGames()
    }
  }
  const completeTaken = await finish(taken)
  await completeTaken()
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
  const legacy = new pg.Client({connectionString:databaseUrl,options:'-c search_path='+f.schema})
  await legacy.connect()
  try {
    await legacy.query(`INSERT INTO invitations(table_id,room_id,format,creator_key,table_password,expires_at,mode)
      VALUES($1,$2,'Pioneer','legacy-fixture','fixture',now()+interval '1 hour','mcp')`,[tableA, randomUUID()])
  } finally {
    await legacy.end()
  }
  const genericInvite = '/api/playtesting/invites/'+tableA
  assert.equal((await f.request(genericInvite,pilot)).status,404)
  assert.equal((await write(genericInvite+'/claim',pilot,{})).status,404)
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
  const readOnly = await connect(one,'library')
  assert.equal((await (await f.request('/internal/verify',readOnly)).json()).ownsReservation,false)
  const renewed = await connect(one)
  const rebound = await (await f.request('/internal/verify',renewed)).json()
  assert.equal(rebound.reservationId,claims[0])
  assert.equal(rebound.activeTableId,restored)
  assert.notEqual(rebound.connectionId,before.connectionId)
  assert.equal(rebound.displayName,'Renamed')
  assert.equal(rebound.flag,'US')
  const completeRestored = await finish(tableA)
  assert.equal((await reserve(renewed,one.playerId,'lock_cancel',claims[0],restored)).status,409)
  await completeRestored()
  assert.equal((await (await f.request('/internal/verify',second)).json()).activeTableId,null)
  assert.equal((await (await f.request('/internal/verify',pilots[2])).json()).activeTableId,tableB)
  assert.equal((await (await f.request('/internal/verify',renewed)).json()).activeTableId,null)
})

test('owners manage pilot profiles from their browser connections page', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await f.login('Alice')
  const bob = await f.login('Bob')
  const path = '/oauth/connections?view=players'
  assert.match(await (await f.request('/oauth/connections', alice)).text(), /href="\/oauth\/connections\?view=players"/)
  const settings = { displayName: 'Piloto local', flag: 'cl', mcpEnabled: 'on', action: 'create' }
  assert.equal((await f.request(path, { ...alice, Origin: 'https://foreign.example' }, settings)).status, 403)
  assert.equal((await f.request(path, alice, settings)).status, 303)
  const page = await (await f.request(path, alice)).text()
  assert.match(page, /🇨🇱/)
  const playerId = page.match(/name="playerId" value="([a-f0-9-]{36})"/)?.[1]
  assert.ok(playerId)
  const update = { action: 'update', playerId, displayName: 'Luna <2>', flag: '' }
  assert.equal((await f.request(path, bob, update)).status, 404)
  assert.equal((await f.request(path, alice, update)).status, 303)
  const saved = await (await f.request(path, alice)).text()
  assert.match(saved, /Luna &lt;2&gt;/)
  assert.doesNotMatch(saved, /🇨🇱| checked/)
})

test('one canonical OAuth connection selects only enabled account players and keeps their leases and recovery separate', {skip:!databaseUrl}, async t => {
  const f = await fixture(t)
  const owner = await f.login('Team')
  const otherOwner = await f.login('Other')
  const api = '/api/playtesting/players'
  const json = (path,headers,body,method='POST') => f.request(path,{...headers,'Content-Type':'application/json'},body,method)
  const make = async (headers,displayName,mcpEnabled) => {
    const created = await json(api,headers,{displayName,mcpEnabled})
    assert.equal(created.status,201)
    return (await created.json()).playerId
  }
  const authorize = (scope,playerId) => authorizePilot(f,owner,scope,playerId)
  const shared = await authorize('play library chat history')
  const verify = async headers => (await f.request('/internal/verify',headers)).json()
  assert.equal((await verify(shared)).playerSelectionEnabled,undefined)
  const ids = []
  for (const name of ['Alpha','Beta','Gamma','Delta']) ids.push(await make(owner,name,true))
  const disabled = await make(owner,'Disabled',false)
  const other = await make(otherOwner,'Other',true)
  const select = (id,headers=shared) => ({...headers,'X-Playmat-Player-Id':id})
  const list = async headers => (await (await f.request(api,headers)).json()).players.map(p=>p.playerId).sort()
  const base = await verify(shared)
  assert.equal(base.playerSelectionEnabled,true)
  assert.deepEqual(await list(shared),[...ids].sort())
  assert.equal((await json(api,shared,{displayName:'Unauthorized'})).status,403)
  for (const id of [disabled,other,randomUUID(),'bad']) assert.equal((await f.request('/internal/verify',select(id))).status,403)
  const fixed = await authorize('play library',ids[1])
  assert.equal((await f.request('/internal/verify',select(ids[0],fixed))).status,403)
  assert.deepEqual(await list(select(ids[1],fixed)),[ids[1]])
  const limited = await authorize('library')
  assert.equal((await f.request(api,limited)).status,403)
  assert.equal((await f.request('/internal/verify',select(ids[0],limited))).status,403)
  const manual = await f.product.provisionAgent('Team','TeamLegacy',['play','chat'])
  for (const headers of [owner,{Authorization:'Bearer '+manual}]) {
    assert.equal((await f.request('/internal/verify',select(ids[0],headers))).status,403)
  }
  assert.equal((await f.request('/internal/verify?scope=play',{...select(ids[0]),'X-Playmat-Client-IP':'192.0.2.1'})).status,403)
  const tables=[randomUUID(),randomUUID()], leases=ids.map(()=>randomUUID())
  const change = (selector,playerId,operation,reservationId,tableId) => json('/internal/player-reservations/'+playerId,select(selector),{operation,reservationId,tableId})
  const actors=await Promise.all(ids.map(id=>verify(select(id))))
  assert.equal(new Set(actors.map(a=>a.recoverySeatId)).size,4)
  for (let i=0;i<ids.length;i++) {
    const a=actors[i], id=ids[i]
    assert.equal(a.playerId,id)
    assert.equal(a.connectionId,base.connectionId)
    assert.equal(a.accountAgent,undefined)
    assert.equal(a.playerSelectionEnabled,undefined)
    assert.deepEqual(a.scopes.sort(),['chat','library','play'])
    assert.equal((await change(id,id,'reserve',leases[i])).status,200)
    assert.equal((await change(id,id,'bind',leases[i],tables[i>>1])).status,200)
    assert.deepEqual(await list(select(id)),[id])
  }
  const playOnly = await authorize('play')
  assert.deepEqual((await verify(select(ids[0],playOnly))).scopes,['play'])
  assert.equal((await f.request('/api/playtesting/decks',select(ids[0],playOnly))).status,403)
  assert.equal((await change(ids[0],ids[1],'release',leases[1])).status,403)
  assert.equal((await change(ids[0],ids[0],'release',leases[1])).status,409)
  assert.equal((await f.request('/api/playtesting/matches',select(ids[0]))).status,403)
  assert.equal((await f.request('/api/playtesting/decks?library=personal',select(ids[0]))).status,403)
  assert.equal((await f.request('/api/playtesting/human-seat/'+tables[0],select(ids[0]))).status,403)
  const validate = a => json('/internal/recovery/validate',{}, {accountId:a.accountId,seatId:a.recoverySeatId,connectionId:a.connectionId})
  for (const a of actors) assert.equal((await validate(a)).status,200)
  const replacement = randomUUID()
  assert.equal((await json('/internal/human-seat/restore',{}, {originalTableId:tables[0],tableId:replacement})).status,200)
  assert.equal((await verify(select(ids[0]))).activeTableId,replacement)
  assert.equal((await verify(select(ids[2]))).activeTableId,tables[1])
  assert.equal((await json(api+'/'+ids[0],owner,{mcpEnabled:false},'PATCH')).status,200)
  assert.equal((await f.request('/internal/verify',select(ids[0]))).status,403)
  assert.equal((await validate(actors[0])).status,403)
  assert.equal((await validate(actors[1])).status,200)
  assert.equal((await verify(select(ids[1]))).reservationId,leases[1])
  assert.equal((await list(shared)).length,3)
  assert.equal((await verify(shared)).engineName,base.engineName)
  const eventParams = {name:'game.decision.required',delivery:{mode:'webhook',url:'https://mcp-events-fixture.example/callback',secret:'whsec_'+Buffer.alloc(32,49).toString('base64')}}
  const subscription = async id => (await json('/internal/mcp-events/subscribe',select(id),eventParams)).json()
  const firstSub = await subscription(ids[1]), secondSub = await subscription(ids[2])
  assert.ok(firstSub.id && secondSub.id)
  assert.notEqual(firstSub.id,secondSub.id)
  assert.equal((await json('/internal/mcp-events/subscribe',select(ids[0]),eventParams)).status,403)
  assert.equal((await f.request('/oauth/revoke',{}, {client_id:clientId,token:shared.Authorization.slice(7)})).status,200)
  assert.equal((await f.request('/internal/verify',select(ids[1]))).status,401)
  assert.equal((await validate(actors[1])).status,403)
  const renewed = await authorize('play')
  const recovered = await verify(select(ids[1],renewed))
  assert.equal(recovered.reservationId,leases[1])
  assert.equal(recovered.activeTableId,replacement)
  assert.equal((await validate(recovered)).status,200)
  assert.equal((await f.request('/internal/verify',select(ids[0],renewed))).status,403)
})

test('account history can read a completed profile BO3 score without opening its live hand or a foreign series', {skip:!databaseUrl}, async t => {
  const f = await fixture(t)
  const owner = await f.login('ScoreOwner')
  const outsider = await f.login('OtherOwner')
  const make = async (headers,displayName) => {
    const created = await f.request('/api/playtesting/players',{...headers,'Content-Type':'application/json'},{displayName,mcpEnabled:true})
    assert.equal(created.status,201)
    return created.json()
  }
  const home = await make(owner,'Home')
  const away = await make(owner,'Away')
  const history = await authorizePilot(f,owner,'history')
  const foreign = await authorizePilot(f,outsider,'history')
  const fixed = await authorizePilot(f,owner,'play history',home.playerId)
  const playOnly = await authorizePilot(f,owner,'play')
  const match = randomUUID(), table = randomUUID(), now = Date.now()
  const endpoint = '/api/playtesting/matches', matchPath = endpoint+'/'+match
  const games = []
  const winners = [home.engineName,away.engineName,home.engineName]
  for (const [i,winner] of winners.entries()) {
    const game = randomUUID()
    games.push(game)
    await writeFile(join(f.replayDirectory,game+'.json'),JSON.stringify({
      gameId:game,gameNumber:i+1,matchId:match,tableId:table,winsNeeded:2,deckType:'Constructed - Pioneer',
      startedAt:now+i*10,endedAt:now+i*10+1,result:'Game finished',winner,
      players:[home,away].map(p=>({name:p.engineName,human:true})),
    }))
    await writeFile(join(f.replayDirectory,game+'.ndjson.gz'),gzipSync(JSON.stringify({
      t:1,view:{turn:1},hands:{[home.engineName]:['fixture private home'],[away.engineName]:['fixture private away']},
    })))
  }
  await f.product.archiveGames()
  const ids = async headers => (await (await f.request(endpoint,headers)).json()).matches.map(m=>m.id)
  assert.deepEqual(await ids(history),[])
  assert.equal((await f.request(matchPath,history)).status,404)
  const replay = '/api/playtesting/replays/'+games[0]
  assert.equal((await f.request(replay,history)).status,404)
  await writeFile(join(f.replayDirectory,match+'.match.json'),JSON.stringify({matchId:match,endedAt:now+32,winner:home.engineName}))
  await f.product.archiveGames()
  assert.deepEqual(await ids(owner),[match])
  assert.deepEqual(await ids(history),[match])
  const result = await f.request(matchPath,history)
  assert.equal(result.status,200)
  const score = await result.json()
  assert.equal(score.winner,home.engineName)
  assert.equal(score.status,'completed')
  assert.deepEqual(score.games.map(g=>g.winner),winners)
  assert.ok(score.games.every(game => !game.replayAvailable))
  assert.equal(JSON.stringify(score).includes('fixture private'),false)
  assert.deepEqual(await ids(foreign),[])
  assert.equal((await f.request(matchPath,foreign)).status,404)
  for (const headers of [fixed,playOnly]) assert.equal((await f.request(matchPath,headers)).status,403)
  assert.equal((await f.request(replay,foreign)).status,404)
})

test('browser history replay serves the retained human or owned profile seat and detects a missing archive', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const owner = await f.login('ReplayOwner')
  const rival = await f.login('HumanRival')
  const outsider = await f.login('Unrelated')
  const canonical = await authorizePilot(f, owner, 'history')
  const profile = async displayName => {
    const response = await f.request('/api/playtesting/players', { ...owner, 'Content-Type': 'application/json' }, { displayName, mcpEnabled: true })
    assert.equal(response.status, 201)
    return (await response.json()).engineName
  }
  const seats = [await profile('First'), await profile('Second')]
  async function record(names) {
    const gameId = randomUUID(), matchId = randomUUID(), tableId = randomUUID(), now = Date.now()
    const players = names.map((name, index) => ({ name, human: true, playerId: randomUUID(), life: 9 + index }))
    await writeFile(join(f.replayDirectory, gameId + '.json'), JSON.stringify({
      gameId, matchId, tableId, gameNumber: 1, startedAt: now, endedAt: now + 2, winner: names[0], players,
    }))
    await writeFile(join(f.replayDirectory, gameId + '.ndjson.gz'), gzipSync(JSON.stringify({ t: 1, view: { turn: 9, players } })))
    await writeFile(join(f.replayDirectory, matchId + '.match.json'), JSON.stringify({ matchId, endedAt: now + 3, winner: names[0] }))
    await f.product.archiveGames()
    return { matchId, replay: '/api/playtesting/replays/' + gameId + '?start=0&count=40' }
  }
  for (const { players, viewer, rivalStatus } of [
    { players: seats, viewer: seats[0], rivalStatus: 404 },
    { players: ['ReplayOwner', 'HumanRival'], viewer: 'ReplayOwner', rivalStatus: 200 },
  ]) {
    const { matchId, replay } = await record(players)
    const listed = await (await f.request('/api/playtesting/matches/' + matchId, owner)).json()
    assert.equal(listed.games[0].replayAvailable, true)
    const response = await f.request(replay, owner)
    assert.equal(response.status, 200)
    const page = await response.json()
    assert.equal(page.info.viewerName, listed.games[0].viewerName)
    assert.equal(page.info.viewerName, viewer.toLowerCase())
    assert.deepEqual([page.events[0].view.turn, ...page.events[0].view.players.map(player => player.life)], [9, 9, 10])
    assert.equal((await f.request(replay, outsider)).status, 404)
    assert.equal((await f.request(replay, rival)).status, rivalStatus)
    if (players === seats) assert.equal((await f.request(replay, canonical)).status, 404)
    f.store.clear()
    assert.equal((await f.request(replay, owner)).status, 503)
  }
})

test('two MCP seats automatically publish one owner-discoverable board from invitation through the archived final', {skip:!databaseUrl}, async t => {
  const tableId = randomUUID(), replacement = randomUUID()
  const engine = new Map()
  const f = await fixture(t,[],undefined,async id => engine.get(id) ?? null)
  const owner = await f.login('BroadcastHost')
  const peer = await f.login('BroadcastGuest')
  const write = (path,headers,body) => f.request(path,{...headers,'Content-Type':'application/json'},body)
  const make = async (cookie,displayName) => (await (await write('/api/playtesting/players',cookie,{displayName,mcpEnabled:true})).json())
  const host = await make(owner,'Public host'), guest=await make(peer,'Public guest')
  const pilot = await authorizePilot(f,owner,'play',host.playerId)
  const lease=randomUUID()
  const change = (operation,id) => write('/internal/player-reservations/'+host.playerId,pilot,{operation,reservationId:lease,tableId:id})
  assert.equal((await change('reserve')).status,200)
  assert.equal((await change('bind',tableId)).status,200)
  const invite = {tableId,roomId:randomUUID(),format:'Pioneer',tableName:'Broadcast fixture',password:'synthetic-fixture',guestEngineName:guest.engineName}
  const created=await write('/api/playtesting/invites',pilot,invite)
  assert.equal(created.status,201)
  const links='/api/playtesting/tables/spectator-links', route='/api/playtesting/tables/'+tableId+'/spectator-link'
  const listing=await f.request(links,owner)
  assert.equal(listing.status,200)
  const {tables}=await listing.json()
  assert.deepEqual(tables,[{tableId,tableName:'Broadcast fixture',canConfigureSpectatorVisibility:true}])
  assert.equal((await write('/api/playtesting/invites',pilot,invite)).status,201)
  const listingPeer=await (await f.request(links,peer)).json()
  assert.deepEqual(listingPeer.tables,[])
  assert.equal((await f.request(links,pilot)).status,403)
  const share=await f.request(route,owner)
  assert.equal(share.status,200)
  const {path}=await share.json()
  assert.ok(path.startsWith('/watch/'))
  assert.equal((await (await f.request(route,owner,null,'POST')).json()).path,path)
  assert.equal((await f.request(route,peer)).status,403)
  assert.equal((await f.request(route,peer,null,'POST')).status,403)
  assert.equal((await f.request(route,pilot)).status,403)
  assert.ok(!(await created.text()).includes(path.slice(7)))
  const playerList=await f.request('/api/playtesting/players',pilot)
  assert.ok(!(await playerList.text()).includes(path.slice(7)))
  const publicPath=path.replace('/watch/','/api/playtesting/spectate/')
  const waiting=await (await f.request(publicPath)).json()
  assert.equal(waiting.status,'waiting')
  assert.deepEqual(waiting.hands,{})
  const gameId=randomUUID(), playerA=randomUUID(), playerB=randomUUID()
  const players=[{playerId:playerA,name:host.engineName},{playerId:playerB,name:guest.engineName}]
  const fixtureHands={[playerA]:{x:{name:'SENTINEL_PRIVATE'}}}
  const frame={role:'spectator',status:'playing',revision:1,tableId:replacement,gameId,players,
    view:{turn:2,players:players.map(p=>({...p,life:18,myHand:fixtureHands,handCount:3})),private:'SENTINEL_PRIVATE'},
    hands:fixtureHands,lines:[{reasoning:'SENTINEL_PRIVATE'}],chat:[{message:'SENTINEL_PRIVATE'}]}
  engine.set(tableId,{owner:guest.engineName,snapshot:frame})
  await sleep(720)
  assert.equal((await f.request(publicPath)).status,404)
  engine.set(replacement,{owner:host.engineName,snapshot:frame})
  assert.equal((await write('/internal/human-seat/restore',{}, {originalTableId:tableId,tableId:replacement})).status,200)
  await sleep(720)
  const assertBoard = data => {
    assert.equal(data.gameId,gameId)
    assert.equal(data.players.length,2)
    assert.deepEqual(data.hands,{})
    assert.deepEqual(data.lines,[])
    assert.deepEqual(data.chat,[])
    assert.ok(!JSON.stringify(data).includes('SENTINEL_PRIVATE'))
  }
  assertBoard(await (await f.request(publicPath)).json())
  const stream=await fetch(f.endpoint+publicPath+'/events',{signal:AbortSignal.timeout(5000)})
  const reader=stream.body.getReader()
  let text=''
  try {
    while (!/data: [^\n]+\n\n/.test(text)) text+=new TextDecoder().decode((await reader.read()).value)
  } finally { await reader.cancel() }
  assertBoard(JSON.parse(/data: ([^\n]+)/.exec(text)[1]))
  engine.set(replacement,{owner:host.engineName,snapshot:{...frame,status:'between_games',revision:2}})
  await sleep(720)
  assert.equal((await (await f.request(publicPath)).json()).status,'between_games')
  assert.equal((await (await f.request(route,owner)).json()).path,path)
  const now=Date.now(), matchId=randomUUID()
  await writeFile(join(f.replayDirectory,gameId+'.json'),JSON.stringify({gameId,gameNumber:3,matchId,tableId:replacement,
    winsNeeded:2,deckType:'Constructed - Pioneer',startedAt:now-100,endedAt:now,result:'Game finished',winner:host.engineName,
    players:players.map(p=>({...p,human:true}))}))
  await writeFile(join(f.replayDirectory,gameId+'.ndjson.gz'),gzipSync([JSON.stringify({t:1,view:frame.view,hands:fixtureHands}),
    JSON.stringify({t:2,kind:'spectatorEnd',players,hands:fixtureHands})].join('\n')))
  await writeFile(join(f.replayDirectory,matchId+'.match.json'),JSON.stringify({matchId,endedAt:now,winner:host.engineName}))
  await f.product.archiveGames()
  engine.clear()
  await sleep(720)
  const archived=await (await f.request(publicPath)).json()
  assertBoard(archived)
  assert.equal(archived.status,'finished')
  assert.deepEqual((await (await f.request(links,owner)).json()).tables,[])
  assert.equal((await (await f.request(route,owner)).json()).path,path)
  const restarted=await createProduct({databaseUrl,schema:f.schema,replayDirectory:f.replayDirectory,store:f.store,
    publicUrl:issuer,insecureCookie:true,readSpectatorEngine:async()=>null})
  try {
    restarted.server.listen(0,'127.0.0.1')
    await once(restarted.server,'listening')
    const endpoint='http://127.0.0.1:'+restarted.server.address().port
    const final=await (await fetch(endpoint+publicPath)).json()
    assertBoard(final)
    assert.equal(final.status,'finished')
  } finally {
    restarted.server.close()
    restarted.server.closeAllConnections()
    await restarted.close()
  }
})

test('automatic spectator links require a trusted creation with two MCP seats', {skip:!databaseUrl}, async t=>{
  const f=await fixture(t,[],undefined,async()=>null)
  const owner=await f.login('LegacyHost'), peer=await f.login('LegacyPeer')
  const host=await f.product.provisionAgent('LegacyHost','LegacyPilot',['play'])
  await f.product.provisionAgent('LegacyPeer','GuestPilot',['play'])
  const agent={Authorization:'Bearer '+host}
  const create=async(headers,guestEngineName)=>{
    const tableId=randomUUID()
    const response=await f.request('/api/playtesting/invites',{...headers,'Content-Type':'application/json'},{
      tableId,roomId:randomUUID(),format:'Pioneer',password:'fixture-password',guestEngineName,
    })
    assert.equal(response.status,201)
    return '/api/playtesting/tables/'+tableId+'/spectator-link'
  }
  const direct=await create({...agent,'X-Playmat-Client-IP':'192.0.2.1'},'GuestPilot')
  const humanGuest=await create(agent,'LegacyPeer')
  const humanHost=await create(owner,'GuestPilot')
  for (const path of [direct,humanGuest,humanHost]) assert.equal((await f.request(path,owner)).status,403)
  const supported=await create(agent,'GuestPilot')
  assert.equal((await f.request(supported,owner)).status,200)
  assert.equal((await f.request(supported,peer)).status,403)
})

test('owners create persistent slots by explicit consent and assign foreign invitations to exactly one authorized slot', {skip:!databaseUrl}, async t=>{
  const f=await fixture(t), a=await f.login('HostAccount'), b=await f.login('GuestAccount')
  const write=(path,headers,data,method='POST')=>f.request(path,{...headers,'Content-Type':'application/json'},data,method)
  const sharedA=await authorizePilot(f,a,'play'), sharedB=await authorizePilot(f,b,'play')
  const slots='/api/playtesting/player-slots', profiles='/api/playtesting/players', invites='/api/playtesting/invites'
  const request={requestId:randomUUID(),displayName:'Guest',flag:'CL'}
  assert.equal((await write(slots,sharedB,request)).status,403)
  const optional=await f.request(authPath(),b)
  assert.match(await optional.text(),/type="checkbox" name="manageSlots" value="yes"/)
  const limited=await f.request(authPath({scope:'play'}),b)
  assert.doesNotMatch(await limited.text(),/name="manageSlots"/)
  const forged=await authorizePilot(f,b,'play',undefined,true)
  assert.equal((await write(slots,forged,request)).status,403)
  const manager=await authorizePilot(f,b,undefined,undefined,true)
  const optedIn=await authorizePilot(f,b,'play players:manage',undefined,true)
  assert.ok((await (await f.request('/internal/verify',optedIn)).json()).scopes.includes('players:manage'))
  const writes=await Promise.all([write(slots,manager,request),write(slots,manager,request)])
  for (const r of writes) assert.ok([200,201].includes(r.status))
  const [guest,retry]=await Promise.all(writes.map(r=>r.json()))
  assert.equal(guest.playerId,retry.playerId)
  assert.equal(guest.availability,'available')
  assert.equal((await write(slots,manager,{...request,displayName:'different'})).status,409)
  const fixed=await authorizePilot(f,b,'play players:manage',guest.playerId,true)
  assert.equal((await write(slots,fixed,{...request,requestId:randomUUID()})).status,403)
  assert.equal((await write(slots,sharedB,{...request,requestId:randomUUID()})).status,403)
  const slot=async (cookies,displayName)=>(await (await write(profiles,cookies,{displayName,mcpEnabled:true})).json())
  const host=await slot(a,'Host'), sibling=await slot(b,'Sibling')
  const select=(headers,p)=>({...headers,'X-Playmat-Player-Id':p.playerId})
  const recipient=select(sharedB,guest), other=select(sharedB,sibling), inviter=select(sharedA,host)
  const list=async(headers,query='')=>(await (await f.request(profiles+query,headers)).json()).players
  assert.deepEqual((await list(sharedA)).map(p=>p.playerId),[host.playerId])
  const change=(headers,p,op,lease,tableId)=>write('/internal/player-reservations/'+p.playerId,headers,{operation:op,reservationId:lease,tableId})
  const bind=async(headers,p,tableId)=>{
    const lease=randomUUID()
    assert.equal((await change(headers,p,'reserve',lease)).status,200)
    assert.equal((await change(headers,p,'bind',lease,tableId)).status,200)
    return lease
  }
  const lease=randomUUID(), table=randomUUID()
  assert.equal((await change(recipient,guest,'reserve',lease)).status,200)
  assert.equal((await list(sharedB)).find(p=>p.playerId===guest.playerId).availability,'reserved')
  assert.deepEqual((await list(sharedB,'?availableOnly=true')).map(p=>p.playerId),[sibling.playerId])
  assert.equal((await list(sharedB)).find(p=>p.playerId===guest.playerId).reservationId,undefined)
  assert.equal((await change(recipient,guest,'cancel',lease)).status,200)
  const create=(headers,tableId,target)=>write(invites,headers,{tableId,roomId:randomUUID(),format:'Pioneer',password:'fixture-invite-pass',...target})
  const exact=randomUUID(), target={guestPlayerId:guest.playerId}
  assert.equal((await create(a,exact,{mode:'mcp',...target})).status,201)
  assert.equal((await f.request(invites+'/'+exact,other)).status,404)
  await bind(recipient,guest,exact)
  const pending=randomUUID()
  assert.equal((await change(other,sibling,'reserve',pending)).status,200)
  assert.deepEqual(await list(sharedB,'?availableOnly=true'),[])
  const inbox=(await (await f.request(invites,sharedB)).json()).invites
  assert.deepEqual((await (await f.request(invites+'?tableId='+randomUUID(),sharedB)).json()).invites,[])
  assert.equal((await (await f.request(invites+'?tableId='+exact,other)).json()).invites.length,0)
  const item=inbox.find(i=>i.tableId===exact)
  assert.equal(item?.guestPlayerId,guest.playerId)
  assert.equal(item.format,'Pioneer')
  assert.equal(item.claimed,false)
  assert.equal((await f.request(invites+'/'+exact,sharedB)).status,200)
  assert.equal((await change(other,sibling,'cancel',pending)).status,200)
  assert.equal((await write(invites+'/'+exact+'/claim',recipient,{})).status,200)
  const admission='/internal/invites/'+exact+'?host=HostAccount&guest='+guest.engineName
  assert.equal((await f.request(admission)).status,200)
  assert.equal((await write(profiles+'/'+guest.playerId,b,{mcpEnabled:false},'PATCH')).status,200)
  assert.equal((await f.request(admission)).status,404)
  assert.equal((await create(a,randomUUID(),target)).status,400)
  assert.equal((await write(profiles+'/'+guest.playerId,b,{mcpEnabled:true},'PATCH')).status,200)
  const attacker=await slot(a,'Unrelated')
  await bind(inviter,host,table)
  assert.equal((await create(inviter,table,{guestAccountName:'GuestAccount'})).status,201)
  const member=await slot(b,'Alternate'), alternate=select(sharedB,member)
  const getInvites=async h=>(await (await f.request(invites,h)).json()).invites
  const accountInvite=(await getInvites(sharedB)).find(i=>i.tableId===table)
  assert.equal(accountInvite.guestAccountName,'GuestAccount')
  assert.equal(accountInvite.requiresPlayerAssignment,true)
  assert.equal(accountInvite.guestPlayerId,undefined)
  assert.ok(!(await getInvites(select(sharedA,attacker))).some(i=>i.tableId===table))
  assert.equal((await f.request(invites+'/'+table,fixed)).status,401)
  const freshFixed=await authorizePilot(f,b,'play',member.playerId)
  assert.equal((await f.request(invites+'/'+table,freshFixed)).status,404)
  assert.equal((await write(invites+'/'+table+'/claim',sharedB,{})).status,404)
  const firstLease=await bind(other,sibling,table), secondLease=await bind(alternate,member,table)
  const claimed=await Promise.all([write(invites+'/'+table+'/claim',other,{}),write(invites+'/'+table+'/claim',alternate,{})])
  assert.deepEqual(claimed.map(r=>r.status).sort(),[200,404])
  const firstWins=claimed[0].status===200
  const winner=firstWins?sibling:member, winnerHeaders=firstWins?other:alternate
  assert.equal((await write(invites+'/'+table+'/claim',winnerHeaders,{})).status,200)
  assert.equal((await change(firstWins?alternate:other,firstWins?member:sibling,'release',firstWins?secondLease:firstLease)).status,200)
  assert.equal((await f.request('/internal/invites/'+table+'?host='+host.engineName+'&guest='+winner.engineName)).status,200)
  assert.equal((await list(sharedB)).find(p=>p.playerId===winner.playerId).availability,'occupied')
  assert.equal((await f.request('/api/playtesting/tables/'+table+'/spectator-link',a)).status,200)
  const foreign=await create(a,randomUUID(),{guestPlayerId:randomUUID()})
  assert.equal(foreign.status,400)
  assert.equal((await create(a,randomUUID(),{guestPlayerId:guest.playerId,guestAccountName:'GuestAccount'})).status,400)
})

test('[PM-SPECTATE-SEATS] opt-in is immutable, authorized per guest and capability, and ends before archives', {skip:!databaseUrl}, async t=>{
  const frames=new Map(), f=await fixture(t,[],undefined,async id=>frames.get(id)??null)
  const owner=await f.login('PrivateHost'), peer=await f.login('PrivatePeer')
  const post=(path,headers,body)=>f.request(path,{...headers,'Content-Type':'application/json'},body)
  const make=async (headers,displayName)=>(await post('/api/playtesting/players',headers,{displayName,mcpEnabled:true})).json()
  const host=await make(owner,'Hosting'), guest=await make(peer,'Visiting')
  const hostGrant=await authorizePilot(f,owner,'play',host.playerId), guestGrant=await authorizePilot(f,peer,'play',guest.playerId)
  const tableId=randomUUID(), lease=async (seat,grant)=>{
    const reservationId=randomUUID(), route='/internal/player-reservations/'+seat.playerId
    assert.equal((await post(route,grant,{operation:'reserve',reservationId})).status,200)
    assert.equal((await post(route,grant,{operation:'bind',tableId,reservationId})).status,200)
  }
  await lease(host,hostGrant); await lease(guest,guestGrant)
  const input={tableId,roomId:randomUUID(),format:'Pioneer',password:'fictional-passphrase',guestPlayerId:guest.playerId,spectatorVisibility:'both-hands'}
  const invites='/api/playtesting/invites', privateLink='/api/playtesting/tables/'+tableId+'/spectator-link?visibility=both-hands'
  const created=await post(invites,hostGrant,input)
  assert.equal(created.status,201)
  assert.equal((await created.json()).spectatorVisibility,'both-hands')
  assert.equal((await post(invites,hostGrant,{...input,spectatorVisibility:'public-board'})).status,409)
  const invitation=await (await f.request(invites+'/'+tableId,guestGrant)).json()
  assert.equal(invitation.requiresSpectatorAcceptance,true)
  assert.equal((await post(invites+'/'+tableId+'/claim',guestGrant,{})).status,403)
  assert.equal((await f.request(privateLink,peer)).status,403)
  assert.equal((await f.request(privateLink,hostGrant)).status,403)
  assert.equal((await f.request(privateLink,owner)).status,200)
  const paths=await Promise.all([privateLink,privateLink.split('?')[0]].map(async route=>{
    const {path}=await (await f.request(route,owner)).json()
    return path.replace('/watch/','/api/playtesting/spectate/')
  }))
  assert.ok(paths[0]!==paths[1], 'Capabilities have separate entitlements')
  assert.equal((await post(invites+'/'+tableId+'/claim',guestGrant,{acceptSpectatorVisibility:'both-hands'})).status,200)
  const gameId=randomUUID(), a=randomUUID(), b=randomUUID(), x=randomUUID(), y=randomUUID(), peek=randomUUID()
  const players=[{playerId:a,name:host.engineName},{playerId:b,name:guest.engineName}]
  const message='Prueba &amp; β\n'.padEnd(500,'x')
  const talk={type:'TALK',messageId:gameId+':1',playerName:host.engineName,at:1,message}
  const frame={role:'spectator',gameId,tableId,revision:4,status:'playing',players,view:{turn:1,players},hands:{
    [a]:{[x]:{id:x,name:'Fixture Hand A',original:{name:'FORBIDDEN'}}},[b]:{[y]:{id:y,name:'Fixture Hand B'}},
    [randomUUID()]:{[x]:{name:'FORBIDDEN'}}},seatKnowledge:{[a]:{lookedAt:[{cards:{[peek]:{id:peek,name:'Fixture Seen'}}}],
    library:['FORBIDDEN'],decision:{prompt:'FORBIDDEN'}}},chat:[talk,{...talk,type:'WHISPER_FROM',message:'FORBIDDEN'},{...talk,playerName:'Elsewhere',message:'FORBIDDEN'},
    {...talk,messageId:randomUUID()+':1',message:'FORBIDDEN'}],lines:[{reasoning:'FORBIDDEN'}]}
  frames.set(tableId,{owner:host.engineName,snapshot:frame})
  const read=async path=>(await f.request(path)).json()
  await sleep(720)
  const verifyPrivate=data=>{
    assert.equal(data.visibility,'both-hands')
    assert.equal(data.hands[a][x].name,'Fixture Hand A')
    assert.equal(data.hands[b][y].name,'Fixture Hand B')
    assert.equal(data.seatKnowledge[a].lookedAt[0].cards[peek].name,'Fixture Seen')
    assert.deepEqual(data.chat.map(row=>row.message),[message])
    assert.ok(!JSON.stringify(data).includes('FORBIDDEN'))
  }
  verifyPrivate(await read(paths[0]))
  const pub=await read(paths[1]+'?visibility=both-hands')
  assert.equal(pub.visibility,'public-board');assert.deepEqual(pub.hands,{});assert.ok(!pub.seatKnowledge)
  assert.equal((await f.request(paths[0],guestGrant)).status,403)
  assert.equal((await f.request('/api/playtesting/tables/'+randomUUID()+'/spectator-link?visibility=both-hands',owner)).status,404)
  const stream=await fetch(f.endpoint+paths[0]+'/events',{signal:AbortSignal.timeout(7000)})
  const reader=stream.body.getReader();let line=''
  while(!line.includes('data: ')) line+=new TextDecoder().decode((await reader.read()).value)
  verifyPrivate(JSON.parse(/data: ([^\n]+)/.exec(line)[1]));await reader.cancel()
  frames.set(tableId,{owner:host.engineName,snapshot:{...frame,tableId:randomUUID()}})
  await sleep(720);assert.equal((await f.request(paths[0])).status,404)
  frames.set(tableId,{owner:host.engineName,snapshot:{...frame,status:'finished'}})
  const closed={role:'spectator',visibility:'closed',status:'finished',publicPath:paths[1].replace('/api/playtesting/spectate/','/watch/')}
  const assertClosed=data=>{
    assert.deepEqual(Object.keys(data).sort(),Object.keys(closed).sort())
    for(const key of Object.keys(closed))assert.ok(data[key]===closed[key],key+' matches this table')
  }
  assertClosed(await read(paths[0]))
  const finalStream=await fetch(f.endpoint+paths[0]+'/events',{signal:AbortSignal.timeout(5000)})
  assertClosed(JSON.parse(/data: ([^\n]+)/.exec(await finalStream.text())[1]))
  const matchId=randomUUID(), now=Date.now()
  await writeFile(join(f.replayDirectory,gameId+'.json'),JSON.stringify({gameId,gameNumber:1,matchId,tableId,
    winsNeeded:1,deckType:'Constructed - Pioneer',startedAt:now-100,endedAt:now,result:'Game finished',winner:host.engineName,
    players:players.map(p=>({...p,human:true}))}))
  await writeFile(join(f.replayDirectory,gameId+'.ndjson.gz'),gzipSync(JSON.stringify({t:1,view:frame.view,hands:frame.hands})))
  await writeFile(join(f.replayDirectory,matchId+'.match.json'),JSON.stringify({matchId,endedAt:now,winner:host.engineName}))
  await f.product.archiveGames()
  frames.clear()
  assertClosed(await read(paths[0]))
  assert.equal((await f.request(paths[0]+'/replay')).status,404)
  await sleep(720)
  const archived=await read(paths[1])
  assert.equal(archived.visibility,'public-board')
  assert.equal(archived.status,'finished')
  assert.deepEqual(archived.hands,{})
  assert.ok(!JSON.stringify(archived).includes('Fixture Hand'))
})

test('[PM-SPECTATE-SETUP] the browser host can change both-hands sharing only before a guest reserves or claims', {skip:!databaseUrl}, async t=>{
  const f=await fixture(t,[],undefined,async()=>null), owner=await f.login('SetupHost'), peer=await f.login('SetupPeer')
  const post=(path,headers,data,method='POST')=>f.request(path,{...headers,'Content-Type':'application/json'},data,method)
  const base='/api/playtesting'
  const hp=await f.product.provisionAgent('SetupHost','SetupHostPilot',['play'])
  const guest=await (await post(base+'/players',peer,{displayName:'Setup Guest',mcpEnabled:true})).json()
  const gp=await authorizePilot(f,peer,'play',guest.playerId)
  const host={Authorization:'Bearer '+hp}
  const setup=async recipient=>{
    const tableId=randomUUID(), req={tableId,roomId:randomUUID(),format:'Pioneer',password:'fixture-setup-only',...recipient}
    assert.equal((await post(base+'/invites',host,req)).status,201)
    return tableId
  }
  const route=id=>base+'/tables/'+id+'/spectator-link'
  const change=(id,mode,headers=owner)=>post(route(id),headers,{spectatorVisibility:mode},'PATCH')
  const table=await setup({guestPlayerId:guest.playerId}), links=base+'/tables/spectator-links'
  const discover=async id=>(await (await f.request(links,owner)).json()).tables.find(row=>row.tableId===id)
  const publicPath=(await (await f.request(route(table),owner)).json()).path
  assert.equal((await discover(table)).canConfigureSpectatorVisibility,true)
  assert.equal((await change(table,'both-hands',peer)).status,403)
  assert.equal((await change(table,'both-hands',host)).status,403)
  assert.equal((await change(table,'both-hands',{...owner,Origin:'https://unrelated.example'})).status,403)
  assert.equal((await change(table,'unknown')).status,400)
  const on=await change(table,'both-hands')
  assert.equal(on.status,200)
  assert.deepEqual(await on.json(),{tableId:table,spectatorVisibility:'both-hands'})
  const extra=route(table)+'?visibility=both-hands'
  const privatePath=(await (await f.request(extra,owner)).json()).path
  const oldStream=await fetch(f.endpoint+privatePath.replace('/watch/',base+'/spectate/')+'/events',{signal:AbortSignal.timeout(5000)})
  assert.equal(oldStream.status,200)
  assert.equal((await change(table,'public-board')).status,200)
  assert.equal((await f.request(privatePath.replace('/watch/',base+'/spectate/'))).status,404)
  assert.equal((await f.request(extra,owner)).status,404)
  assert.ok(publicPath===(await (await f.request(route(table),owner)).json()).path)
  assert.equal((await change(table,'both-hands')).status,200)
  const ended=await oldStream.text()
  assert.ok(!ended.includes('"playing"') && !ended.includes('"closed"'))
  assert.equal((await f.request(privatePath.replace('/watch/',base+'/spectate/'))).status,404)
  const before=await (await f.request(base+'/invites/'+table,gp)).json()
  assert.equal(before.requiresSpectatorAcceptance,true)
  const lease=randomUUID(),reserve=(op,fields)=>post('/internal/player-reservations/'+guest.playerId,gp,{operation:op,reservationId:lease,...fields})
  assert.equal((await reserve('reserve',{joinTableId:table})).status,200)
  assert.equal((await discover(table)).canConfigureSpectatorVisibility,undefined)
  assert.equal((await change(table,'public-board')).status,409)
  assert.equal((await reserve('bind',{tableId:table})).status,200)
  assert.equal((await post(base+'/invites/'+table+'/claim',gp,{})).status,403)
  assert.equal((await post(base+'/invites/'+table+'/claim',gp,{acceptSpectatorVisibility:'both-hands',expectedSpectatorVisibility:'public-board'})).status,409)
  assert.equal((await post(base+'/invites/'+table+'/claim',gp,{acceptSpectatorVisibility:'both-hands',expectedSpectatorVisibility:'both-hands'})).status,200)
  assert.equal((await change(table,'public-board')).status,409)
  const unassigned=await setup({guestAccountName:'SetupPeer'})
  assert.equal((await discover(unassigned)).canConfigureSpectatorVisibility,true)
  assert.equal((await change(unassigned,'both-hands')).status,200)
})
