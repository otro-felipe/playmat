import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { PublicStatistics, StatisticsPanel } from './PublicStatistics';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const izzet = {
  id: 'izzet',
  name: 'Izzet Phoenix',
  format: 'Pioneer',
  colors: ['R', 'U'],
  n: 10,
  wins: 5,
  draws: 2,
  losses: 3,
};
const mirror = { ...izzet, n: 4, wins: 2, draws: 0, losses: 2 };
const deck = { ...izzet, id: 'public-deadbeef', name: null, colors: null };
// The tournament page hosts the same panel in its statistics tab.
function TournamentStatisticsTab() {
  const { id = '' } = useParams();
  const { search } = useLocation();
  return (
    <>
      <output aria-label="location">{search}</output>
      <StatisticsPanel tournamentId={id} path={'/tournaments/' + id} scope={{ tab: 'stats' }} headingLevel={2} />
    </>
  );
}
function show(url: string, response: (request: URL) => unknown) {
  const fetch = vi.fn(async (input: string) => Response.json(response(new URL(input, 'http://fixture'))));
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const page = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/statistics" element={<PublicStatistics />} />
          <Route path="/tournaments/:id/statistics" element={<PublicStatistics />} />
          <Route path="/tournaments/:id" element={<TournamentStatisticsTab />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { page, fetch };
}

const table = (page: ReturnType<typeof render>, name = 'Archetype') => page.findByRole('table', { name });

it('[PM-STATS-QUALITY-1] toggles the tournament statistics sample and keeps the quality filter in detail and group links', async () => {
  const { page, fetch } = show('/tournaments/cup?tab=stats&format=Pioneer', (request) => {
    const quality = request.searchParams.get('goodQuality') === 'true';
    return {
      tournamentName: 'Quality fixture',
      formats: ['Pioneer'],
      format: 'Pioneer',
      matches: quality ? 2 : 6,
      games: quality ? 4 : 14,
      rows: [izzet],
      selected: request.searchParams.has('selected') ? { ...izzet, matchups: [mirror] } : null,
    };
  });
  // The sample filter is a two-way choice: every game, or only good-quality games.
  const filter = within(page.getByRole('group', { name: 'Games counted' }));
  expect(filter.getByRole('link', { name: 'All games' }).getAttribute('aria-pressed')).toBe('true');
  expect(await page.findByText('Pioneer · 6 matches · 14 games')).toBeTruthy();
  expect(fetch.mock.calls.at(-1)?.[0]).not.toContain('goodQuality');
  filter.getByRole('link', { name: 'Good quality' }).focus();
  await userEvent.keyboard('{Enter}');
  expect(filter.getByRole('link', { name: 'Good quality' }).getAttribute('aria-pressed')).toBe('true');
  expect(await page.findByText('Pioneer · 2 matches · 4 games')).toBeTruthy();
  expect(fetch.mock.calls.at(-1)?.[0]).toContain('goodQuality=true');
  expect(page.getByLabelText('location').textContent).toContain('tab=stats');
  expect(page.getByRole('link', { name: 'Decks' }).getAttribute('href')).toContain('goodQuality=true');
  const detail = within(await table(page)).getByRole('link', { name: 'Izzet Phoenix' });
  expect(detail.getAttribute('href')).toContain('goodQuality=true');
  await userEvent.click(detail);
  expect(await page.findByRole('region', { name: 'Matchups' })).toBeTruthy();
  await userEvent.click(within(page.getByRole('group', { name: 'Games counted' })).getByRole('link', { name: 'All games' }));
  expect(within(page.getByRole('group', { name: 'Games counted' })).getByRole('link', { name: 'All games' }).getAttribute('aria-pressed')).toBe('true');
  await waitFor(() => expect(fetch.mock.calls.at(-1)?.[0]).not.toContain('goodQuality'));
  expect(fetch.mock.calls.at(-1)?.[0]).toContain('selected=izzet');
});

it('navigates between format-scoped archetypes and their matchups with a shareable URL', async () => {
  const { page, fetch } = show('/statistics', (request) => ({
    formats: ['Pioneer', 'Modern'],
    format: 'Pioneer',
    matches: 6,
    games: 14,
    rows: [izzet],
    tournamentName: null,
    selected: request.searchParams.get('selected') === izzet.id ? { ...izzet, matchups: [mirror] } : null,
  }));
  const ranking = await table(page);
  const link = within(ranking).getByRole('link', { name: 'Izzet Phoenix' });
  expect(link.getAttribute('href')).toContain('selected=izzet');
  const row = link.closest('tr')!;
  expect(within(row).getByText('50%')).toBeTruthy();
  expect(within(row).getByRole('img', { name: 'Archetype colors (Blue, Red)' })).toBeTruthy();
  // The server's default format is the selected option, and there is no mixed "all formats" view.
  const select = page.getByRole('combobox', { name: 'Format' }) as HTMLSelectElement;
  expect(select.value).toBe('Pioneer');
  expect(within(select).queryByText('All formats')).toBeNull();
  expect(page.getByText('Pioneer · 6 matches · 14 games')).toBeTruthy();
  fireEvent.change(select, { target: { value: 'Pioneer' } });
  fireEvent.click(within(await table(page)).getByRole('link', { name: 'Izzet Phoenix' }));
  expect(await page.findByRole('region', { name: 'Matchups' })).toBeTruthy();
  // A matchup row reads from the selection's side: "vs" its opponent.
  expect(within(await table(page, 'Opponent')).getByText(/vs Izzet Phoenix/)).toBeTruthy();
  expect(fetch.mock.calls.at(-1)?.[0]).toContain('format=Pioneer');
  expect(page.getByRole('link', { name: 'Archetypes' }).getAttribute('href')).toContain('format=Pioneer');
});

it('[PM-STATS-QUALITY-1] shows game rates and a data summary when no full series qualifies', async () => {
  const row = { ...izzet, n: 0, wins: 0, draws: 0, losses: 0, games: 2, gameWins: 1 };
  const { page } = show('/statistics?goodQuality=true', (request) => ({
    formats: ['Pioneer'],
    format: 'Pioneer',
    matches: 0,
    games: 2,
    rows: [row],
    selected: request.searchParams.has('selected') ? { ...row, matchups: [row] } : null,
  }));
  expect(await page.findByText('Pioneer · 0 matches · 2 games')).toBeTruthy();
  expect((page.getByRole('combobox', { name: 'Format' }) as HTMLSelectElement).value).toBe('Pioneer');
  const summary = page.getByRole('region', { name: 'Format summary' });
  expect(within(summary).getByRole('heading', { name: 'Data' })).toBeTruthy();
  expect(within(summary).queryByRole('heading', { name: 'Strongest archetype' })).toBeNull();
  expect(within(summary).queryByRole('heading', { name: /most played/i })).toBeNull();
  const ranking = await table(page);
  expect(within(ranking).getByText('50%')).toBeTruthy();
  await userEvent.click(within(ranking).getByRole('link', { name: 'Izzet Phoenix' }));
  expect(within(await table(page, 'Opponent')).getByText('50%')).toBeTruthy();
});

it('answers which archetype is strongest, by which metric and with how much data', async () => {
  const lucky = { ...izzet, id: 'lucky', name: 'Lucky Streak', n: 2, wins: 2, draws: 0, losses: 0 };
  const solid = { ...izzet, id: 'solid', name: 'Solid Deck', n: 40, wins: 26, draws: 2, losses: 12 };
  const { page } = show('/statistics', () => ({
    formats: ['Pioneer'],
    format: 'Pioneer',
    matches: 21,
    games: 50,
    unclassified: 3,
    rows: [solid, lucky],
    selected: null,
  }));
  const summary = await page.findByRole('region', { name: 'Format summary' });
  // Popularity is the agents' choice, not a preference: only strength and the sample size are summarised.
  const [strongest, data] = within(summary).getAllByRole('article');
  expect(within(summary).getAllByRole('article')).toHaveLength(2);
  expect(summary.textContent).not.toMatch(/metagame|most played/i);
  // Two straight wins do not beat 65% over forty matches.
  expect(within(strongest).getByRole('link', { name: 'Solid Deck' })).toBeTruthy();
  expect(strongest.textContent).toMatch(/65%.*of matches won.*95% CI: .*over 40 matches/);
  expect(data.textContent).toMatch(/matches21.*games50.*Archetypes2.*3 unclassified participations/);
  // Win rates use the same red-amber-green scale as a player's deck analysis.
  const rate = within(within(await table(page)).getByRole('link', { name: 'Lucky Streak' }).closest('tr')!).getByText('100%');
  expect(rate.getAttribute('style')).toContain('hsl(144');
});

it('opens scoped anonymous deck details with the exact list', async () => {
  const colorless = { ...deck, id: 'other-00001111', colors: [] };
  const { page, fetch } = show('/tournaments/cup/statistics?group=deck&selected=public-deadbeef', () => ({
    formats: ['Pioneer'],
    matches: 8,
    tournamentName: 'League',
    rows: [deck, colorless],
    selected: {
      ...deck,
      matchups: [colorless],
      list: { kind: 'deck', main: [{ name: 'Mountain', amount: 20 }, { name: 'Monastery Swiftspear', amount: 4 }], sideboard: [{ name: 'Abrade', amount: 2 }] },
      hands: { games: 0, wins: 0, mulligans: [], cards: [] },
    },
  }));
  expect(await page.findByRole('heading', { name: /Anonymous deck.*adbeef/i })).toBeTruthy();
  expect(fetch.mock.calls[0][0]).toContain('/api/playtesting/tournaments/cup/statistics');
  // An old statistics link opens the tournament's statistics tab with the same filters.
  expect(page.getByRole('status', { name: 'location' }).textContent).toBe('?group=deck&selected=public-deadbeef&tab=stats');
  expect(page.getByRole('link', { name: /Back to Decks/i }).getAttribute('href')).toBe('/tournaments/cup?tab=stats&group=deck');
  expect(page.getByRole('img', { name: 'Colors of its archetype (Unknown colors)' })).toBeTruthy();
  expect(page.getByRole('img', { name: 'Colors of its archetype (Colorless)' })).toBeTruthy();
  await userEvent.click(page.getByRole('link', { name: 'Decklist' }));
  const main = await page.findByRole('group', { name: 'Main deck' });
  expect(main.textContent).toMatch(/Main deck\s*24/);
  expect(main.textContent).toMatch(/4\s*Monastery Swiftspear/);
  expect(page.getByRole('group', { name: 'Sideboard' }).textContent).toMatch(/2\s*Abrade/);
  await userEvent.click(page.getByRole('link', { name: 'Opening hands' }));
  expect(await page.findByText('No kept hands recorded for this selection yet.')).toBeTruthy();
});

it('allows recovery from an unavailable selection and reports a genuinely empty comparison', async () => {
  const { page } = show('/statistics?selected=missing', () => ({
    formats: [],
    matches: 0,
    rows: [],
    selected: null,
  }));
  expect(await page.findByText('This selection is unavailable.')).toBeTruthy();
  fireEvent.click(page.getByRole('link', { name: /Back to Archetypes/ }));
  expect(await page.findByText('No public match results for these filters.')).toBeTruthy();
});

it('leaves unclassified opponents unnamed and draws a named archetype in its own colors', async () => {
  const unknown = { ...izzet, id: 'undetermined-fixture', name: null, colors: null };
  const { page } = show('/statistics?selected=izzet', () => ({
    formats: ['Pioneer'],
    matches: 2,
    rows: [{ ...izzet, colors: null }],
    selected: { ...izzet, colors: null, matchups: [unknown] },
  }));
  const matchups = await table(page, 'Opponent');
  expect(within(matchups).getByRole('link', { name: 'vs Unclassified' })).toBeTruthy();
  expect(within(matchups).getByRole('img', { name: 'Archetype colors (Unknown colors)' })).toBeTruthy();
  expect(page.getByRole('img', { name: 'Archetype colors (Blue, Red)' })).toBeTruthy();
  expect(page.queryByText(/Anonymous deck/i)).toBeNull();
});

it('separates unidentified lists pooled together from individual private compositions', async () => {
  const pooled = { ...deck, id: 'unidentified', unidentified: true };
  const { page } = show('/statistics?group=deck&selected=public-deadbeef', () => ({
    formats: ['Pioneer'],
    matches: 3,
    rows: [deck],
    selected: { ...deck, matchups: [pooled, deck] },
  }));
  const matchups = await table(page, 'Opponent');
  expect(within(matchups).getByRole('link', { name: 'vs Unidentified decks' })).toBeTruthy();
  expect(page.getByRole('heading', { name: /Anonymous deck.*adbeef/i })).toBeTruthy();
});

it('focuses the detail heading after Enter, labels the mirror, and returns to the original row link', async () => {
  const user = userEvent.setup();
  const { page } = show('/statistics?group=archetype&format=Pioneer', (request) => ({
    formats: ['Pioneer'],
    matches: 3,
    rows: [izzet],
    tournamentName: null,
    selected: request.searchParams.get('selected') ? { ...izzet, matchups: [mirror] } : null,
  }));
  const rowLink = within(await table(page)).getByRole('link', { name: 'Izzet Phoenix' });
  rowLink.focus();
  await user.keyboard('{Enter}');
  const heading = await page.findByRole('heading', { name: 'Izzet Phoenix' });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  const mirrorRow = page.getByRole('rowheader', { name: /Mirror/ });
  expect(within(mirrorRow).queryByRole('link')).toBeNull();
  const back = page.getByRole('link', { name: /Back to Archetypes/i });
  back.focus();
  await user.keyboard('{Enter}');
  const restored = within(await table(page)).getByRole('link', { name: 'Izzet Phoenix' });
  await waitFor(() => expect(document.activeElement).toBe(restored));
});

it('sorts by win rate, game win rate, mulligans and game length, and shows mulligans and common cards of a selection', async () => {
  const user = userEvent.setup();
  const rows = [
    { ...izzet, id: 'a', name: 'UR Aggro', n: 10, wins: 4, games: 25, gameWins: 10, mulliganKnown: 20, mulliganGames: 2, timedGames: 25, durationMs: 25 * 600_000 },
    { ...izzet, id: 'b', name: 'Red Deck Wins', n: 6, wins: 5, games: 14, gameWins: 11, mulliganKnown: 14, mulliganGames: 7, timedGames: 14, durationMs: 14 * 900_000 },
    { ...izzet, id: 'c', name: 'Lotus Field', n: 2, wins: 1, games: 5, gameWins: 3, mulliganKnown: 0, timedGames: 0, durationMs: 0 },
  ];
  const { page } = show('/statistics', (request) => ({
    formats: ['Pioneer'],
    matches: 9,
    rows,
    selected:
      request.searchParams.get('selected') === 'b'
        ? {
            ...rows[1],
            mulligans: 9,
            keptGames: 7,
            keptWins: 5,
            mulliganWins: 3,
            source: 'https://www.mtgtop8.com/archetype?a=862&f=PI',
            matchups: [rows[0]],
            hands: {
              games: 10,
              wins: 6,
              mulligans: [
                { count: 0, games: 7, wins: 5 },
                { count: 1, games: 5, wins: 2 },
                { count: 3, games: 2, wins: 0 },
              ],
              cards: [
                { name: 'Monastery Swiftspear', games: 5, wins: 4 },
                { name: 'Mountain', games: 9, wins: 5 },
                { name: 'Rare Pick', games: 1, wins: 1 },
              ],
            },
            list: {
              kind: 'archetype',
              lists: 4,
              main: [{ name: 'Monastery Swiftspear', lists: 4, copies: 4 }, { name: 'Play with Fire', lists: 3, copies: 3.33 }],
              sideboard: [],
            },
          }
        : null,
  }));
  const ranking = await table(page);
  const order = () => within(ranking).getAllByRole('rowheader').map((cell) => within(cell).getByRole('link').textContent);
  expect(order()).toEqual(['UR Aggro', 'Red Deck Wins', 'Lotus Field']);
  const header = (name: RegExp) => page.getByRole('link', { name });
  await user.click(header(/Sort by Match win %/));
  expect(order()).toEqual(['Red Deck Wins', 'Lotus Field', 'UR Aggro']);
  expect(page.getByRole('columnheader', { name: /Match win %/ }).getAttribute('aria-sort')).toBe('descending');
  await user.click(header(/Sort by Match win %/));
  expect(order()).toEqual(['UR Aggro', 'Lotus Field', 'Red Deck Wins']);
  await user.click(header(/Sort by Game win %/));
  expect(order()).toEqual(['Red Deck Wins', 'Lotus Field', 'UR Aggro']);
  await user.click(header(/Sort by Games with at least one mulligan/));
  expect(order()).toEqual(['Red Deck Wins', 'UR Aggro', 'Lotus Field']);
  await user.click(header(/Sort by Average game length/));
  expect(order()).toEqual(['Red Deck Wins', 'UR Aggro', 'Lotus Field']);
  const red = within(ranking).getByRole('link', { name: 'Red Deck Wins' }).closest('tr')!;
  expect(within(red).getByText('50%')).toBeTruthy();
  expect(within(red).getByText('15 min')).toBeTruthy();
  await user.click(within(ranking).getByRole('link', { name: 'Red Deck Wins' }));
  await user.click(await page.findByRole('link', { name: 'Opening hands' }));
  const byMulligans = await page.findByRole('table', { name: 'Results by number of mulligans' });
  expect(within(byMulligans).getAllByRole('row').map((row) => row.textContent)).toEqual([
    'MulliganGames won',
    'No mulligan71% (5/7)',
    '1 mulligan40% (2/5)',
    '3+ mulligans0% (0/2)',
  ]);
  const cards = page.getByRole('table', { name: 'Cards in the kept hand' });
  // Cards seen in fewer than three hands are left out once enough cards qualify.
  expect(within(cards).getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual(['Monastery Swiftspear', 'Mountain']);
  const swiftspear = within(cards).getByRole('rowheader', { name: 'Monastery Swiftspear' }).closest('tr')!;
  expect(swiftspear.textContent).toBe('Monastery Swiftspear80% (4/5)40% (2/5)+20 pp');
  await user.click(page.getByRole('link', { name: 'Most common cards' }));
  const common = await page.findByRole('group', { name: 'Main deck' });
  // Average copies, the card, and the share of lists that play it.
  expect(within(common).getByText('Play with Fire').closest('li')!.textContent).toBe('3.33Play with Fire75%');
  expect(page.getByText('Based on 4 distinct lists of the archetype.')).toBeTruthy();
  expect(page.getByRole('link', { name: /Archetype on MTGTop8/ }).getAttribute('href')).toContain('a=862');
});

it.each([
  ['archetype', 'Archetype colors (Green)', 'Archetype'],
  ['deck', 'Colors of its archetype (Green)', 'Deck'],
] as const)('draws a Mono-Green archetype in green even when its lists carry blue cards (%s report)', async (group, label, name) => {
  const green = { ...izzet, name: 'Mono-Green Devotion', archetype: 'Mono-Green Devotion', colors: ['G', 'U'] };
  const { page } = show('/statistics?group=' + group, () => ({
    formats: ['Pioneer'],
    matches: 2,
    rows: [green],
    selected: null,
  }));
  expect(await within(await table(page, name)).findByRole('img', { name: label })).toBeTruthy();
  expect(page.queryByText(/How are .* colors determined/)).toBeNull();
});
