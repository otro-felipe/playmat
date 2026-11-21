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
let friends: string[];
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
vi.mock('../stores/social', () => ({
  useSocial: Object.assign((pick: (state: { friends: string[] }) => unknown) => pick({ friends }), {
    getState: () => ({ ignored: [] }),
  }),
}));
vi.mock('../ui/imageCache', () => ({ warmDeck: vi.fn() }));
vi.mock('../social/LevelBadge', () => ({ NameLevel: () => null }));

afterEach(() => {
  friends = [];
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('[PM-SETUP-AC-02] the host selects a saved friend for the invitation', async () => {
  tables = [];
  friends = ['Guest', 'OtherFriend'];
  calls.create.mockResolvedValue({ tableId });
  calls.join.mockResolvedValue(true);
  const fetcher = vi.fn<(url: string, request: RequestInit) => Promise<Response>>(async () => Response.json({}, { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  const { page } = mount();
  fireEvent.click(page.getByRole('button', { name: 'Host a table' }));
  const dialog = within(await page.findByRole('dialog', { name: 'Host a table' }));
  const selector = dialog.getByRole('combobox', { name: 'Invited player' });
  expect(within(selector).getAllByRole('option').map(option => option.textContent)).toEqual([
    'Anyone with the link', 'Guest', 'OtherFriend',
  ]);
  fireEvent.change(selector, { target: { value: 'Guest' } });
  fireEvent.click(dialog.getByRole('button', { name: /^Host$/ }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/playtesting/invites', expect.objectContaining({ method: 'POST' })));
  const [, request] = fetcher.mock.calls[0];
  expect(JSON.parse(String(request.body))).toMatchObject({ tableId, mode: 'friend', guestEngineName: 'Guest' });
});

test('[PM-SETUP-AC-03] the host can create a link-only invitation with an empty friends list', async () => {
  tables = [];
  friends = [];
  calls.create.mockResolvedValue({ tableId });
  calls.join.mockResolvedValue(true);
  const fetcher = vi.fn<(url: string, request: RequestInit) => Promise<Response>>(async () => Response.json({}, { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  const { page } = mount();
  fireEvent.click(page.getByRole('button', { name: 'Host a table' }));
  const dialog = within(await page.findByRole('dialog', { name: 'Host a table' }));
  const selector = dialog.getByRole<HTMLSelectElement>('combobox', { name: 'Invited player' });
  expect(selector.selectedOptions[0].textContent).toBe('Anyone with the link');
  fireEvent.click(dialog.getByRole('button', { name: /^Host$/ }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const [, request] = fetcher.mock.calls[0];
  const invite = JSON.parse(String(request.body));
  expect(invite).toMatchObject({ tableId, mode: 'friend' });
  expect(invite).not.toHaveProperty('guestEngineName');
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
  const guide = within(await page.findByRole('dialog', { name: 'Connect to Thoughtseize MCP' }));
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

test('[PM-AC-16] the host creates an account-private MCP invitation without selecting an agent', async () => {
  tables = [];
  calls.create.mockResolvedValue({ tableId });
  calls.join.mockResolvedValue(true);
  const fetcher = vi.fn(async (_url: string, request?: RequestInit) => request?.method === 'POST'
    ? Response.json({}, { status: 201 })
    : Response.json({ rivals: [] }));
  vi.stubGlobal('fetch', fetcher);
  const { page } = mount({ host: deck.id, opponent: 'mcp' });
  const guide = within(await page.findByRole('dialog', { name: 'Connect to Thoughtseize MCP' }));
  fireEvent.click(guide.getByRole('button', { name: 'Continue' }));
  const dialog = within(await page.findByRole('dialog', { name: 'Host a table' }));
  expect(dialog.queryByLabelText('Notify agent')).toBeNull();
  expect(dialog.getByText('Your connected agent can join this table.')).toBeTruthy();
  fireEvent.click(dialog.getByRole('button', { name: /^Host$/ }));
  await waitFor(() => expect(fetcher.mock.calls.some(([, request]) => request?.method === 'POST')).toBe(true));
  const [, request] = fetcher.mock.calls.find(([, request]) => request?.method === 'POST')!;
  const invite = JSON.parse(String(request?.body));
  expect(invite).toMatchObject({ tableId, mode: 'mcp' });
  expect(invite).not.toHaveProperty('notifyEngineName');
  expect(fetcher.mock.calls.every(([url]) => url !== '/api/playtesting/event-rivals')).toBe(true);
});

test('[PM-REVIEW-PRIV-1] hosting a private table requires no replay permission', async () => {
  tables = [];
  friends = ['Guest'];
  calls.create.mockResolvedValue({ tableId });
  const fetcher = vi.fn(async (url: string, request?: RequestInit) =>
    Response.json({ tableId }, { status: request?.method === 'POST' ? 201 : 200 }));
  vi.stubGlobal('fetch', fetcher);
  const { page } = mount();
  fireEvent.click(page.getByRole('button', { name: 'Host a table' }));
  const dialog = within(await page.findByRole('dialog', { name: 'Host a table' }));
  fireEvent.change(dialog.getByLabelText('Invited player'), { target: { value: 'Guest' } });
  expect(dialog.queryByRole('switch', { name: 'Share the complete replay with participants' })).toBeNull();
  fireEvent.click(dialog.getByRole('button', { name: /^Host$/ }));
  await waitFor(() => expect(calls.join).toHaveBeenCalled());
  expect(fetcher.mock.calls.every(([url]) => !url.includes('/review/privacy/'))).toBe(true);
});

test('[PM-AC-04] the play entry shows the connection guide and remembers the host’s choice', async () => {
  tables = [];
  const { page } = mount({ host: deck.id, opponent: 'mcp' });
  const guide = within(await page.findByRole('dialog', { name: 'Connect to Thoughtseize MCP' }));
  expect(guide.getByText(`${window.location.origin}/mcp`)).toBeTruthy();
  expect(guide.getByText(/Choose OAuth, sign in with your Thoughtseize account/)).toBeTruthy();
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
  expect(reopened.queryByRole('dialog', { name: 'Connect to Thoughtseize MCP' })).toBeNull();
  fireEvent.click(host.getByRole('button', { name: 'Connection guide' }));
  const manual = within(await reopened.findByRole('dialog', { name: 'Connect to Thoughtseize MCP' }));
  const saved = manual.getByRole('checkbox', { name: 'Don’t show this again' }) as HTMLInputElement;
  expect(saved.checked).toBe(true);
  fireEvent.click(saved);
  fireEvent.click(manual.getByRole('button', { name: 'Continue' }));
  reopened.unmount();

  const reset = mount({ host: deck.id, opponent: 'mcp' }).page;
  expect(await reset.findByRole('dialog', { name: 'Connect to Thoughtseize MCP' })).toBeTruthy();
});

test('[PM-AC-04] the MCP alias is visible when seated and Start follows the engine seat state', async () => {
  tables = [{ tableId, tableName: 'Pioneer fixture', controllerName: 'Host', tableState: 'WAITING', seats: [{ playerName: 'Host', playerType: 'HUMAN' }, {}] }];
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tableId, mode: 'mcp', guestEngineName: 'FixtureAgent', guestDisplayName: 'Angels', guestOwnerName: 'Felipe' })));
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
  expect(page.getByText('Felipe')).toBeTruthy();
  expect(page.getByText('MCP')).toBeTruthy();
  expect(page.queryByText('Angels')).toBeNull();
  expect((page.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false);
});
