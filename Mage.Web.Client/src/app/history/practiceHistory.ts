import type { ReviewSummary } from '../replay/reviewData';

export interface PracticePlayer {
  name: string;
  displayName?: string | null;
  isMcp?: boolean;
  seatId?: string;
  model?: string | null;
  reasoningEffort?: string | null;
}

export interface PracticeGame {
  gameId: string;
  gameNumber: number;
  endedAt?: number;
  archiveState: 'ready' | 'pending' | 'partial';
  replayAvailable: boolean;
  viewerName?: string | null;
  winner?: string | null;
  startPlayer?: string | null;
  turns?: number | null;
  ownMulligans?: number | null;
  players: PracticePlayer[] | null;
  analysis?: ReviewSummary;
}

export interface PracticeMatch {
  id: string;
  name: string;
  format: string;
  status: 'active' | 'completed' | 'interrupted';
  winner?: string | null;
  startedAt: number;
  games: PracticeGame[];
  analysis?: ReviewSummary;
}

export interface PracticeHistoryPage {
  matches: PracticeMatch[];
  cursor: string | null;
}

export function findSeat(game: PracticeGame, name: string | null | undefined) {
  return name ? game.players?.find((player) => player.name.toLowerCase() === name.toLowerCase()) : undefined;
}

export function matchPerspective(match: PracticeMatch, account: string) {
  const game = match.games.find((game) => game.players?.length);
  const viewer = game && findSeat(game, game.viewerName ?? account);
  const rivals = game?.players?.filter((player) => player !== viewer) ?? [];
  const winner = game && findSeat(game, match.winner);
  const result: PracticeMatch['status'] | 'win' | 'loss' = match.status === 'completed' && viewer && winner
    ? winner === viewer ? 'win' : 'loss'
    : match.status;
  // Two-player scores require an identified seat and a recorded winner in every game.
  const completeScore = viewer && rivals.length === 1 && match.games.every((game) =>
    !!findSeat(game, game.winner) && !!findSeat(game, viewer.name) && !!findSeat(game, rivals[0].name) && game.players?.length === 2);
  const wins = completeScore ? match.games.filter((game) => game.winner?.toLowerCase() === viewer.name.toLowerCase()).length : 0;
  return { viewer, rivals, result, score: completeScore ? `${wins}–${match.games.length - wins}` : '—' };
}
