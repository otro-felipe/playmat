import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { TournamentScreen, TournamentsScreen } from './TournamentScreen';

const root = '/api/playtesting/tournaments';
const entrant = { id: 'e1', name: 'Luna', owner: 'Felipe', kind: 'agent', online: true, status: 'active' };
const cup = {
  id: 'cup',
  name: 'Copa del viernes',
  format: 'Standard',
  template: 'attendance',
  cut: 'none',
  capacity: 8,
  status: 'break',
  stage: 'swiss',
  roundNumber: 1,
  roundsTotal: 3,
  nextRoundAt: Date.now() + 300000,
  cutSize: 0,
  participants: [entrant],
  standings: [],
  pairings: [],
  viewer: { username: 'Felipe', isAdmin: true },
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount(path: string, body: Record<string, unknown>, review?: Record<string, unknown>) {
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input);
    let result: unknown = body;
    if (path.startsWith('/api/playtesting/review/games/')) return Response.json(review ?? {}, { status: review ? 200 : 404 });
    if (path === '/api/playtesting/players') result = { players: [] };
    if (path.startsWith('/api/playtesting/decks?')) result = { decks: [] };
    if (path === root && init?.method === 'POST') result = { ...cup, id: 'created' };
    else if (path === root)
      result = {
        tournaments: [],
        mayCreate: true,
        viewer: cup.viewer,
        attendanceStructures: [
          { upTo: 8, swissRounds: 0, cutSize: 8, roundsOnly: 3 },
          { upTo: 16, swissRounds: 5, cutSize: 4, roundsOnly: 4 },
        ],
      };
    return new Response(JSON.stringify(result), { status: 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/tournaments" element={<TournamentsScreen />} />
          <Route path="/tournaments/:id" element={<TournamentScreen />} />
          <Route path="/tournaments/:id/admin" element={<TournamentScreen admin />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { view, fetcher };
}
test('organizer opens the administration tab and extends an inter-round break without joining a seat', async () => {
  const { view, fetcher } = mount('/tournaments/cup/admin', cup);
  await view.findByRole('heading', { name: cup.name });
  fireEvent.click(view.getByRole('button', { name: /extend break/i }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([url, init]) =>
          url === root + '/cup/admin' &&
          JSON.parse(String(init?.body)).action === 'extend' &&
          JSON.parse(String(init?.body)).minutes === 5,
      ),
    ).toBe(true),
  );
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/wait'))).toBe(false);
});
test('the public scoreboard names an agent and owner and offers only published information', async () => {
  const { view } = mount('/tournaments/cup', { ...cup, viewer: null });
  await view.findByText('Luna');
  expect(view.getByRole('link', { name: 'Felipe' }).getAttribute('href')).toContain('/tournaments/owners/Felipe');
  expect(view.queryByRole('link', { name: /administration/i })).toBeNull();
  expect(view.queryByText(/sideboard/i)).toBeNull();
  // A tournament opens on its standings and tables; statistics wait for the end.
  expect(view.getByRole('tab', { name: 'Standings' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(view.getByRole('tab', { name: 'Statistics' }));
  expect(view.getByText('Statistics are published when the tournament ends.')).toBeTruthy();
});

test('[PM-MCP-PLAYER-VIEW-MODEL] shows provider and model for configured agents in the roster standings and tables', async () => {
  const configured = { ...entrant, provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high' };
  const human = { ...entrant, id: 'e2', name: 'Vale', owner: 'Vale', kind: 'human' };
  const legacy = { ...entrant, id: 'e3', name: 'Legacy' };
  const { view } = mount('/tournaments/cup', {
    ...cup,
    viewer: null,
    participants: [configured, human, legacy],
    standings: [configured, human, legacy].map((e, i) => ({ ...e, rank: i + 1, wins: 1, losses: 0, ties: 0, points: 3, omw: 0, gw: 1, ogw: 0 })),
    pairings: [{ id: 'a', roundNumber: 1, stage: 'swiss', number: 1, a: 'e1', b: 'e2' }],
  });
  // The standings and the round's table both name the configured model.
  expect((await view.findAllByRole('img', { name: 'Claude' })).length).toBeGreaterThanOrEqual(2);
  expect(view.getAllByText('claude-opus-5-5').length).toBeGreaterThanOrEqual(2);
  const item = view.getByText('Legacy').closest('tr')!;
  expect(within(item).queryByRole('img')).toBeNull();
});

test('admin creates an eight-player casual Swiss event with three rounds and no playoff', async () => {
  const { view, fetcher } = mount('/tournaments', cup);
  fireEvent.click(await view.findByRole('button', { name: /create tournament/i }));
  fireEvent.change(view.getByLabelText(/tournament name/i), { target: { value: 'Casual del viernes' } });
  await view.findByText('3 rounds with 8 participants');
  fireEvent.click(view.getByRole('checkbox', { name: 'Calculate rounds from attendance' }));
  fireEvent.click(view.getByRole('button', { name: /publish tournament/i }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([url, init]) =>
          url === root &&
          init?.method === 'POST' &&
          JSON.parse(String(init.body)).cut === 'none' &&
          JSON.parse(String(init.body)).swissRounds === 3,
      ),
    ).toBe(true),
  );
});

test('a public visitor receives updated standings and deck disclosure when the playoff snapshot arrives', async () => {
  const streams: EventTarget[] = [];
  vi.stubGlobal(
    'EventSource',
    class extends EventTarget {
      constructor() {
        super();
        streams.push(this);
      }
      close() {}
    },
  );
  const { view } = mount('/tournaments/cup', { ...cup, viewer: null });
  await view.findByRole('heading', { name: cup.name });
  expect(view.queryByRole('heading', { name: 'Published decklists' })).toBeNull();
  const updated = {
    ...cup,
    viewer: null,
    status: 'playing',
    stage: 'playoffs',
    cutSize: 8,
    participants: [entrant],
    standings: [],
    pairings: [
      {
        id: 'p2',
        roundNumber: 2,
        stage: 'playoffs',
        number: 1,
        a: entrant.id,
        b: null,
        completed: true,
        winsA: 2,
        winsB: 0,
        draws: 0,
      },
    ],
    deckLists: [{ entryId: entrant.id, name: 'Luna Standard', cards: [{ amount: 60, cardName: 'Forest' }], sideboard: [] }],
  };
  const { act } = await import('@testing-library/react');
  act(() => {
    streams[0].dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(updated) }));
  });
  await view.findByRole('heading', { name: 'Playoff bracket' });
  fireEvent.click(view.getByRole('tab', { name: 'Decklists' }));
  const list = within(await view.findByRole('article', { name: 'Decklist of Luna' }));
  expect(list.getByText('Forest')).toBeTruthy();
  expect(list.getByText('60', { selector: 'span' })).toBeTruthy();
});

test('an enrolled human can open the game before a table exists, while the administration stays in its own tab', async () => {
  const human = { ...entrant, id: 'human', name: 'Felipe', owner: 'Felipe', kind: 'human', state: 'registered' };
  const { view, fetcher } = mount('/tournaments/cup/admin', {
    ...cup,
    status: 'registration',
    participants: [human],
    viewer: { accountName: 'Felipe', isAdmin: true, entryIds: ['human'] },
  });
  const link = await view.findByRole('link', { name: 'Play at my table' });
  expect(link.getAttribute('href')).toBe('/tournaments/cup/play');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/wait'))).toBe(false);
});

test('the creation preview distinguishes an eight-seat Swiss pilot from Appendix E single elimination, and supports casual coaching', async () => {
  const { view, fetcher } = mount('/tournaments', cup);
  fireEvent.click(await view.findByRole('button', { name: 'Create tournament' }));
  await view.findByText('3 rounds with 8 participants');
  fireEvent.change(view.getByLabelText('Playoffs'), { target: { value: 'auto' } });
  await view.findByText('8 participants · 3 single-elimination rounds');
  fireEvent.change(view.getByLabelText('Maximum participants'), { target: { value: '16' } });
  await view.findByText('16 participants · 5 Swiss rounds · Top 4');
  fireEvent.change(view.getByLabelText('Tournament name'), { target: { value: 'Friendly Cup' } });
  fireEvent.click(view.getByLabelText(/Allow coaching/i));
  fireEvent.click(view.getByRole('button', { name: 'Publish tournament' }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([url, init]) => url === root && init?.method === 'POST' && JSON.parse(String(init.body)).coaching,
      ),
    ).toBe(true),
  );
});

test('the owner who administers several rounds still owns the same agents and never marks a pilot connected from the dashboard', async () => {
  const streams: EventTarget[] = [];
  vi.stubGlobal(
    'EventSource',
    class extends EventTarget {
      constructor() {
        super();
        streams.push(this);
      }
      close() {}
    },
  );
  const snapshot = {
    ...cup,
    participants: [{ ...entrant, online: false }],
    viewer: { accountName: 'Felipe', isAdmin: true, entryIds: ['e1'] },
  };
  const { view, fetcher } = mount('/tournaments/cup/admin', snapshot);
  await view.findByText('Offline');
  const { act } = await import('@testing-library/react');
  for (const roundNumber of [2, 3]) {
    act(() => {
      streams[0].dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify({ ...snapshot, roundNumber }) }));
    });
    await view.findByText('Round ' + roundNumber + ' of 3');
    expect(view.getByRole('link', { name: 'Felipe' }).getAttribute('href')).toBe('/tournaments/owners/Felipe');
    expect(view.queryByText('Online')).toBeNull();
  }
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/wait'))).toBe(false);
});

