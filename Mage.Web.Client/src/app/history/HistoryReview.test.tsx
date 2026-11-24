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
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/performance')
    ? { groups: [], decks: [], summary: { matches: { total: 0 }, games: { total: 0 } } }
    : { matches: [{
      id: 'match', name: 'Pioneer practice', format: 'Pioneer', status: 'completed', startedAt: 1, analysis,
      games: [{ gameId: 'game', gameNumber: 3, archiveState: 'ready', replayAvailable: true, players: [{ name: 'Alice', archetype: 'Golgari Midrange' }, { name: 'Bob', archetype: 'Izzet Phoenix' }], analysis }],
    }], cursor: null }))));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><MemoryRouter><HistoryScreen /></MemoryRouter></QueryClientProvider>);
  const toggle = await screen.findByRole('button', { name: /Bob/ });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(within(toggle).getByText('Golgari Midrange')).toBeTruthy();
  expect(within(toggle).getByText('Izzet Phoenix')).toBeTruthy();
  fireEvent.click(toggle);
  const heading = await screen.findByText('Partial analysis');
  expect(heading).toBeTruthy();
  expect(screen.getByText('3 of 8 plays reviewed')).toBeTruthy();
  fireEvent.click(screen.getByText('Ratings by player and game'));
  const game = screen.getByRole('group', { name: 'Game 3' });
  expect(within(game).getByText('Alice')).toBeTruthy();
  expect(within(game).getByText('Bob')).toBeTruthy();
  expect(within(game).getByText('Normal')).toBeTruthy();
  expect(within(game).getByText('Inaccuracy')).toBeTruthy();
});

test('[PM-MCP-PLAYER-VIEW-MODEL] shows archived provider and model for an MCP opponent', async () => {
  useSession.setState({ userName: 'Alice', phase: 'signedIn' });
  const rival = { name: 'mcp_archived', displayName: 'Luna', isMcp: true, provider: 'gemini', model: 'gemini-pro', reasoningEffort: 'high' };
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes('/performance')) return Response.json({ groups: [], decks: [] });
    if (url.includes('/player-identities')) return Response.json({ players: [{ name: rival.name, displayName: 'Current Luna', isMcp: true, provider: 'claude', model: 'claude-opus-5-5' }] });
    return Response.json({ matches: [{
      id: 'match', name: 'Practice', format: 'Pioneer', status: 'completed', startedAt: 1,
      games: [{ gameId: 'game', gameNumber: 1, archiveState: 'ready', replayAvailable: true, players: [{ name: 'Alice' }, rival] }],
    }], cursor: null });
  });
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><MemoryRouter><HistoryScreen /></MemoryRouter></QueryClientProvider>);
  const toggle = await screen.findByRole('button', { name: /Luna/ });
  expect(within(toggle).getByRole('img', { name: 'Gemini' })).toBeTruthy();
  expect(within(toggle).getByText('gemini-pro')).toBeTruthy();
  fireEvent.click(toggle);
  const game = screen.getByRole('region', { name: 'Game 1' });
  expect(within(game).getByRole('img', { name: 'Gemini' })).toBeTruthy();
  expect(within(game).getByText('high')).toBeTruthy();
  expect(screen.queryByRole('img', { name: 'Claude' })).toBeNull();
});

test('a participant can exclude a match, see the reason and still open its replay', async () => {
  useSession.setState({ userName: 'Alice', phase: 'signedIn' });
  const match = {
    id: 'match', name: 'Practice', status: 'completed', format: 'Pioneer', startedAt: 1, canExcludeFromStatistics: true,
    statisticsExclusion: null as null | {reason: string, author: string, markedAt: string},
    games: [{ gameId: 'game', gameNumber: 1, archiveState: 'ready', replayAvailable: true, players: [{ name: 'Alice' }, { name: 'Bob' }] }],
  };
  let refreshes = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/matches/match/statistics-exclusion') && init.method === 'POST') {
      match.statisticsExclusion = { ...JSON.parse(String(init.body)), author: 'Alice', markedAt: '2026-11-22T12:00:00Z' };
      return Response.json(match.statisticsExclusion);
    }
    if (url.includes('/performance')) {
      refreshes++;
      return Response.json({ groups: [], decks: [], summary: { matches: { total: 0 }, games: { total: 0 } } });
    }
    return Response.json({ matches: [match], cursor: null });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><MemoryRouter><HistoryScreen /></MemoryRouter></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: /Bob/ }));
  fireEvent.click(screen.getByText('Exclude from statistics'));
  fireEvent.change(screen.getByRole('textbox', { name: 'Reason' }), { target: { value: 'Connection lost' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save exclusion' }));
  expect(await screen.findByText('Connection lost')).toBeTruthy();
  expect(screen.getByText('Excluded from statistics')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Replay' })).toBeTruthy();
  expect(refreshes).toBeGreaterThan(1);
});

test('a direct match link fetches just its history row and opens the details', async () => {
  useSession.setState({ userName: 'Alice', phase: 'signedIn' });
  const id = '00000000-0000-4000-8000-000000000001';
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes('/performance')) return Response.json({ groups: [], decks: [] });
    const query = new URL(url, 'https://local.test').searchParams;
    expect(query.get('id')).toBe(id);
    return Response.json({ matches: [{ id, name: 'Exact match', format: 'Pioneer', startedAt: 1, status: 'interrupted',
      games: [], statisticsExclusion: { author: 'Alice', reason: 'Transport failure', markedAt: '2026-11-22T12:00:00Z' } }], cursor: null });
  });
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/history?matchId=' + id]}><HistoryScreen /></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText('Transport failure')).toBeTruthy();
  expect(screen.getByRole('button', { name: /Exact match/ }).getAttribute('aria-expanded')).toBe('true');
});
