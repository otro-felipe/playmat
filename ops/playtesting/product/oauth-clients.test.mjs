import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { metadataTransport, createClientRegistry } from './oauth-clients.mjs'
import { resolveWebhookTarget } from './mcp-events-webhook.mjs'

const id = 'https://client.example/oauth/client.json'

function transportFixture({ status = 200, body = '{}', type = 'application/json', addresses = [{ address: '8.8.8.8', family: 4 }] } = {}) {
  const calls = []
  let lookups = 0
  const fetch = metadataTransport({
    resolveTarget: value => resolveWebhookTarget(value, async () => { lookups++; return addresses }),
    request: (url, options, reply) => {
      calls.push({ url, options })
      const req = new EventEmitter()
      req.destroy = error => { req.emit('error', error); return req }
      req.end = () => queueMicrotask(() => {
        const res = new EventEmitter()
        res.statusCode = status
        res.headers = { 'content-type': type, location: 'https://internal.example/admin' }
        reply(res)
        res.emit('data', Buffer.from(body))
        res.emit('end')
      })
      return req
    },
  })
  return { fetch, calls, lookups: () => lookups }
}

test('[PM-AC-20] metadata transport pins a single public DNS result and keeps the TLS hostname', async () => {
  const f = transportFixture()
  const response = await f.fetch(id)
  assert.equal(await response.text(), '{}')
  assert.equal(f.lookups(), 1)
  assert.equal(f.calls.length, 1)
  const { url, options } = f.calls[0]
  assert.equal(url.hostname, 'client.example')
  assert.equal(url.href, id)
  assert.equal(options.agent, false)
  assert.equal(options.autoSelectFamily, false)
  assert.equal(options.family, 4)
  for (const all of [false, true]) {
    const actual = await new Promise((resolve, reject) => options.lookup('client.example', { all }, (error, address, family) => {
      if (error) reject(error)
      else resolve(all ? address : { address, family })
    }))
    assert.deepEqual(actual, all ? [{ address: '8.8.8.8', family: 4 }] : { address: '8.8.8.8', family: 4 })
  }
  assert.equal(f.lookups(), 1, 'The connection lookup cannot perform a second DNS lookup')
})

test('[PM-AC-20] metadata transport rejects private, mixed and special-use DNS answers before any connection', async () => {
  for (const [address, family] of [['127.0.0.1', 4], ['10.0.0.1', 4], ['169.254.169.254', 4], ['192.168.0.1', 4],
    ['100.64.0.1', 4], ['224.0.0.1', 4], ['::1', 6], ['fc00::1', 6], ['::ffff:127.0.0.1', 6], ['2001:db8::1', 6]]) {
    const f = transportFixture({ addresses: [{ address: '8.8.8.8', family: 4 }, { address, family }] })
    await assert.rejects(f.fetch(id), undefined, address)
    assert.equal(f.calls.length, 0, address)
  }
  for (const value of ['http://client.example/oauth.json', 'https://localhost/oauth.json', 'https://client.internal/oauth.json',
    'https://user:pass@client.example/oauth.json', 'https://127.0.0.1/oauth.json', 'https://[::1]/oauth.json',
    'https://client.example:8443/oauth.json', 'https://client.example/oauth.json?q=1', 'https://client.example/', 'https://client.example/oauth.json#hash']) {
    const f = transportFixture()
    await assert.rejects(f.fetch(value), undefined, value)
    assert.equal(f.calls.length, 0, value)
  }
})

test('[PM-AC-20] metadata transport refuses redirects, oversized bodies, wrong media types and stalled DNS', async () => {
  const redirect = transportFixture({ status: 302 })
  const registry = createClientRegistry({ query: async () => ({ rows: [] }) }, 'https://issuer.example', [], { fetch: redirect.fetch })
  assert.equal(await registry.get(id), undefined)
  assert.equal(redirect.calls.length, 1, 'The Location URL is never fetched')
  await assert.rejects(transportFixture({ body: 'x'.repeat(32769) }).fetch(id))
  await assert.rejects(transportFixture({ type: 'text/html' }).fetch(id))
  const stalled = metadataTransport({ resolveTarget: () => new Promise(() => {}) })
  const controller = new AbortController()
  const pending = stalled(id, { signal: controller.signal })
  controller.abort(new Error('fixture deadline'))
  await assert.rejects(pending, /fixture deadline/)
})
