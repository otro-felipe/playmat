import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFixtureMcpFetch } from './fixture-mcp-fetch.mjs'

const url = new URL('http://127.0.0.1:8080/mcp')
const action = { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call' }) }
const limited = (code = -32029, retryAfter = '2') =>
  Response.json({ jsonrpc: '2.0', error: { code } }, { status: 429, headers: { 'retry-after': retryAfter } })

test('two confirmed pre-dispatch rejections wait for the server before delivering a mutation exactly once', async () => {
  const attempts = []
  const pauses = []
  const request = createFixtureMcpFetch(async (input, options) => {
    attempts.push([input, options])
    return attempts.length <= 2 ? limited() : new Response('accepted')
  }, async ms => pauses.push(ms))
  assert.equal(await (await request(url, action)).text(), 'accepted')
  assert.deepEqual(pauses, [2000, 2000])
  assert.deepEqual(attempts, [[url, action], [url, action], [url, action]])
})

test('ambiguous failures, different 429s and bodies that cannot be replayed are returned without retry', async () => {
  const wait = () => assert.fail('Unexpected replay')
  for (const [response, init] of [
    [limited(-32000), action], [limited(-32029, 'unexpected'), action],
    [limited(), { method: 'POST', body: new ReadableStream() }],
    [new Response('', { status: 503 }), action],
    [Response.json({ jsonrpc: '2.0', error: { code: -32029 } }), action],
  ]) {
    assert.equal(await createFixtureMcpFetch(async () => response, wait)(url, init), response)
  }
  const disconnected = new Error('connection lost after dispatch')
  await assert.rejects(createFixtureMcpFetch(async () => { throw disconnected }, wait)(url, action), disconnected)
})

test('persistent throttling is bounded', async () => {
  let requests = 0
  const request = createFixtureMcpFetch(async () => { requests++; return limited() }, async () => {})
  assert.equal((await request(url, action)).status, 429)
  assert.ok(requests > 1 && requests <= 10)
})
