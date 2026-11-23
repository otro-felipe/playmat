import assert from 'node:assert/strict'
import test from 'node:test'
import { attendanceStructureRanges } from './tournament-preview.mjs'
import { tournamentStructure } from './tournament-rules.mjs'

test('each preview range predicts the exact Swiss and playoff structure that will be used at that attendance', () => {
  assert.ok(attendanceStructureRanges.length <= 16)
  for (let attendance = 2; attendance <= 512; attendance++) {
    const range = attendanceStructureRanges.find(({ upTo }) => attendance <= upTo)
    assert.equal(range.roundsOnly,tournamentStructure({template:'attendance',cut:'none'},attendance).swissRounds)
    assert.deepEqual({swissRounds:range.swissRounds,cutSize:range.cutSize}, tournamentStructure({template:'attendance',cut:'auto'},attendance))
  }
})
