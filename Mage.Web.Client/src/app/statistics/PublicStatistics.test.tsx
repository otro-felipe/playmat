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

it('navigates between format-scoped archetypes and their matchups with a shareable URL', async () => {
  const { page, fetch } = show('/statistics', (request) => ({
    formats: ['Pioneer', 'Modern'],
    matches: 6,
    rows: [izzet],
    tournamentName: null,
    selected: request.searchParams.get('selected') === izzet.id ? { ...izzet, matchups: [mirror] } : null,
  }));
  const link = await page.findByRole('link', { name: 'Izzet Phoenix' });
  expect(link.getAttribute('href')).toContain('selected=izzet');
  const row = link.closest('tr')!;
  expect(within(row).getByText('50%')).toBeTruthy();
  expect(within(row).getByRole('img', { name: 'Common archetype palette (Blue, Red)' })).toBeTruthy();
  fireEvent.change(page.getByRole('combobox', { name: 'Format' }), { target: { value: 'Pioneer' } });
  fireEvent.click(await page.findByRole('link', { name: 'Izzet Phoenix' }));
  expect(await page.findByRole('heading', { name: 'Matchups' })).toBeTruthy();
  expect(fetch.mock.calls.at(-1)?.[0]).toContain('format=Pioneer');
  expect(page.getByRole('link', { name: 'Archetypes' }).getAttribute('href')).toContain('format=Pioneer');
});

it('opens scoped anonymous deck details without confusing missing and colorless data', async () => {
  const colorless = { ...deck, id: 'other-00001111', colors: [] };
  const { page, fetch } = show('/tournaments/cup/statistics?group=deck&selected=public-deadbeef', () => ({
    formats: ['Pioneer'],
    matches: 8,
    tournamentName: 'League',
    rows: [deck, colorless],
    selected: { ...deck, matchups: [colorless] },
  }));
  expect(await page.findByRole('heading', { name: /Anonymous deck.*adbeef/i })).toBeTruthy();
  expect(fetch.mock.calls[0][0]).toContain('/api/playtesting/tournaments/cup/statistics');
  // An old statistics link opens the tournament's statistics tab with the same filters.
  expect(page.getByRole('status', { name: 'location' }).textContent).toBe(
    '?group=deck&selected=public-deadbeef&tab=stats',
  );
  expect(page.getByRole('link', { name: /Back to Decks/i }).getAttribute('href')).toBe('/tournaments/cup?tab=stats&group=deck');
  expect(page.getByRole('img', { name: 'Initial deck palette (Unknown colors)' })).toBeTruthy();
  expect(page.getByRole('img', { name: 'Initial deck palette (Colorless)' })).toBeTruthy();
});

it('allows recovery from an unavailable selection and reports a genuinely empty comparison', async () => {
  const { page } = show('/statistics?selected=missing', () => ({
    formats: [],
    matches: 0,
    rows: [],
    selected: null,
  }));
  expect(await page.findByText('This selection is unavailable.')).toBeTruthy();
  fireEvent.click(page.getByRole('link', { name: 'Archetypes' }));
  expect(await page.findByText('No public match results for these filters.')).toBeTruthy();
});

it('leaves unclassified archetypes unnamed and never guesses deck colors from a label', async () => {
  const unknown = { ...izzet, id: 'undetermined-fixture', name: null, colors: null };
  const { page } = show('/statistics', () => ({
    formats: ['Pioneer'],
    matches: 2,
    rows: [unknown, { ...izzet, colors: null }],
    selected: null,
  }));
  expect(await page.findByRole('link', { name: 'Unclassified' })).toBeTruthy();
  expect(page.getAllByRole('img', { name: 'Common archetype palette (Unknown colors)' })).toHaveLength(2);
  expect(page.queryByText(/Anonymous deck/i)).toBeNull();
});

it('separates unidentified lists pooled together from individual private compositions', async () => {
  const pooled = { ...deck, id: 'unidentified', unidentified: true };
  const { page } = show('/statistics?group=deck', () => ({
    formats: ['Pioneer'],
    matches: 3,
    rows: [deck, pooled],
    selected: null,
  }));
  expect(await page.findByRole('link', { name: 'Unidentified decks' })).toBeTruthy();
  expect(page.getByRole('link', { name: /Anonymous deck.*adbeef/i })).toBeTruthy();
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
  const rowLink = await page.findByRole('link', { name: 'Izzet Phoenix' });
  rowLink.focus();
  await user.keyboard('{Enter}');
  const heading = await page.findByRole('heading', { name: 'Izzet Phoenix' });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  const mirrorRow = page.getByRole('rowheader', { name: /Mirror/ });
  expect(within(mirrorRow).queryByRole('link')).toBeNull();
  const back = page.getByRole('link', { name: /Back to Archetypes/i });
  back.focus();
  await user.keyboard('{Enter}');
  const restored = await page.findByRole('link', { name: 'Izzet Phoenix' });
  await waitFor(() => expect(document.activeElement).toBe(restored));
});

