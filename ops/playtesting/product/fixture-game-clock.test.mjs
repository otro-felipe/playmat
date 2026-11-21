import assert from 'node:assert/strict'
import test from 'node:test'
import { fixtureGameClock } from './fixture-game-clock.mjs'

test('two synthetic matches receive separate deadlines while decisions retain their shorter cap', async () => {
  let now = 0
  const clock = fixtureGameClock(() => now)
  const { hasTime, deadlineWithin } = clock
  const game = clock.forGame(async elapsed => {
    const started = now
    assert.equal(deadlineWithin(35_000), started + 35_000)
    now += elapsed
    return started
  })

  const first = await game(475_000)
  assert.equal(deadlineWithin(35_000), first + 480_000)
  assert.equal(hasTime(), true)
  now += 5_000
  assert.equal(hasTime(), false)

  const second = await game(300_000)
  assert.equal(deadlineWithin(35_000), second + 335_000)
  assert.equal(hasTime(), true)
  now += 180_000
  assert.equal(hasTime(), false)
})
