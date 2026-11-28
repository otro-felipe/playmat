import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { TournamentReplay } from './TournamentBroadcast';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('[CUP-AC-007] shows official AFK and the last recorded board in replay information', async () => {
  const officialResult = { a:'Alpha', b:'Beta', winsA:1, winsB:0, draws:0, winner:'a', reason:'afk' };
  const capture = { exportState:'ready', terminalEvent:false, outcome:'a', cause:null,
    lastBoard:{frame:0,status:'playing',turn:7,step:'PRECOMBAT_MAIN'} };
  vi.stubGlobal('fetch', vi.fn(async (input: string) => Response.json(input.includes('?gameId=')
    ? { status:'playing' }
    : { officialResult, games:[{gameId:'game',gameNumber:1,frameCount:1,capture}] })));
  const screen = render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/t/e/r/p']}>
    <Routes><Route path="/t/:id/r/:pairingId" element={<TournamentReplay/>}/></Routes>
  </MemoryRouter></QueryClientProvider>);
  expect(await screen.findByRole('heading', { name: 'Alpha 1–0 Beta' })).toBeTruthy();
  expect(screen.queryByText(/disqualification for inactivity/i)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Replay information' }));
  const dialog = within(await screen.findByRole('dialog'));
  expect(dialog.getByText(/disqualification for inactivity/i)).toBeTruthy();
  expect(dialog.getByText(/turn 7/i)).toBeTruthy();
  expect(dialog.getByText(/no terminal game event/i)).toBeTruthy();
  expect(dialog.queryByText(/disconnect|concession|clock expired/i)).toBeNull();
});

it('switches between a recorded ending and the third game of an officially drawn match', async () => {
  const officialResult = { a:'Alpha', b:'Beta', winsA:1, winsB:1, draws:1, winner:null, reason:'played' };
  const games = [
    {gameId:'one',gameNumber:1,frameCount:1,capture:{exportState:'ready',terminalEvent:true,cause:'concession',
      outcome:'a',lastBoard:{frame:0,status:'finished',turn:4,step:'UPKEEP'}}},
    {gameId:'three',gameNumber:3,frameCount:1,capture:{exportState:'ready',terminalEvent:false,cause:null,
      outcome:'draw',lastBoard:{frame:0,status:'playing',turn:15,step:'CLEANUP'}}},
  ];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => Response.json(input.includes('?gameId=')
    ? { status:'playing' } : { officialResult,games })));
  const screen = render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/t/e/r/p']}>
    <Routes><Route path="/t/:id/r/:pairingId" element={<TournamentReplay/>}/></Routes>
  </MemoryRouter></QueryClientProvider>);
  expect(await screen.findByRole('heading', { name: 'Alpha 1–1 Beta' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Replay information' }));
  const first = within(await screen.findByRole('dialog'));
  expect(first.getByText(/Game-ending event recorded/i)).toBeTruthy();
  fireEvent.click(first.getByRole('button', { name: 'Close' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Game' }),{target:{value:'three'}});
  fireEvent.click(screen.getByRole('button', { name: 'Replay information' }));
  // Every game of the table is listed; the one on screen is marked as current.
  const dialog = within(await screen.findByRole('dialog'));
  expect(dialog.getByText(/Concession/)).toBeTruthy();
  const third = within(dialog.getByRole('button', { name: 'Game 3', current: true }).closest('li')!);
  expect(third.getByText(/Game drawn/i)).toBeTruthy();
  expect(third.getByText(/turn 15/i)).toBeTruthy();
  expect(third.getByText(/Cleanup/)).toBeTruthy();
  expect(third.getByText(/partial replay/i)).toBeTruthy();
  expect(third.queryByText(/concession/i)).toBeNull();
});

it.each([
  { entryIds: ['a', 'b'], isAdmin: false, status: 200, showsReason: true },
  { entryIds: ['a', 'b'], isAdmin: false, status: 403, showsReason: false },
  { entryIds: ['a', 'b'], isAdmin: false, status: 503, showsReason: false },
  { entryIds: ['a'], isAdmin: true, status: 200, showsReason: false },
])('[PM-REVIEW-API-13] opening replay information asks only for the selected game when both entries are owned (%j)', async ({ entryIds, isAdmin, status, showsReason }) => {
  const officialResult = { a: 'Alpha', b: 'Beta', winsA: 1, winsB: 1, draws: 0, winner: null, reason: 'played' };
  const capture = { exportState: 'ready', terminalEvent: true, outcome: 'a' };
  const games = [
    { gameId: 'first', gameNumber: 1, frameCount: 1, capture, goodQuality: true, qualityReason: 'Public archive reason' },
    { gameId: 'second', gameNumber: 2, frameCount: 1, capture, goodQuality: false, qualityReason: 'Another public archive reason' },
  ];
  let finishUnavailable: (response: Response) => void = () => {};
  const pendingUnavailable = new Promise<Response>(resolve => { finishUnavailable = resolve; });
  const fetcher = vi.fn(async (input: string) => {
    if (input.startsWith('/api/playtesting/review/')) return status !== 200
      ? pendingUnavailable : Response.json({ gameId: 'second', qualityReason: '- Authorized archive reason' });
    if (input === '/api/playtesting/tournaments/e') return Response.json({ participants: [], pairings: [{ id: 'p', a: 'a', b: 'b', completed: true }], viewer: { accountName: 'Owner', entryIds, isAdmin } });
    if (input.includes('?gameId=')) return Response.json({ status: 'playing' });
    return Response.json({ officialResult, games });
  });
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 2000 } } });
  if (status !== 200) client.setQueryData(['tournament-game-quality-reason', 'Owner', 'second'], 'Previously authorized reason');
  const screen = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/t/e/r/p?game=2']}>
    <Routes><Route path="/t/:id/r/:pairingId" element={<TournamentReplay />} /></Routes>
  </MemoryRouter></QueryClientProvider>);
  await screen.findByRole('heading', { name: 'Alpha 1–1 Beta' });
  const reviewCalls = () => fetcher.mock.calls.map(([url]) => url).filter(url => url.startsWith('/api/playtesting/review/'));
  expect(reviewCalls()).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Replay information' }));
  const dialog = within(await screen.findByRole('dialog'));
  expect(dialog.getByText("Doesn't qualify")).toBeTruthy();
  expect(dialog.queryByText(/public archive reason/i)).toBeNull();
  if (entryIds.length === 2) await waitFor(() => expect(reviewCalls()).toEqual(['/api/playtesting/review/games/second?archiveOnly=true']));
  else expect(reviewCalls()).toEqual([]);
  if (status !== 200) {
    expect(dialog.queryByText('Previously authorized reason')).toBeNull();
    finishUnavailable(Response.json({}, { status }));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(dialog.queryByText('Previously authorized reason')).toBeNull();
  }
  if (showsReason) expect((await dialog.findByText('Authorized archive reason')).tagName).toBe('LI');
  else expect(dialog.queryByText('Authorized archive reason')).toBeNull();
});
