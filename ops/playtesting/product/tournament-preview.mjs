import { tournamentStructure } from './tournament-rules.mjs'

// Adjacent attendance counts with the same two structures share one catalogue row.
function buildAttendanceRanges() {
  const ranges = []
  for (let seats = 2; seats <= 512; seats++) {
    const { swissRounds, cutSize } = tournamentStructure({ template: 'attendance', cut: 'auto' }, seats)
    const roundsOnly = tournamentStructure({ template: 'attendance', cut: 'none' }, seats).swissRounds
    const last = ranges.at(-1)
    if (last?.swissRounds === swissRounds && last.cutSize === cutSize && last.roundsOnly === roundsOnly) {
      last.upTo = seats
    } else {
      ranges.push({ upTo: seats, swissRounds, cutSize, roundsOnly })
    }
  }
  return ranges
}

export const attendanceStructureRanges = buildAttendanceRanges()
