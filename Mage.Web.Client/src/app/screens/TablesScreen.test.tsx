import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import type { TableView } from '../../protocol/generated/views';
import { TablesScreen } from './TablesScreen';

const tableId = '22222222-2222-4222-8222-222222222222';
const roomId = '33333333-3333-4333-8333-333333333333';
const deck = { id: 'fixture', name: 'Pioneer fixture', format: 'Constructed - Pioneer', cards: [], sideboard: [] };
let tables: TableView[];
const calls = vi.hoisted(() => ({ create: vi.fn(), join: vi.fn(), notify: vi.fn() }));

vi.mock('../playtesting', async (original) => ({ ...await original<typeof import('../playtesting')>(), PRIVATE_PLAYTESTING: true }));
vi.mock('../connection', () => ({ api: { roomCreateTable: calls.create, roomJoinTable: calls.join } }));
vi.mock('../queries', () => ({
  useTables: () => ({ data: tables }), useServerState: () => ({ data: {} }), refreshTables: vi.fn(),
}));
vi.mock('../stores/session', () => ({
  useSession: Object.assign((pick: (state: object) => unknown) => pick({ userName: 'Host', roomId }), { subscribe: vi.fn() }),
}));
vi.mock('../stores/decks', () => {
  const state = { selectedId: 'fixture', loaded: true, loadForPlay: async () => ({ deck }), loadList: async () => deck };
  return { useDecks: (pick?: (state: object) => unknown) => pick ? pick(state) : state };
});
vi.mock('../stores/useDeckRoster', () => ({ useDeckRoster: () => [deck] }));
vi.mock('../stores/toasts', () => ({ notify: calls.notify }));
vi.mock('../stores/social', () => ({ useSocial: { getState: () => ({ ignored: [] }) } }));
vi.mock('../ui/imageCache', () => ({ warmDeck: vi.fn() }));
vi.mock('../social/LevelBadge', () => ({ NameLevel: () => null }));

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(state?: { host: string; opponent: 'mcp' }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = () => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[{ pathname: '/tables', state }]}><TablesScreen /></MemoryRouter>
    </QueryClientProvider>
  );
  const page = render(screen());
  return { page, update: () => page.rerender(screen()) };
}

test.each(['quiet', 'chatty', 'coach'])('[PM-AC-04] the host creates a Rival MCP table in %s mode without a rival account', async (chatMode) => {
  tables = [];
  calls.create.mockResolvedValue({ tableId });
  calls.join.mockResolvedValue(true);
  const fetcher = vi.fn(async (_url: string, request?: RequestInit) => request?.method === 'POST'
    ? Response.json({ tableId }, { status: 201 })
    : Response.json({ rivals: [] }));
  vi.stubGlobal('fetch', fetcher);
  const { page } = mount();
  fireEvent.click(page.getByRole('button', { name: 'Host a table' }));
  const initial = within(await page.findByRole('dialog', { name: 'Host a table' }));
  expect(initial.getByLabelText('Invited player')).toBeTruthy();
  expect(initial.queryByLabelText('MCP chat style')).toBeNull();
  fireEvent.change(initial.getByLabelText('Opponent'), { target: { value: 'mcp' } });
  const guide = within(await page.findByRole('dialog', { name: 'Connect to Playmat MCP' }));
  fireEvent.click(guide.getByRole('button', { name: 'Continue' }));
  const dialog = within(await page.findByRole('dialog', { name: 'Host a table' }));
  expect(dialog.queryByLabelText('Invited player')).toBeNull();
  const chatStyle = dialog.getByLabelText<HTMLSelectElement>('MCP chat style');
  expect(chatStyle.value).toBe('quiet');
  if (chatMode !== 'quiet') fireEvent.change(chatStyle, { target: { value: chatMode } });
  fireEvent.click(dialog.getByRole('button', { name: /^Host$/ }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([, request]) => request?.method === 'POST')).toHaveLength(1));
  const [, request] = fetcher.mock.calls.find(([, request]) => request?.method === 'POST')!;
  const invite = JSON.parse(String(request?.body));
  expect(invite).toMatchObject({ mode: 'mcp', tableId, chatMode });
  expect(invite).not.toHaveProperty('guestEngineName');
  expect(invite).not.toHaveProperty('notifyEngineName');
});

