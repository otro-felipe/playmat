import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { PublicStatistics } from './PublicStatistics';

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
  expect(within(row).getByRole('img', { name: 'Blue, Red' })).toBeTruthy();
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
  expect(page.getByRole('link', { name: 'League' }).getAttribute('href')).toBe('/tournaments/cup');
  expect(page.getByRole('img', { name: 'Unknown colors' })).toBeTruthy();
  expect(page.getByRole('img', { name: 'Colorless' })).toBeTruthy();
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
  expect(page.getAllByRole('img', { name: 'Unknown colors' })).toHaveLength(2);
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

it('preserves grouping and format across scopes and clears the tournament selection', async () => {
  const { page, fetch } = show(
    '/tournaments/cup/statistics?group=deck&format=Pioneer&selected=public-deadbeef',
    (request) => ({
      formats: ['Pioneer'],
      matches: 2,
      rows: [deck],
      tournamentName: 'League',
      selected: request.searchParams.has('selected') ? { ...deck, matchups: [] } : null,
    }),
  );
  await page.findByRole('heading', { name: /Anonymous deck/i });
  const globalLink = page.getByRole('link', { name: 'Global statistics' });
  expect(globalLink.getAttribute('href')).toBe('/statistics?group=deck&format=Pioneer');
  fireEvent.click(globalLink);
  await page.findByRole('heading', { name: 'Global statistics' });
  expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/playtesting/statistics?group=deck&format=Pioneer');
});