test('registration scopes a library read to the owner shown on screen if another tab changes the login', async () => {
  const { fetcher, view } = mount('/tournaments/cup', {
    ...cup,
    status: 'registration',
    viewer: { accountName: 'Felipe', entryIds: [], isAdmin: false },
  });
  await view.findByText('No saved deck for this format.');
  expect(fetcher.mock.calls.find(([url]) => url.includes('/decks?'))?.[1]?.headers).toMatchObject({
    'X-Playmat-Deck-Owner': 'Felipe',
  });
});

test('[CUP-AC-002] the organizer retries only the selected physical table after confirming its first game never started', async () => {
  const pair = { id: 'pair1', tableId: 'old1', roundNumber: 1, stage: 'swiss', number: 1, a: 'e1', b: 'e2', winsA: 0, winsB: 0, draws: 0, completed: false };
  const { view, fetcher } = mount('/tournaments/cup/admin', {
    ...cup, status: 'playing', participants: [entrant, { ...entrant, id: 'e2', name: 'Sol' }],
    pairings: [pair, { ...pair, id: 'pair2', number: 2, tableId: 'finished2', completed: true }],
  });
  fireEvent.click(await view.findByText('Recover a failed table start'));
  const select = view.getByRole('combobox', { name: 'Table to recover' });
  expect(select.querySelectorAll('option')).toHaveLength(2);
  const retry = view.getByRole('button', { name: 'Retry table start' }) as HTMLButtonElement;
  expect(retry.disabled).toBe(true);
  fireEvent.change(select, {target: {value: 'old1'}});
  expect(retry.disabled).toBe(true);
  fireEvent.click(view.getByRole('checkbox', { name: /confirmed.*first game/i }));
  fireEvent.click(retry);
  await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => url === root + '/cup/admin' && init?.method === 'POST' &&
    JSON.stringify(JSON.parse(String(init.body))) === JSON.stringify({action:'retryFailedStart', pairingId:'pair1', tableId:'old1', confirmedPreGameFailure:true}))).toBe(true));
});

