import { createHash } from 'node:crypto'

export const publicExplanationLimit = 4000

export function lineText(row, allowLegacy = false) {
  if (!row) return null
  if (row.audience === 'public' && typeof row.explanation === 'string') {
    const explanation = row.explanation.trim()
    if (explanation && explanation.length <= publicExplanationLimit * 2 && [...explanation].length <= publicExplanationLimit) return { audience: 'public', explanation }
  }
  if (allowLegacy && typeof row.reasoning === 'string' && row.reasoning.trim() && row.reasoning.length <= 600) {
    return { reasoning: row.reasoning }
  }
  return null
}

// Command IDs are supplied by clients and may contain arbitrary text. Public viewers
// need a stable identity across snapshots and restarts, not the command itself.
export function publicLineId(lineId) {
  return createHash('sha256').update(lineId).digest('hex')
}

export function publicLineExplanations(lines, roster, gameId) {
  const seen = new Set(), result = []
  for (const row of Array.isArray(lines) ? lines : []) {
    const note = lineText(row)
    const player = roster.get(row?.playerId)
    if (!note || !player || !Number.isSafeInteger(row.at) || typeof row.lineId !== 'string'
      || !row.lineId.startsWith(gameId + ':' + player.playerId + ':') || seen.has(row.lineId)) continue
    seen.add(row.lineId)
    result.push({ lineId: publicLineId(row.lineId), playerId: player.playerId, playerName: player.name,
      at: row.at, turn: Number.isSafeInteger(row.turn) ? row.turn : null, ...note })
  }
  return result.slice(-100)
}
