import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configuredSeatCapacity } from '../src/player-seats.mjs'

test('an installation can size the MCP seat pool for a tournament while preserving the 64-seat default', () => {
  assert.equal(configuredSeatCapacity(),64)
  assert.equal(configuredSeatCapacity('128'),128)
  assert.equal(configuredSeatCapacity('512'),512)
  for(const invalid of ['0','-1','1.2','abc','Infinity','9007199254740992']) {
    assert.throws(()=>configuredSeatCapacity(invalid),/positive integer/)
  }
})
