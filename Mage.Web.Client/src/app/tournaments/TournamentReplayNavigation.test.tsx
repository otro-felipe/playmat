import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { TournamentReplay } from './TournamentBroadcast';

vi.mock('../spectator/SpectatorScreen', () => ({
  ProjectedBoard: ({ frame }: { frame: { gameId: string; revision: number } }) =>
    <article aria-label="Game board">{frame.gameId} frame {frame.revision}</article>,
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('keeps the board mounted while seeking and clears it when switching games', async () => {
  let deliver!: (value: Response) => void;
  const snapshot = (gameId: string, revision: number) => Response.json({ gameId, revision, view: {} });
  vi.stubGlobal('fetch', (input: string) => {
    const url = new URL(input, 'https://test.invalid');
    if (!url.search) return Promise.resolve(Response.json({
      games: ['first','second'].map(gameId => ({ gameId, frameCount: 5 })),
    }));
    if (url.searchParams.get('gameId') === 'first' && url.searchParams.get('frame') === '0')
      return Promise.resolve(snapshot('first', 0));
    return new Promise<Response>(resolve => { deliver = resolve; });
  });
  const page = render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/t/e/r/p']}>
    <Routes><Route path="/t/:id/r/:pairingId" element={<TournamentReplay/>}/></Routes>
  </MemoryRouter></QueryClientProvider>);
  const board = await page.findByRole('article', { name: 'Game board' });
  fireEvent.change(page.getByRole('slider'), { target: { value: '3' } });
  expect(page.queryByRole('article')).toBe(board);
  deliver(snapshot('first', 3));
  expect(await page.findByText('first frame 3')).toBe(board);
  fireEvent.change(page.getByRole('combobox'), { target: { value: '1' } });
  expect(page.queryByRole('article')).toBeNull();
  deliver(snapshot('second', 0));
  expect(await page.findByText('second frame 0')).toBeTruthy();
});
