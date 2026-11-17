import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
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
  const product = await createProduct({ databaseUrl, schema, replayDirectory, store: new Map(), publicUrl: issuer, oauthClients, insecureCookie: true })
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
  const request = (path, fields = {}, form) => new Promise((resolve, reject) => {
    const headers = { Host: new URL(issuer).host, ...fields }
    const payload = form && new URLSearchParams(form).toString()
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    const req = httpRequest(endpoint + path, { method: form ? 'POST' : 'GET', headers }, reply => {
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
  return { product, request, login }
}

function authPath(fields = {}) {
  return '/oauth/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirect, resource,
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'play chat', state, ...fields,
  })
}

async function consent(f, headers) {
  const approval = await f.request(authPath(), headers)
  assert.equal(approval.status, 200)
  const html = await approval.text()
  assert.match(html, /OwnDot/)
  assert.doesNotMatch(html, /AnotherDot|AnalysisOnly/)
  const request = /name="request" value="([a-f0-9-]{36})"/.exec(html)?.[1]
  assert.ok(Boolean(request), 'The browser consent request can be submitted')
  return request
}

test('[PM-AC-18] a browser session approves only its own delegated seat and exchanges a single PKCE code', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await f.login('Alice')
  const bob = await f.login('Bob')
  const originalGrant = await f.product.provisionAgent('Alice', 'OwnDot', ['play', 'chat', 'history'])
  await f.product.provisionAgent('Alice', 'AnalysisOnly', ['history'])
  await f.product.provisionAgent('Bob', 'AnotherDot', ['play', 'chat'])

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
  assert.equal((await f.request('/oauth/authorize', bob, { request, seat: 'AnotherDot', decision: 'allow' })).status, 400)
  assert.equal((await f.request('/oauth/authorize', alice, { request, seat: 'AnotherDot', decision: 'allow' })).status, 400)
  assert.equal((await f.request('/oauth/authorize', { ...alice, Origin: 'https://untrusted.example' }, { request, seat: 'OwnDot', decision: 'allow' })).status, 403)

  const approved = await f.request('/oauth/authorize', alice, { request, seat: 'OwnDot', decision: 'allow' })
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
  assert.equal(tokens.scope, 'play chat')
  assert.ok(Boolean(tokens.refresh_token) && Boolean(tokens.access_token), 'Both token types are issued')
  assert.equal((await f.request('/oauth/token', {}, exchange)).status, 400)
  assert.equal((await f.request('/oauth/authorize', alice, { request, seat: 'OwnDot', decision: 'allow' })).status, 400)

  async function authenticate(accessToken) {
    return f.request('/internal/verify', { Authorization: 'Bearer ' + accessToken })
  }
  const identity = await (await authenticate(tokens.access_token)).json()
  assert.equal(identity.engineName, 'OwnDot')
  assert.equal(identity.agent, true)
  assert.deepEqual(identity.scopes, ['play', 'chat'])
  assert.match(identity.connectionId, /^[a-f0-9-]{36}$/)

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

test('[PM-AC-18] denial returns an issuer-bound error and sign-out invalidates pending consent', { skip: !databaseUrl }, async t => {
  const f = await fixture(t)
  const alice = await f.login('Alice')
  const grant = await f.product.provisionAgent('Alice', 'OwnDot', ['play'])
  const request = await consent(f, alice)
  const denied = await f.request('/oauth/authorize', alice, { request, decision: 'deny' })
  assert.equal(denied.status, 303)
  const response = new URL(denied.headers.get('Location'))
  assert.equal(response.searchParams.get('iss'), issuer)
  assert.equal(response.searchParams.get('error'), 'access_denied')
  const next = await consent(f, alice)
  assert.equal((await f.request('/logout', alice, {})).status, 303)
  assert.equal((await f.request('/oauth/authorize', alice, { request: next, seat: 'OwnDot', decision: 'allow' })).status, 400)
  assert.equal((await f.request('/internal/verify', { Authorization: 'Bearer ' + grant })).status, 200)
})

test('[PM-AC-18] a registered OAuth client is bound to its exact callback and selected non-play scopes', { skip: !databaseUrl }, async t => {
  const client = { clientId: 'sample-mcp-client', redirectUri: 'https://mcp-client-fixture.example/connect', name: 'Sample MCP client' }
  const f = await fixture(t, [client])
  const alice = await f.login('Alice')
  await f.product.provisionAgent('Alice', 'AnalysisOnly', ['library', 'history'])
  const parameters = { client_id: client.clientId, redirect_uri: client.redirectUri, scope: 'history library' }
  assert.equal((await f.request(authPath({ ...parameters, redirect_uri: client.redirectUri + '/wrong' }), alice)).status, 400)
  const consentPage = await f.request(authPath(parameters), alice)
  assert.match(consentPage.headers.get('content-security-policy'), /form-action 'self' https:\/\/mcp-client-fixture\.example;/)
  assert.doesNotMatch(consentPage.headers.get('content-security-policy'), /chatgpt\.com/)
  const html = await consentPage.text()
  assert.match(html, /Sample MCP client/)
  assert.match(html, /AnalysisOnly/)
  const request = /name="request" value="([a-f0-9-]{36})"/.exec(html)?.[1]
  assert.ok(Boolean(request), 'Registered OAuth client offers consent')
  const approved = await f.request('/oauth/authorize', alice, { request, seat: 'AnalysisOnly', decision: 'allow' })
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
