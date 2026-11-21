import assert from 'node:assert/strict'
import { test } from 'node:test'
import { waitForConcession } from './recovery-concession.mjs'

const seat = (status, id, gameId = 'recovered-game') => ({ status, gameId, decision: id ? { id } : null })

test('a concession reconciles an unverified peer response by observing both seats without resubmitting it', async () => {
  const actions = []
  const settle = waitForConcession('sideboarding', 'recovered-game', async peer => {
    actions.push(peer.decision.id)
    if (peer.decision.id === 'first') throw Object.assign(new Error('Unverified'), { code: 'operation_failed' })
    return true
  })
  const first = seat('active', 'first'), second = seat('active', 'second'), side = seat('sideboarding')
  for (const pair of [[first, first], [first, first], [second, second], [second, second], [side, seat('active', 'third')]]) {
    assert.equal(await settle(pair), false)
  }
  assert.equal(await settle([side, side]), true)
  assert.deepEqual(actions, ['first', 'second'])
})

test('a concession requires the expected status from both seats and propagates unrelated peer errors', async () => {
  const settle = waitForConcession('match_over', 'recovered-game', async () => { throw new Error('Transport unavailable') })
  const own = seat('active')
  assert.equal(await settle([own, seat('sideboarding')]), false)
  assert.equal(await settle([own, seat('active', 'new', 'other-game')]), false)
  await assert.rejects(settle([own, seat('active', 'current')]), /Transport unavailable/)
})
