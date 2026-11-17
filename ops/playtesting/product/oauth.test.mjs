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

const databaseUrl = process.env.PLAYMAT_TEST_DATABASE_URL
const issuer = 'https://playmat-oauth-fixture.example'
const resource = issuer + '/mcp'
const clientId = 'https://chatgpt.com/oauth/client.json'
const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect'
const state = 'synthetic-opaque-state'
const verifier = 'fixture-verifier'.padEnd(64, '0')
const challenge = createHash('sha256').update(verifier).digest('base64url')
const password = 'synthetic-browser-password'

async function fixture(t, oauthClients = []) {
  const replayDirectory = await mkdtemp(join(tmpdir(), 'playmat-oauth-'))
  const schema = 'test_' + randomUUID().replaceAll('-', '')
  const delivered = []
  const eventOptions = { deliver: async (_url, { body }) => {
    const payload = JSON.parse(body)
    if (payload.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) }
    delivered.push({ type: payload.name, tableId: payload.data.tableId })
    return { status: 204, body: '' }
  } }
  const product = await createProduct({ databaseUrl, schema, replayDirectory, store: new Map(), publicUrl: issuer, oauthClients, insecureCookie: true, eventOptions })
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
    const mime = headers['Content-Type'] ?? (method === 'PUT' ? 'application/json' : 'application/x-www-form-urlencoded')
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

async function consent(f, headers) {
  const approval = await f.request(authPath(), headers)
  assert.equal(approval.status, 200)
  const html = await approval.text()
  assert.match(html, /mazos de la cuenta/)
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
  const identity = await (await authenticate(tokens.access_token)).json()
  assert.match(identity.engineName, /^mcp_[a-f0-9]{10}$/)
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