test.each(['playing', 'finished', 'cancelled'])('[CUP-AC-002] administration hides the panel when no controls can be used (%s)', async (status) => {
  const { view } = mount('/tournaments/cup/admin', {
    ...cup,
    status,
    participants: [entrant, { ...entrant, id: 'e2', name: 'Sol' }],
    pairings: [{
      id: 'pair1', tableId: 'table1', matchId: 'match1', roundNumber: 1, stage: 'swiss',
      number: 1, a: 'e1', b: 'e2', winsA: 0, winsB: 0, draws: 0, completed: status === 'finished',
    }],
  });
  await view.findByRole('heading', { name: cup.name });
  expect(view.queryByRole('heading', { name: 'Tournament administration' })).toBeNull();
  expect(view.getByRole('tab', { name: 'Standings' }).getAttribute('aria-selected')).toBe('true');
  expect(view.getByRole('heading', { name: 'Round tables' })).toBeTruthy();
});

test('[CUP-AC-008] a cancelled table shows its status and retains other table results', async () => {
  const pair = { id: 'pair1', tableId: 'table1', roundNumber: 1, stage: 'swiss', number: 1, a: 'e1', b: 'e2', winsA: 0, winsB: 0, draws: 0 };
  const { view } = mount('/tournaments/cup?tab=bracket', {
    ...cup,
    status: 'cancelled',
    participants: [entrant, { ...entrant, id: 'e2', name: 'Sol' }],
    pairings: [
      { ...pair, reason: 'cancelled', completed: false, watchUrl: '/stale-watch' },
      { ...pair, id: 'pair2', number: 2, winsA: 2, winsB: 1, completed: true, replayUrl: '/saved-replay' },
    ],
  });
  await view.findByText('Cancelled');
  const stopped = within(await view.findByRole('listitem', { name: 'Table 1' }));
  expect(stopped.getByText('Table cancelled')).toBeTruthy();
  expect(stopped.queryByRole('link', { name: 'Watch live' })).toBeNull();
  const complete = within(view.getByRole('listitem', { name: 'Table 2' }));
  expect(complete.getByText('2 – 1')).toBeTruthy();
  expect(complete.getByRole('link', { name: 'Full replay' }).getAttribute('href')).toBe('/saved-replay');
});

