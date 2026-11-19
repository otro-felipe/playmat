import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { useSession } from '../stores/session';
import { HistoryScreen } from './HistoryScreen';

vi.mock('../playtesting', () => ({ PRIVATE_PLAYTESTING: true }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('[PM-REVIEW-UI-3] the history shows persisted analysis and separates seat and game counts', async () => {
  useSession.setState({ userName: 'Alice', phase: 'signedIn' });
  const analysis = {
    status: 'partial', reviewed: 3, eligible: 8, counts: { good: 2, inaccuracy: 1 },
    bySeat: [{ seatId: 'alice', name: 'Alice', reviewed: 2, counts: { good: 2 } }, { seatId: 'bob', name: 'Bob', reviewed: 1, counts: { inaccuracy: 1 } }],
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/stats')
    ? { groups: [] }
    : { matches: [{
      id: 'match', name: 'Pioneer practice', format: 'Pioneer', status: 'completed', startedAt: 1, analysis,
      games: [{ gameId: 'game', gameNumber: 3, archiveState: 'ready', replayAvailable: true, players: [{ name: 'Alice' }, { name: 'Bob' }], analysis }],
    }], cursor: null }))));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><MemoryRouter><HistoryScreen /></MemoryRouter></QueryClientProvider>);
  const heading = await screen.findByText('Partial analysis');
  expect(heading).toBeTruthy();
  expect(screen.getByText('3 of 8 plays reviewed')).toBeTruthy();
  fireEvent.click(screen.getByText('Ratings by player and game'));
  const game = screen.getByRole('group', { name: 'Juego 3' });
  expect(within(game).getByText('Alice')).toBeTruthy();
  expect(within(game).getByText('Bob')).toBeTruthy();
  expect(within(game).getByText('Good')).toBeTruthy();
  expect(within(game).getByText('Inaccuracy')).toBeTruthy();
});
