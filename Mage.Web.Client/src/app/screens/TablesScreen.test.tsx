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
  useSession: Object.assign((pick: (state: object) => unknown) => pick({ userName: 'Host', roomId, phase: 'signedIn' }), { subscribe: vi.fn() }),
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
  const [, request] = fetcher.mock.calls.find(([url]) => url === '/api/playtesting/invites')!;
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
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === '/api/playtesting/invites')).toHaveLength(1));
  const [, request] = fetcher.mock.calls.find(([url]) => url === '/api/playtesting/invites')!;
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

test.each([
  ['OtherOwner', 'guestAccountName'],
  ['b7aa9a78-f0e4-41f5-9085-d5133c571f1d', 'guestPlayerId'],
])('[PM-AC-16] the host addresses a private table to %s', async (recipient, field) => {
  tables = [];
  calls.create.mockResolvedValue({ tableId });
  calls.join.mockResolvedValue(true);
  const fetcher = vi.fn<(_url: string, _options?: RequestInit) => Promise<Response>>(async () => Response.json({ tables: [] }));
  vi.stubGlobal('fetch', fetcher);
  const { page } = mount({ host: deck.id, opponent: 'mcp' });
  const guide = within(await page.findByRole('dialog', { name: 'Connect to Thoughtseize MCP' }));
  fireEvent.click(guide.getByRole('button', { name: 'Continue' }));
  const dialog = within(await page.findByRole('dialog', { name: 'Host a table' }));
  fireEvent.change(dialog.getByRole('textbox', { name: 'Invited account or MCP player ID' }), { target: { value: recipient } });
  fireEvent.click(dialog.getByRole('button', { name: /^Host$/ }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === '/api/playtesting/invites')).toBe(true));
  const [, request] = fetcher.mock.calls.find(([url]) => url === '/api/playtesting/invites')!;
  expect(JSON.parse(String(request?.body))).toMatchObject({ tableId, mode: 'mcp', [field]: recipient });
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
  expect(dialog.getByText('Leave empty to invite your own account.')).toBeTruthy();
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

test.each([[undefined, 'Felipe'], [tableId, 'Angels']] as const)('[PM-AC-04] the seated MCP label for %s is %s and Start follows the engine state', async (guestPlayerId, expected) => {
  tables = [{ tableId, tableName: 'Pioneer fixture', controllerName: 'Host', tableState: 'WAITING', seats: [{ playerName: 'Host', playerType: 'HUMAN' }, {}] }];
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tableId, mode: 'mcp', guestEngineName: 'FixtureAgent', guestDisplayName: 'Angels', guestOwnerName: 'Felipe', guestPlayerId })));
  const { page, update } = mount();
  await page.findByText('Waiting for Rival MCP');
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  fireEvent.click(page.getByRole('button', { name: 'Copy MCP link' }));
  expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/join/${tableId}`);
  fireEvent.click(page.getByRole('button', { name: 'Copy table ID' }));
  expect(writeText).toHaveBeenLastCalledWith(tableId);
  expect(page.getByRole('button', { name: 'Agent guide' })).toBeTruthy();
  expect((page.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
  tables = [{ ...tables[0], tableState: 'READY_TO_START', seats: [{ playerName: 'Host', playerType: 'HUMAN' }, { playerName: 'FixtureAgent', playerType: 'HUMAN' }] }];
  update();
  await page.findByText('Rival MCP ready');
  expect(page.getByText(expected)).toBeTruthy();
  expect(page.getByText('MCP')).toBeTruthy();
  expect(page.queryByText(expected === 'Felipe' ? 'Angels' : 'Felipe')).toBeNull();
  expect((page.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false);
});

test('the host opts in to human MCP control for just this match', async () => {
  tables = [];
  friends = [];
  calls.create.mockResolvedValue({ tableId });
  calls.join.mockResolvedValue(true);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
  const { page } = mount();
  fireEvent.click(page.getByRole('button', { name: 'Host a table' }));
  const dialog = within(await page.findByRole('dialog', { name: 'Host a table' }));
  const toggle = dialog.getByRole('switch', { name: 'Give the MCP agent my seat and watch from the browser' });
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  fireEvent.click(toggle);
  fireEvent.click(dialog.getByRole('button', { name: /^Host$/ }));
  await waitFor(() => expect(calls.create).toHaveBeenCalledWith(roomId, expect.objectContaining({ humanMcpAllowed: true })));
  await waitFor(() => expect(page.queryByRole('dialog')).toBeNull());
  fireEvent.click(page.getByRole('button', { name: 'Host a table' }));
  expect(page.getByRole('switch', { name: 'Give the MCP agent my seat and watch from the browser' }).getAttribute('aria-checked')).toBe('false');
});

test('a delegated host can start the table while close and table chat input stay locked', async () => {
  tables = [{ tableId, tableName: 'Delegated', controllerName: 'Host', tableState: 'READY_TO_START', seats: [{ playerName: 'Host', playerType: 'HUMAN' }] }];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/human-seat/')
    ? { tableId, humanName: 'Host', humanMcpAllowed: true } : {})));
  const { page } = mount();
  await page.findByText('Player controlled by MCP · Read only');
  expect(page.queryByRole('button', { name: 'Close' })).toBeNull();
  expect((page.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false);
});


test('the account owner can copy the spectator link for an unlisted MCP table before game one', async () => {
  tables = [];
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  const fetcher = vi.fn(async (url: string) => {
    if (url === '/api/playtesting/tables/spectator-links') return Response.json({ tables: [{ tableId, tableName: 'Luna fixture' }] });
    if (url === '/api/playtesting/tables/' + tableId + '/spectator-link') return Response.json({ path: '/watch/public-fixture' });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetcher);
  const { page } = mount();
  const button = await page.findByRole('button', { name: 'Copy spectator link' });
  expect(page.getByText('Luna fixture')).toBeTruthy();
  expect(page.getByRole('button', { name: 'Watch match' })).toBeTruthy();
  expect(button.getAttribute('title')).toContain('public board');
  fireEvent.click(button);
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(window.location.origin + '/watch/public-fixture'));
});
