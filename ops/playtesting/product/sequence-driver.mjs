// Fixture-only boundary: the peer must never drive a game beyond the plan's asserted destination.
export function mayDriveRival(state, boundary) {
  if (!boundary) return true;
  return state.gameId === boundary.gameId && state.turn === boundary.turn
    && state.activePlayerId === boundary.activePlayerId && state.step !== 'END_TURN';
}

export async function drivePlanPeerOnce({ readStatus, readPeer, respondPeer, boundary }) {
  const status = await readStatus();
  // Reading status before responding avoids one extra peer pass after the sequence completed.
  if (status.status === 'running' && mayDriveRival(readPeer(), boundary)) await respondPeer(boundary);
  return status;
}
