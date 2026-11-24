import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { PublicBroadcast } from '../ui/usePlayerIdentity';
import { PlayerLabel } from '../ui/PlayerLabel';
import { SettingsDialog } from './SettingsDialog';

vi.mock('../playtesting', async (original) => ({ ...await original<typeof import('../playtesting')>(), PRIVATE_PLAYTESTING: true }));
vi.mock('../queries', async (original) => ({ ...await original<typeof import('../queries')>(), useServerInfo: () => ({ data: { accounts: false } }) }));
afterEach(() => vi.unstubAllGlobals());

const endpoint = '/api/playtesting/players';
const base = { playerId: 'pilot', engineName: 'mcp_p123456789012345678', displayName: 'Koru', flag: 'CL', mcpEnabled: true, availability: 'available' };

async function openSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><SettingsDialog open onOpenChange={() => {}} /></MemoryRouter></QueryClientProvider>);
  await userEvent.click(screen.getByRole('tab', { name: 'MCP players' }));
}

test('[PM-PLAYER-SETTINGS-01] an owner creates, edits and removes a player through settings', async () => {
  const players = new Map([[base.playerId, base]]);
  const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
    const id = url.slice(endpoint.length + 1);
    if (url === endpoint && (!init.method || init.method === 'GET')) return Response.json({ players: [...players.values()] });
    if (url === endpoint && init.method === 'POST') {
      const player = { ...base, ...JSON.parse(String(init.body)), playerId: 'new' };
      players.set('new', player);
      return Response.json(player, { status: 201 });
    }
    if (players.has(id) && init.method === 'PATCH') {
      const player = { ...players.get(id), ...JSON.parse(String(init.body)) };
      players.set(id, player);
      return Response.json(player);
    }
    if (players.has(id) && init.method === 'DELETE') {
      players.delete(id);
      return Response.json({ playerId: id });
    }
    throw Error('Unexpected request');
  });
  vi.stubGlobal('fetch', fetcher);
  await openSettings();
  expect(await screen.findByText('Koru')).toBeTruthy();
  expect(screen.getByText(/share the same deck library/i)).toBeTruthy();

  await userEvent.click(screen.getByRole('button', { name: 'Add player' }));
  let form = within(screen.getByRole('dialog', { name: 'Add player' }));
  fireEvent.change(form.getByLabelText('Player name'), { target: { value: 'Senda' } });
  expect(form.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  await userEvent.click(form.getByRole('button', { name: 'Create player' }));
  expect(await screen.findByText('Senda')).toBeTruthy();
  expect(players.get('new')).toMatchObject({ flag: null, mcpEnabled: true });

  await userEvent.click(screen.getByRole('button', { name: 'Edit Koru' }));
  form = within(screen.getByRole('dialog', { name: 'Edit Koru' }));
  fireEvent.change(form.getByLabelText('Player name'), { target: { value: 'Junco' } });
  await userEvent.click(form.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByText('Junco')).toBeTruthy();
  expect(players.get('pilot')).toMatchObject({ displayName: 'Junco', flag: 'CL', mcpEnabled: true });

  await userEvent.click(screen.getByRole('button', { name: 'Remove Junco' }));
  await userEvent.click(within(screen.getByRole('dialog', { name: 'Remove Junco?' })).getByRole('button', { name: 'Cancel' }));
  expect(players.has('pilot')).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'Remove Junco' }));
  await userEvent.click(within(screen.getByRole('dialog', { name: 'Remove Junco?' })).getByRole('button', { name: 'Remove player' }));
  expect(await screen.findByRole('button', { name: 'Edit Senda' })).toBeTruthy();
  expect(screen.queryByText('Junco')).toBeNull();
});

test('[PM-PLAYER-SETTINGS-01] retries listing and keeps the edit draft on failure', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ players: [{ ...base, availability: 'reserved' }] }))
    .mockResolvedValueOnce(Response.json({}, { status: 409 }));
  vi.stubGlobal('fetch', fetcher);
  await openSettings();
  await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Reserved')).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Remove Koru' }).disabled).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'Edit Koru' }));
  const form = within(screen.getByRole('dialog', { name: 'Edit Koru' }));
  fireEvent.change(form.getByLabelText('Player name'), { target: { value: 'Canelo' } });
  await userEvent.click(form.getByRole('button', { name: 'Save changes' }));
  expect(await form.findByRole('alert')).toBeTruthy();
  expect(form.getByRole<HTMLInputElement>('textbox', { name: 'Player name' }).value).toBe('Canelo');
});