test('[PM-TOUR-VOID-AC-001] a finished tournament owner confirms annulment from administration', async () => {
  const { view, fetcher } = mount('/tournaments/cup/admin', {
    ...cup, status: 'finished', viewer: { ...cup.viewer, canVoid: true },
  });
  const open = await view.findByRole('button', { name: 'Annul tournament' });
  fireEvent.click(open);
  const dialog = await view.findByRole('dialog', { name: 'Annul this tournament?' });
  expect(fetcher.mock.calls.some(([path]) => path.endsWith('/void'))).toBe(false);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm annulment' }));
  await waitFor(() => {
    const request = fetcher.mock.calls.find(([path, init]) => path === root + '/cup/void' && init?.method === 'POST');
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      expectedStatus: 'finished', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });
});

test('a finished tournament opens on its standings, then shows statistics and lists its decks with their archetypes', async () => {
  const { view, fetcher } = mount('/tournaments/cup', {
    ...cup,
    viewer: null,
    status: 'finished',
    championId: entrant.id,
    standings: [{ ...entrant, rank: 1, wins: 3, losses: 0, ties: 0, points: 9, omw: 0.5, gw: 1, ogw: 0.5 }],
    deckLists: [{ entryId: entrant.id, name: 'Luna list', archetype: 'Red Deck Wins', cards: [{ amount: 60, cardName: 'Mountain' }], sideboard: [] }],
  });
  await view.findByRole('heading', { name: cup.name });
  expect(view.getByRole('tab', { name: 'Standings' }).getAttribute('aria-selected')).toBe('true');
  const standings = within(view.getByRole('heading', { name: 'Standings' }).closest('section')!);
  // Each participant is shown with its archetype, record, points, win rates and tiebreakers in one row.
  expect(standings.getByText('Red Deck Wins')).toBeTruthy();
  expect(standings.getByText('9')).toBeTruthy();
  fireEvent.click(view.getByRole('tab', { name: 'Statistics' }));
  await view.findByRole('heading', { name: 'Tournament statistics' });
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(root + '/cup/statistics?'))).toBe(true));
  fireEvent.click(view.getByRole('tab', { name: 'Decklists' }));
  const list = within(view.getByRole('article', { name: 'Decklist of Luna' }));
  expect(list.getByText('Red Deck Wins')).toBeTruthy();
  expect(list.getByText('Mountain')).toBeTruthy();
});

