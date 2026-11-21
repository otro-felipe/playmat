import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractPerformanceEvidence } from './performance-evidence.mjs'

test('historical opening hand needs a keep followed by an unchanged pre-draw hand from the viewer', () => {
  const seat = { engine_name: 'Alice', engine_key: 'alice', player_id: 'alice-id' }
  const log = (message) => ({ log: { messageType: 'GAME', message } })
  const keep = log('<font>Alice</font> keeps hand')
  const frame = {
    view: { turn: 1, step: 'UPKEEP', players: [{ name: 'Alice' }, { name: 'Bob', graveyard: {} }] },
    hands: { Alice: { a: { name: 'Keep' }, b: { name: 'Keep' } }, Bob: { c: { name: 'Opponent private' } } },
  }
  const read = (events) => extractPerformanceEvidence(events, seat).opening
  assert.deepEqual(read([keep, frame]), ['Keep'])
  assert.equal(read([log('Bob keeps hand'), frame]), null)
  assert.equal(read([keep, log('Alice draws a card'), frame]), null)
  assert.equal(read([keep, { ...frame, view: { ...frame.view, step: 'DRAW' } }]), null)
  assert.equal(read([keep, { ...frame, hands: { Bob: frame.hands.Bob } }]), null)
  assert.equal(read([keep, { ...frame, hands: { Alice: { c: { name: 'Hidden', hideInfo: true } } } }]), null)
})

test('public opponent observations discard a reverted branch and distinguish ownership from control', () => {
  const seat = { engine_name: 'Alice', engine_key: 'alice' }
  const frame = (turn, name) => ({
    view: {
      turn,
      players: [
        { name: 'Alice', playerId: 'alice', battlefield: { taken: { ownerId: 'bob', name: 'Borrowed rival land' } } },
        {
          name: 'Bob',
          playerId: 'bob',
          battlefield: { a: { name, ownerId: 'bob' }, token: { name: 'Goblin', ownerId: 'bob', isToken: true } },
          graveyard: { own: { name: 'Known graveyard card' } },
        },
      ],
    },
  })
  const rows = [frame(1, 'Stays'), frame(2, 'Reverted'), { kind: 'rollback', turn: 2 }, frame(2, 'Final')]
  assert.deepEqual(extractPerformanceEvidence(rows, seat).opponent.sort(), [
    'Borrowed rival land',
    'Final',
    'Known graveyard card',
    'Stays',
  ])
})