it('sorts by win rate, games, mulligans and game length, and shows the opening hands of a selection', async () => {
  const user = userEvent.setup();
  const rows = [
    { ...izzet, id: 'a', name: 'UR Aggro', n: 10, wins: 4, games: 25, mulliganKnown: 20, mulliganGames: 2, timedGames: 25, durationMs: 25 * 600_000 },
    { ...izzet, id: 'b', name: 'Red Deck Wins', n: 6, wins: 5, games: 14, mulliganKnown: 14, mulliganGames: 7, timedGames: 14, durationMs: 14 * 900_000 },
    { ...izzet, id: 'c', name: 'Lotus Field', n: 2, wins: 1, games: 5, mulliganKnown: 0, timedGames: 0, durationMs: 0 },
  ];
  const { page } = show('/statistics', (request) => ({
    formats: ['Pioneer'],
    matches: 9,
    rows,
    selected:
      request.searchParams.get('selected') === 'b'
        ? { ...rows[1], mulligans: 9, keptGames: 7, keptWins: 5, mulliganWins: 3, source: 'https://www.mtgtop8.com/archetype?a=862&f=PI', matchups: [rows[0]] }
        : null,
  }));
  const order = () => page.getAllByRole('rowheader').map((cell) => within(cell).getByRole('link').textContent);
  await page.findByRole('link', { name: 'UR Aggro' });
  expect(order()).toEqual(['UR Aggro', 'Red Deck Wins', 'Lotus Field']);
  const header = (name: RegExp) => page.getByRole('link', { name });
  await user.click(header(/Sort by Win %/));
  expect(order()).toEqual(['Red Deck Wins', 'Lotus Field', 'UR Aggro']);
  expect(page.getByRole('columnheader', { name: /Win %/ }).getAttribute('aria-sort')).toBe('descending');
  await user.click(header(/Sort by Win %/));
  expect(order()).toEqual(['UR Aggro', 'Lotus Field', 'Red Deck Wins']);
  await user.click(header(/Sort by Games with at least one mulligan/));
  expect(order()).toEqual(['Red Deck Wins', 'UR Aggro', 'Lotus Field']);
  await user.click(header(/Sort by Average game length/));
  expect(order()).toEqual(['Red Deck Wins', 'UR Aggro', 'Lotus Field']);
  const red = page.getByRole('link', { name: 'Red Deck Wins' }).closest('tr')!;
  expect(within(red).getByText('50%')).toBeTruthy();
  expect(within(red).getByText('15 min')).toBeTruthy();
  await user.click(page.getByRole('link', { name: 'Red Deck Wins' }));
  const hands = await page.findByRole('region', { name: 'Opening hands' });
  expect(within(hands).getByText('Win % keeping seven').nextElementSibling?.textContent).toBe('71.4% 7 games');
  expect(within(hands).getByText('Win % after a mulligan').nextElementSibling?.textContent).toBe('42.9% 7 games');
  expect(page.getByRole('link', { name: /Archetype on MTGTop8/ }).getAttribute('href')).toContain('a=862');
});

it.each([
  ['deck', 'Initial deck palette (Blue, Green)', 'How are deck colors determined?'],
  ['archetype', 'Common archetype palette (Blue, Green)', 'How are archetype colors determined?'],
] as const)(
  'explains a blue-green palette on a Mono-Green label in the %s report',
  async (group, label, summary) => {
    const green = { ...izzet, name: 'Mono-Green Devotion', colors: ['G', 'U'] };
    const { page } = show('/statistics?group=' + group, () => ({
      formats: ['Pioneer'],
      matches: 2,
      rows: [green],
      selected: null,
    }));
    const icon = await page.findByRole('img', { name: label, description: /hybrid.*basic lands/i });
    expect(icon.getAttribute('title')).toBe(label);
    const disclosure = page.getByText(summary).closest('details')!;
    expect(disclosure.open).toBe(false);
    fireEvent.click(page.getByText(summary));
    expect(disclosure.open).toBe(true);
    expect(disclosure.textContent).toMatch(/declared colors.*main deck.*typical archetype palette/i);
    expect(disclosure.textContent).toMatch(
      group === 'archetype' ? /records for the archetype agree/i : /records for the same decklist agree/i,
    );
  },
);
