import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { TournamentReplay } from './TournamentBroadcast';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows official AFK and last recorded board even if no terminal event was exported', async () => {
  const officialResult = { a:'Alpha', b:'Beta', winsA:1, winsB:0, draws:0, winner:'a', reason:'afk' };
  const capture = { exportState:'ready', terminalEvent:false, outcome:'a', cause:null,
    lastBoard:{frame:0,status:'playing',turn:7,step:'PRECOMBAT_MAIN'} };
  vi.stubGlobal('fetch', vi.fn(async (input: string) => Response.json(input.includes('?gameId=')
    ? { status:'playing' }
    : { officialResult, games:[{gameId:'game',gameNumber:1,frameCount:1,capture}] })));
  const screen = render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/t/e/r/p']}>
    <Routes><Route path="/t/:id/r/:pairingId" element={<TournamentReplay/>}/></Routes>
  </MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText(/Alpha 1–0 Beta/)).toBeTruthy();
  expect(screen.getByText(/disqualification for inactivity/i)).toBeTruthy();
  expect(screen.getByText(/turn 7/i)).toBeTruthy();
  expect(screen.getByText(/no terminal game event/i)).toBeTruthy();
  expect(screen.queryByText(/disconnect|concession|clock expired/i)).toBeNull();
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
  expect(await screen.findByText(/Game-ending event recorded/i)).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'1'}});
  expect(screen.getByText(/Alpha 1–1 Beta/)).toBeTruthy();
  expect(screen.getByText(/Game drawn/i)).toBeTruthy();
  expect(screen.getByText(/turn 15/i)).toBeTruthy();
  expect(screen.getByText(/Cleanup/)).toBeTruthy();
  expect(screen.getByText(/partial replay/i)).toBeTruthy();
  expect(screen.queryByText(/concession/i)).toBeNull();
});
