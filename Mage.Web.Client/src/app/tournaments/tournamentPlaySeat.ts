// sessionStorage belongs to the game tab; the organizer's independent tab has no game seat.
const key = 'playmat.tournamentPlaySeat';
interface PlaySeat {
  tournamentId: string;
  entryId: string;
  username: string;
}
export function tournamentPlaySeat(): PlaySeat | null {
  try {
    const seat = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    return seat &&
      typeof seat.tournamentId === 'string' &&
      typeof seat.entryId === 'string' &&
      typeof seat.username === 'string'
      ? seat
      : null;
  } catch {
    return null;
  }
}
export function rememberTournamentPlaySeat(seat: PlaySeat) {
  sessionStorage.setItem(key, JSON.stringify(seat));
}
export function clearTournamentPlaySeat() {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* storage can be disabled */
  }
}