test('[PM-AC-16] the host can notify one subscribed MCP rival while the manual link is the default', async () => {
  tables = [];
  calls.create.mockResolvedValue({ tableId });
  calls.join.mockResolvedValue(true);
  const fetcher = vi.fn(async (_url: string, request?: RequestInit) => request?.method === 'POST'
    ? Response.json({}, { status: 201 })
    : Response.json({ rivals: [{ engineName: 'MyDot' }, { engineName: 'OtherDot' }] }));
  vi.stubGlobal('fetch', fetcher);
  const { page } = mount({ host: deck.id, opponent: 'mcp' });
  const guide = within(await page.findByRole('dialog', { name: 'Connect to Playmat MCP' }));
  fireEvent.click(guide.getByRole('button', { name: 'Continue' }));
  const dialog = within(await page.findByRole('dialog', { name: 'Host a table' }));
  await dialog.findByRole('option', { name: 'MyDot' });
  const select = await dialog.findByLabelText('Notify agent') as HTMLSelectElement;
  expect(fetcher).toHaveBeenCalledWith('/api/playtesting/event-rivals', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(select.value).toBe('');
  fireEvent.change(select, { target: { value: 'MyDot' } });
  fireEvent.click(dialog.getByRole('button', { name: /^Host$/ }));
  await waitFor(() => expect(fetcher.mock.calls.some(([, request]) => request?.method === 'POST')).toBe(true));
  const [, request] = fetcher.mock.calls.find(([, request]) => request?.method === 'POST')!;
  expect(JSON.parse(String(request?.body))).toMatchObject({ tableId, mode: 'mcp', notifyEngineName: 'MyDot' });
});

test('[PM-AC-04] the play entry shows the connection guide and remembers the host’s choice', async () => {
  tables = [];
  const { page } = mount({ host: deck.id, opponent: 'mcp' });
  const guide = within(await page.findByRole('dialog', { name: 'Connect to Playmat MCP' }));
  expect(guide.getByText(`${window.location.origin}/mcp`)).toBeTruthy();
  expect(guide.getByText(/Choose OAuth, sign in with your Playmat account/)).toBeTruthy();
  expect(guide.getByText(/game\.invitation\.created and game\.decision\.required/)).toBeTruthy();
  expect(guide.getByRole('link', { name: 'Manage MCP connections' }).getAttribute('href')).toBe('/oauth/connections');
  expect(guide.getByText(/Copy MCP link/)).toBeTruthy();
  const optOut = guide.getByRole('checkbox', { name: 'Don’t show this again' }) as HTMLInputElement;
  expect(optOut.checked).toBe(false);
  fireEvent.click(optOut);
  fireEvent.click(guide.getByRole('button', { name: 'Continue' }));
  expect((within(await page.findByRole('dialog', { name: 'Host a table' })).getByLabelText('Opponent') as HTMLSelectElement).value).toBe('mcp');
  page.unmount();

  const reopened = mount({ host: deck.id, opponent: 'mcp' }).page;
  const host = within(await reopened.findByRole('dialog', { name: 'Host a table' }));
  expect(reopened.queryByRole('dialog', { name: 'Connect to Playmat MCP' })).toBeNull();
  fireEvent.click(host.getByRole('button', { name: 'Connection guide' }));
  const manual = within(await reopened.findByRole('dialog', { name: 'Connect to Playmat MCP' }));
  const saved = manual.getByRole('checkbox', { name: 'Don’t show this again' }) as HTMLInputElement;
  expect(saved.checked).toBe(true);
  fireEvent.click(saved);
  fireEvent.click(manual.getByRole('button', { name: 'Continue' }));
  reopened.unmount();

  const reset = mount({ host: deck.id, opponent: 'mcp' }).page;
  expect(await reset.findByRole('dialog', { name: 'Connect to Playmat MCP' })).toBeTruthy();
});

test('[PM-AC-04] the MCP alias is visible when seated and Start follows the engine seat state', async () => {
  tables = [{ tableId, tableName: 'Pioneer fixture', controllerName: 'Host', tableState: 'WAITING', seats: [{ playerName: 'Host', playerType: 'HUMAN' }, {}] }];
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tableId, mode: 'mcp', guestEngineName: 'FixtureAgent', guestDisplayName: 'Angels' })));
  const { page, update } = mount();
  await page.findByText('Waiting for Rival MCP');
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  fireEvent.click(page.getByRole('button', { name: 'Copy MCP link' }));
  expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/join/${tableId}`);
  expect(page.getByRole('button', { name: 'Agent guide' })).toBeTruthy();
  expect((page.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
  tables = [{ ...tables[0], tableState: 'READY_TO_START', seats: [{ playerName: 'Host', playerType: 'HUMAN' }, { playerName: 'FixtureAgent', playerType: 'HUMAN' }] }];
  update();
  await page.findByText('Rival MCP ready');
  expect(page.getByText('Angels')).toBeTruthy();
  expect((page.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false);
});
