import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { PlatformAdmin } from './PlatformAdmin';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const account = (username: string, extra = {}) => ({
  id: username + '-id', username, email: null, enabled: true, tournamentAdmin: false,
  personalDecks: 1, agentDecks: 2, unclassifiedDecks: 1, humanMatches: 3, lastHumanGameAt: null, sessionExpiresAt: null,
  players: [], grants: [], ...extra,
});

function mount(status = 200) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (status !== 200) return new Response('{}', { status });
    if (url.endsWith('/admin/accounts'))
      return Response.json({
        accounts: [
          account('Felipe', {
            tournamentAdmin: true,
            players: [{ id: 'p1', displayName: 'Áurea', flag: null, mcpEnabled: true, provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high', retiredAt: null, engineName: 'mcp_pcd24bcbdf54a41e38c', matches: 9, lastGameAt: null, decks: 2 }],
            grants: [{ engineName: 'CodexRival', scopes: ['play', 'chat'], oauthManaged: false, playerId: null, createdAt: '2026-11-20T00:00:00Z', revokedAt: null }],
          }),
          account('Roberto'),
        ],
        totals: { accounts: 2, enabledAccounts: 2, players: 1, activeGrants: 1 },
      });
    if (url.endsWith('/admin/decks/unclassified'))
      return Response.json({
        decks: [{ accountId: 'Roberto-id', username: 'Roberto', deckId: 'brew', library: 'personal', name: 'Brew', format: 'Pioneer', playerName: null, mainCount: 60 }],
        archetypes: { Pioneer: ['Red Deck Wins', 'UR Aggro', 'Other'] },
      });
    if (init?.method === 'PUT') return Response.json({ archetype: JSON.parse(String(init.body)).archetype });
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PlatformAdmin />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { page, fetch };
}

it('lists accounts with their MCP players and grants, filters them, and assigns a missing archetype', async () => {
  const user = userEvent.setup();
  const { page, fetch } = mount();
  const felipe = (await page.findByText('Felipe')).closest('details')!;
  await user.click(within(felipe).getByText('Felipe'));
  const players = within(felipe).getByRole('table', { name: 'MCP players (subagents)' });
  expect(within(players).getByText('Áurea')).toBeTruthy();
  expect(within(players).getByText('mcp_pcd24bcbdf54a41e38c')).toBeTruthy();
  expect(within(felipe).getByRole('table', { name: 'Agent grants' }).textContent).toContain('play, chat');
  await user.type(page.getByRole('searchbox', { name: /Search accounts/ }), 'áurea');
  expect(page.queryByText('Roberto', { selector: 'strong' })).toBeNull();
  await user.selectOptions(page.getByRole('combobox', { name: 'Archetype for Brew' }), 'Red Deck Wins');
  expect(within(page.getByRole('combobox', { name: 'Archetype for Brew' })).queryByRole('option', { name: 'Other' })).toBeNull();
  await user.click(page.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(fetch.mock.calls.some(([url, init]) => url === '/api/playtesting/admin/decks/Roberto-id/brew/archetype' && init?.method === 'PUT')).toBe(true),
  );
});

it('tells a signed-in member that the page is for administrators', async () => {
  const { page } = mount(403);
  expect(await page.findByRole('alert')).toHaveProperty('textContent', 'Only platform administrators can open this page.');
});
