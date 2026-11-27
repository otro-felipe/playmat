import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
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
  const third = within(await screen.findByRole('dialog'));
  expect(third.getByText(/Game drawn/i)).toBeTruthy();
  expect(third.getByText(/turn 15/i)).toBeTruthy();
  expect(third.getByText(/Cleanup/)).toBeTruthy();
  expect(third.getByText(/partial replay/i)).toBeTruthy();
  expect(third.queryByText(/concession/i)).toBeNull();
});
