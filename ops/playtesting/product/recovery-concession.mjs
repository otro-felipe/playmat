// The game thread can accept a concession while the peer's last response is in
// flight. Only a fresh observation from both seats confirms the phase change.
export function waitForConcession(expectedStatus, gameId, advancePeer) {
  const submitted = new Set()
  return async ([human, peer]) => {
    if (human.status === expectedStatus && peer.status === expectedStatus) return true
    if (human.status === expectedStatus || peer.status !== 'active' || peer.gameId !== gameId) return false
    const decisionId = peer.decision?.id
    if (!decisionId || submitted.has(decisionId)) return false
    try {
      if (await advancePeer(peer)) submitted.add(decisionId)
    } catch (error) {
      if (error.code !== 'operation_failed') throw error
      submitted.add(decisionId)
    }
    return false
  }
}
