import { expect, test } from 'vitest';
import { matchPerspective, type PracticeGame, type PracticeMatch } from './practiceHistory';

const players = [{ name: 'Felipe' }, { name: 'mcp_Felipe', displayName: 'Felipe', isMcp: true }];
const game: PracticeGame = { gameId: 'g1', gameNumber: 1, players, viewerName: 'mcp_felipe', winner: 'Felipe', archiveState: 'ready', replayAvailable: true };
const match: PracticeMatch = { id: 'm', name: 'test', format: 'Pioneer', status: 'completed', winner: 'mcp_Felipe', startedAt: 1,
  games: [game, { ...game, gameId: 'g2', gameNumber: 2, winner: 'mcp_Felipe' }, { ...game, gameId: 'g3', gameNumber: 3, winner: 'mcp_Felipe' }] };

test('the server-selected seat determines the opponent, result and score when both names have the same owner', () => {
  expect(matchPerspective(match, 'Felipe')).toMatchObject({ rivals: [players[0]], score: '2–1', result: 'win' });
  const humanSeat = { ...match, games: match.games.map((game) => ({ ...game, viewerName: 'felipe' })) };
  expect(matchPerspective(humanSeat, 'Felipe')).toMatchObject({ rivals: [players[1]], score: '1–2', result: 'loss' });
});

test('missing game winners leave the score unknown and match status stays independent', () => {
  expect(matchPerspective({ ...match, games: [{ ...game, winner: null }] }, 'Felipe')).toMatchObject({ score: '—', result: 'win' });
  expect(matchPerspective({ ...match, status: 'interrupted', winner: null, games: [] }, 'Felipe')).toMatchObject({ score: '—', result: 'interrupted' });
  expect(matchPerspective({ ...match, games: [{ ...game, players: null }] }, 'Felipe')).toMatchObject({ score: '—', result: 'completed' });
});
