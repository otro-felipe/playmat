import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { useLobby } from '../stores/lobby';
import { useSession } from '../stores/session';
import { ProfileDialog } from './ProfileDialog';

vi.mock('../playtesting', async (original) => ({ ...await original<object>(), PRIVATE_PLAYTESTING: true }));

afterEach(() => {
  cleanup();
  useLobby.getState().openProfile(null);
  useSession.setState({ userName: '' });
  vi.unstubAllGlobals();
});

function openProfile(name: string, respond: (owner: string) => Response) {
  const fetcher = vi.fn(async (input: string) => {
    if (input.startsWith('/api/playtesting/player-identities?')) return Response.json({ players: [] });
    const url = '/api/playtesting/tournaments/profile/';
    if (input.startsWith(url)) return respond(input.slice(url.length));
    throw Error('Unexpected endpoint');
  });
  vi.stubGlobal('fetch', fetcher);
  useSession.setState({ userName: 'Felipe' });
  useLobby.getState().openProfile(name);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = render(<QueryClientProvider client={client}><MemoryRouter><ProfileDialog /></MemoryRouter></QueryClientProvider>);
  return { ...ui, fetcher };
}

test('own and other human profiles show their registered agents before their first match', async () => {
  const { findByRole, queryByText, fetcher } = openProfile('Felipe', (owner) => Response.json({
    owner, agents: [{ id: 'test-agent', name: owner === 'Felipe' ? 'New pilot' : 'Other pilot' }],
    participations: [], trophies: [],
  }));
  const roster = await findByRole('region', { name: 'Agents' });
  expect(await within(roster).findByText('New pilot')).toBeTruthy();
  act(() => useLobby.getState().openProfile('Roberto'));
  expect(await within(roster).findByText('Other pilot')).toBeTruthy();
  expect(queryByText('New pilot')).toBeNull();
  expect(within(roster).queryByRole('button')).toBeNull();
  expect(within(roster).queryByRole('link')).toBeNull();
  expect(fetcher.mock.calls.some(([path]) => path.startsWith('/api/playtesting/players'))).toBe(false);
});

test('a profile with an unavailable roster can retry and then show the empty state', async () => {
  let available = false;
  const { findByRole } = openProfile('Felipe', () => available
    ? Response.json({ owner: 'Felipe', agents: [], participations: [], trophies: [] })
    : new Response(null, { status: 503 }));
  const roster = await findByRole('region', { name: 'Agents' });
  expect(await within(roster).findByRole('alert')).toBeTruthy();
  available = true;
  fireEvent.click(within(roster).getByRole('button', { name: 'Retry' }));
  expect(await within(roster).findByText('No agents registered.')).toBeTruthy();
});
