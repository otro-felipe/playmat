import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { TournamentPlayTab, TournamentSeatLauncher } from './TournamentPlayTab';
import { tournamentPlaySeat } from './tournamentPlaySeat';

const receipt = { status: 'registration', entryId: 'human-seat' };
const event = {
  id: 'cup',
  status: 'registration',
  viewer: { accountName: 'Felipe', entryIds: ['human-seat', 'pilot'] },
  participants: [
    { id: 'human-seat', kind: 'human', owner: 'Felipe', state: 'registered' },
    { id: 'pilot', kind: 'agent', owner: 'Felipe', state: 'registered' },
  ],
  pairings: [],
};
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
function tab(path: string, signedInAs: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/tournaments/:id/play" element={<TournamentSeatLauncher />} />
          {['/', '/game/:id'].map((p) => (
            <Route
              key={p}
              path={p}
              element={
                <>
                  <TournamentPlayTab username={signedInAs} />
                  <h1>Game client</h1>
                </>
              }
            />
          ))}
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
test('launching a human seat from administration maintains its own lobby heartbeat and resumes it after a game tab reload', async () => {
  const beats: RequestInit[] = [];
  let finished = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/wait')) {
        beats.push(init);
        return Response.json({ ...receipt, status: finished ? 'finished' : 'table' });
      }
      if (url.endsWith('/me')) return Response.json({ engineName: 'Felipe', agent: false });
      return Response.json(event);
    }),
  );
  const lobby = tab('/tournaments/cup/play', 'Felipe');
  await lobby.findByRole('heading', { name: 'Game client' });
  await waitFor(() => expect(beats).toHaveLength(1));
  expect(JSON.parse(String(beats[0].body))).not.toHaveProperty('playerId');
  expect(tournamentPlaySeat()?.entryId).toBe('human-seat');
  lobby.unmount();
  finished = true;
  const game = tab('/game/game-two', 'Felipe');
  await game.findByRole('heading', { name: 'Game client' });
  await waitFor(() => expect(beats).toHaveLength(2));
  await waitFor(() => expect(tournamentPlaySeat()).toBeNull());
});
test('a restored game tab for a different owner never announces an old seat', async () => {
  const beats: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/wait')) beats.push(url);
      if (url.endsWith('/me')) return Response.json({ engineName: 'Felipe', agent: false });
      return Response.json(url.endsWith('/wait') ? receipt : event);
    }),
  );
  const lobby = tab('/tournaments/cup/play', 'Felipe');
  await waitFor(() => expect(beats).toHaveLength(1));
  lobby.unmount();
  const other = tab('/', 'Roberto');
  await other.findByRole('heading', { name: 'Game client' });
  await waitFor(() => expect(tournamentPlaySeat()).toBeNull());
  expect(beats).toHaveLength(1);
});

test('a connected lobby tab refreshes presence for longer than the registration grace period, and stops when its cookie changes owner', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const { act } = await import('@testing-library/react');
    const { rememberTournamentPlaySeat } = await import('./tournamentPlaySeat');
    rememberTournamentPlaySeat({ tournamentId: 'cup', username: 'Felipe', entryId: 'human-seat' });
    const beats: string[] = [];
    let owner = 'Felipe';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/me')) return Response.json({ engineName: owner, agent: false });
        beats.push(url);
        return Response.json(receipt);
      }),
    );
    tab('/', 'Felipe');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100_000);
    });
    expect(beats.length).toBeGreaterThanOrEqual(10);
    const before = beats.length;
    owner = 'Roberto';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(tournamentPlaySeat()).toBeNull();
    expect(beats).toHaveLength(before);
  } finally {
    vi.useRealTimers();
  }
});
