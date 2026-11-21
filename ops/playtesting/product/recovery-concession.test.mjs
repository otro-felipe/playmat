import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bothJoinedNextGame, waitForConcession } from './recovery-concession.mjs'

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

test('a peer decision can expire while the two clients are receiving the concession result', async () => {
  let attempts = 0
  const settle = waitForConcession('match_over', 'recovered-game', async () => {
    ++attempts
    throw Object.assign(new Error('The game closed while answering'), { code: 'not_actionable' })
  })
  const choosing = seat('active', 'last-choice'), ended = seat('match_over')
  assert.equal(await settle([choosing, choosing]), false)
  assert.equal(await settle([choosing, choosing]), false)
  assert.equal(await settle([ended, choosing]), false)
  assert.equal(await settle([ended, ended]), true)
  assert.equal(attempts, 1)
})

test('a concession requires the expected status from both seats and propagates unrelated peer errors', async () => {
  const settle = waitForConcession('match_over', 'recovered-game', async () => { throw new Error('Transport unavailable') })
  const own = seat('active')
  assert.equal(await settle([own, seat('sideboarding')]), false)
  assert.equal(await settle([own, seat('active', 'new', 'other-game')]), false)
  await assert.rejects(settle([own, seat('active', 'current')]), /Transport unavailable/)
})


test('sideboard submissions can be acknowledged before both seats join the next game', () => {
  const previous = new Set(['first-game'])
  const boarding = seat('sideboarding', null, 'first-game')
  const old = seat('active', null, 'first-game')
  const next = seat('active', 'mulligan', 'second-game')
  for (const pair of [[boarding, boarding], [boarding, next], [old, old], [old, next],
    [next, seat('active', null, null)], [next, seat('active', null, 'unrelated-game')]]) {
    assert.equal(bothJoinedNextGame(pair, previous), false)
  }
  assert.equal(bothJoinedNextGame([next, next], previous), true)
})
