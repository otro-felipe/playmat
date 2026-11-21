import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clientKey, createLimits, productLimitGroup } from './limits.mjs'

test('isolates sources and groups, enforces instance budget and refills', () => {
  let now = 0
  const check = createLimits({ signIn: { client: 2, total: 3, window: 60_000 }, read: { client: 4, total: 8, window: 60_000 } }, { now: () => now })
  assert.equal(check('signIn', 'alice'), 0)
  assert.equal(check('signIn', 'alice'), 0)
  assert.equal(check('signIn', 'alice'), 30)
  assert.equal(check('signIn', 'bob'), 0)
  assert.equal(check('read', 'alice'), 0)
  assert.equal(check('signIn', 'eve'), 20)
  now = 30_000
  assert.equal(check('signIn', 'alice'), 0)
})

test('bounds cardinality without evicting an exhausted active source', () => {
  let now = 0
  const check = createLimits({ activity: { client: 1, total: 100, window: 1000 } }, { maxClients: 2, now: () => now })
  assert.equal(check('activity', 'a'), 0)
  assert.equal(check('activity', 'b'), 0)
  assert.equal(check('activity', 'c'), 1)
  assert.equal(check('activity', 'a'), 1)
  now = 1000
  assert.equal(check('activity', 'c'), 0)
})

test('uses only the proxy-normalized header and groups rotating IPv6 addresses', () => {
  const key = (headers, remoteAddress = '127.0.0.1') => clientKey({ headers, socket: { remoteAddress } })
  assert.equal(key({ 'x-forwarded-for': '203.0.113.1' }), '127.0.0.1')
  assert.equal(key({ 'x-playmat-client-ip': 'invalid' }), '127.0.0.1')
  assert.equal(key({ 'x-playmat-client-ip': '::ffff:203.0.113.1' }), '203.0.113.1')
  assert.equal(key({ 'x-playmat-client-ip': '2001:0DB8:0:1::abcd' }), key({ 'x-playmat-client-ip': '2001:db8:0:1:3:4:5:6' }))
})

test('maps public entry points and expensive work to shared quotas regardless of identifier', () => {
  assert.equal(productLimitGroup('/api/playtesting/signup/request', 'POST'), 'signup')
  assert.equal(productLimitGroup('/api/playtesting/signup/complete', 'POST'), 'signup')
  assert.equal(productLimitGroup('/oauth/register', 'POST'), 'oauthRegister')
  assert.equal(productLimitGroup('/oauth/token', 'POST'), 'oauth')
  assert.equal(productLimitGroup('/api/playtesting/review/games/1/evidence', 'GET'), 'archive')
  assert.equal(productLimitGroup('/api/playtesting/exports/2', 'GET'), 'export')
  assert.equal(productLimitGroup('/api/playtesting/theory/tactics', 'POST'), 'theory')
  assert.equal(productLimitGroup('/api/playtesting/invites/other/claim', 'POST'), 'game')
  assert.equal(productLimitGroup('/internal/verify', 'GET', true, 'play'), 'socket')
  assert.equal(productLimitGroup('/internal/verify', 'GET'), undefined)
})
