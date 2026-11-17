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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = () => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter><TablesScreen /></MemoryRouter>
    </QueryClientProvider>
  );
  const page = render(screen());
  return { page, update: () => page.rerender(screen()) };
}

test('[PM-AC-04] the host creates a Rival MCP table without entering a player account', async () => {
  tables = [];
  calls.create.mockResolvedValue({ tableId });
  calls.join.mockResolvedValue(true);
  const fetcher = vi.fn(async () => Response.json({ tableId }, { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  const { page } = mount();
  fireEvent.click(page.getByRole('button', { name: 'Host a table' }));
  const dialog = within(await page.findByRole('dialog', { name: 'Host a table' }));
  expect(dialog.getByLabelText('Invited player')).toBeTruthy();
  fireEvent.change(dialog.getByLabelText('Opponent'), { target: { value: 'mcp' } });
  expect(dialog.queryByLabelText('Invited player')).toBeNull();
  fireEvent.click(dialog.getByRole('button', { name: 'Host', exact: true }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const [, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  const invite = JSON.parse(String(request.body));
  expect(invite).toMatchObject({ mode: 'mcp', tableId });
  expect(invite).not.toHaveProperty('guestEngineName');
});

test('[PM-AC-04] the MCP alias is visible when seated and Start follows the engine seat state', async () => {
  tables = [{ tableId, tableName: 'Pioneer fixture', controllerName: 'Host', tableState: 'WAITING', seats: [{ playerName: 'Host', playerType: 'HUMAN' }, {}] }];
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tableId, mode: 'mcp', guestEngineName: 'FixtureAgent', guestDisplayName: 'Angels' })));
  const { page, update } = mount();
  await page.findByText('Waiting for Rival MCP');
  expect(page.getByRole('button', { name: 'Copy MCP link' })).toBeTruthy();
  expect((page.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
  tables = [{ ...tables[0], tableState: 'READY_TO_START', seats: [{ playerName: 'Host', playerType: 'HUMAN' }, { playerName: 'FixtureAgent', playerType: 'HUMAN' }] }];
  update();
  await page.findByText('Rival MCP ready');
  expect(page.getByText('Angels')).toBeTruthy();
  expect((page.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false);
});