test('[PM-MCP-PLAYER-VIEW-MODEL] an owner sets and clears optional model markers', async () => {
  let profile: typeof base & { provider?: string | null; model?: string | null; reasoningEffort?: string | null } = { ...base };
  const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.startsWith('/api/playtesting/player-identities?')) return Response.json({ players: [] });
    if (url === endpoint) return Response.json({ players: [profile] });
    if (url === endpoint + '/pilot' && init.method === 'PATCH') {
      profile = { ...profile, ...JSON.parse(String(init.body)) };
      return Response.json(profile);
    }
    throw Error('Unexpected request');
  });
  vi.stubGlobal('fetch', fetcher);
  await openSettings();
  await userEvent.click(await screen.findByRole('button', { name: 'Edit Koru' }));
  let form = within(screen.getByRole('dialog', { name: 'Edit Koru' }));
  await userEvent.selectOptions(form.getByLabelText('Provider (optional)'), 'claude');
  fireEvent.change(form.getByLabelText('Model (optional)'), { target: { value: 'Claude Sonnet' } });
  expect(form.getByText('Enter the model ID without spaces.')).toBeTruthy();
  expect(form.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(true);
  fireEvent.change(form.getByLabelText('Model (optional)'), { target: { value: ' claude-sonnet-5-5 ' } });
  fireEvent.change(form.getByLabelText('Reasoning effort (optional)'), { target: { value: 'high' } });
  await userEvent.click(form.getByRole('button', { name: 'Save changes' }));

  expect(await screen.findByRole('img', { name: 'Claude' })).toBeTruthy();
  expect(screen.getByText('claude-sonnet-5-5')).toBeTruthy();
  expect(profile).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'high' });

  await userEvent.click(screen.getByRole('button', { name: 'Edit Koru' }));
  form = within(screen.getByRole('dialog', { name: 'Edit Koru' }));
  expect(form.getByLabelText<HTMLInputElement>('Reasoning effort (optional)').value).toBe('high');
  await userEvent.selectOptions(form.getByLabelText('Provider (optional)'), '');
  fireEvent.change(form.getByLabelText('Model (optional)'), { target: { value: '' } });
  fireEvent.change(form.getByLabelText('Reasoning effort (optional)'), { target: { value: '' } });
  await userEvent.click(form.getByRole('button', { name: 'Save changes' }));
  await screen.findByRole('button', { name: 'Edit Koru' });
  expect(profile).toMatchObject({ provider: null, model: null, reasoningEffort: null });
  expect(screen.queryByRole('img', { name: 'Claude' })).toBeNull();
});


test('[PM-PLAYER-SETTINGS-01] renaming a player refreshes mounted private labels and preserves broadcast aliases', async () => {
  let profile = { ...base };
  const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.startsWith('/api/playtesting/player-identities?')) {
      return Response.json({ players: [{ name: profile.engineName, displayName: profile.displayName, flag: profile.flag, isMcp: true }] });
    }
    if (url === endpoint) return Response.json({ players: [profile] });
    if (url === endpoint + '/pilot' && init.method === 'PATCH') {
      profile = { ...profile, ...JSON.parse(String(init.body)) };
      return Response.json(profile);
    }
    throw Error('Unexpected request');
  });
  vi.stubGlobal('fetch', fetcher);
  const labels = render(<>
    <div data-testid="private"><PlayerLabel name={base.engineName.toUpperCase()} /></div>
    <div data-testid="broadcast"><PublicBroadcast.Provider value={true}><PlayerLabel name={base.engineName} displayName="Seat B" /></PublicBroadcast.Provider></div>
  </>);
  const privateLabel = within(labels.getByTestId('private'));
  const broadcastLabel = within(labels.getByTestId('broadcast'));
  await privateLabel.findByText('Koru');
  await openSettings();
  await userEvent.click(await screen.findByRole('button', { name: 'Edit Koru' }));
  const form = within(screen.getByRole('dialog', { name: 'Edit Koru' }));
  fireEvent.change(form.getByLabelText('Player name'), { target: { value: 'Arrayán' } });
  fireEvent.change(form.getByLabelText('Country code (optional)'), { target: { value: 'AR' } });
  await userEvent.click(form.getByRole('button', { name: 'Save changes' }));
  expect(await privateLabel.findByText('Arrayán')).toBeTruthy();
  expect(broadcastLabel.getByText('Seat B')).toBeTruthy();
});