test('[PM-REVIEW-API-13] public table games show result and quality without reading an embedded reason', async () => {
  const { view, fetcher } = mount('/tournaments/cup', {
    ...cup,
    viewer: null,
    status: 'finished',
    participants: [entrant, { ...entrant, id: 'e2', name: 'Sol' }],
    standings: [],
    pairings: [{
      id: 'pair1', tableId: 'table1', matchId: 'match1', roundNumber: 1, stage: 'swiss', number: 1, a: 'e1', b: 'e2',
      winsA: 1, winsB: 1, draws: 0, completed: true, winner: 'e1', replayUrl: '/replay',
      games: [
        { id: 'g1', number: 1, status: 'completed', winner: 'a', endCause: null, goodQuality: true, qualityReason: 'Both pilots played it out.' },
        { id: 'g2', number: 2, status: 'completed', winner: 'b', endCause: 'inactivity', goodQuality: false },
      ],
    }],
  });
  const games = within(await view.findByRole('list', { name: 'Games at table 1' }));
  expect(games.getAllByRole('listitem')).toHaveLength(2);
  expect(games.getByText('Luna wins')).toBeTruthy();
  expect(games.getByText('Inactivity')).toBeTruthy();
  const star = games.getByRole('button', { name: 'Good quality' });
  expect(games.getByRole('button', { name: "Doesn't qualify" })).toBeTruthy();
  expect(games.getByRole('link', { name: 'Replay of game 2' }).getAttribute('href')).toBe('/replay?game=2');
  fireEvent.focus(star);
  await view.findByRole('tooltip');
  expect(view.queryByText('Both pilots played it out.')).toBeNull();
  expect(fetcher.mock.calls.some(([url]) => url.startsWith('/api/playtesting/review/'))).toBe(false);
});

test('[PM-REVIEW-API-13] the owner of both entries loads just the focused verdict from the archive manifest', async () => {
  const reason = 'Both pilots played it out.';
  const { view, fetcher } = mount('/tournaments/cup', {
    ...cup,
    viewer: { accountName: 'Felipe', entryIds: ['e1', 'e2'], isAdmin: false },
    status: 'finished',
    participants: [entrant, { ...entrant, id: 'e2', name: 'Sol' }],
    pairings: [{
      id: 'pair1', tableId: 'table1', matchId: 'match1', roundNumber: 1, stage: 'swiss', number: 1, a: 'e1', b: 'e2',
      winsA: 1, winsB: 1, draws: 0, completed: true, winner: 'e1',
      games: [
        { id: 'g1', number: 1, status: 'completed', winner: 'a', endCause: null, goodQuality: true },
        { id: 'g2', number: 2, status: 'completed', winner: 'b', endCause: null, goodQuality: false },
      ],
    }],
  }, { gameId: 'g1', goodQuality: true, qualityReason: '- ' + reason });
  const reviewCalls = () => fetcher.mock.calls.map(([url]) => url).filter(url => url.startsWith('/api/playtesting/review/'));
  const star = await view.findByRole('button', { name: 'Good quality' });
  expect(reviewCalls()).toEqual([]);
  fireEvent.focus(star);
  expect((await view.findAllByText(reason)).some(element => element.tagName === 'LI')).toBe(true);
  expect(reviewCalls()).toEqual(['/api/playtesting/review/games/g1?archiveOnly=true']);
});
