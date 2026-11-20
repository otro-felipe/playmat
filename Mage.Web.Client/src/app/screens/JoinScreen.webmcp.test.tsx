import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { JoinScreen } from './JoinScreen';

const tableId = '22222222-2222-4222-8222-222222222222';
const inviteUrl = `/api/playtesting/invites/${tableId}`;
const refetch = vi.fn();
const getTable = vi.fn<(room: string, tableId: string) => Promise<typeof table>>(async () => table);
const select = vi.fn();
const joinTable = vi.fn(async () => undefined);
const roster = [{ id: 'first', name: 'First deck' }, { id: 'second', name: 'Second deck' }];
const session = { userName: 'Guest', phase: 'signedIn', connection: 'open', roomId: 'room', serverUrl: '' };
const matchingInvite = { mode: 'friend', guestEngineName: 'gUeSt' };
const fixturePassword = 'fixture-password';
const table = { tableId, tableName: 'Pioneer test', tableState: 'WAITING', passworded: true, seats: [{ playerName: 'Host' }, {}] };
let listedTables = [table];

type SiteTool = {
  name: string;
  execute: (input: Record<string, unknown>, options?: { signal: AbortSignal }) => Promise<unknown>;
};
const tools = new Map<string, SiteTool>();
const registerTool = vi.fn((tool: SiteTool, { signal }: { signal: AbortSignal }) => {
  tools.set(tool.name, tool);
  signal.addEventListener('abort', () => tools.delete(tool.name), { once: true });
});

vi.mock('../playtesting', async (original) => ({ ...await original<typeof import('../playtesting')>(), PRIVATE_PLAYTESTING: true }));
vi.mock('../connection', () => ({
  api: { roomGetTableById: (...args: [string, string]) => getTable(...args), recoveryList: async () => [] },
}));
vi.mock('../queries', () => ({
  useTables: () => ({ data: listedTables, dataUpdatedAt: Infinity, refetch }),
}));
vi.mock('../stores/session', () => ({
  useSession: Object.assign((pick: (state: typeof session) => unknown) => pick(session), { subscribe: vi.fn() }),
}));
vi.mock('../stores/decks', () => ({ useDecks: () => ({ loaded: true, selectedId: 'first', select }) }));
vi.mock('../stores/useDeckRoster', () => ({ useDeckRoster: () => roster }));
vi.mock('./joinTable', () => ({ joinTable: (...args: unknown[]) => joinTable(...(args as [])) }));

beforeEach(() => {
  tools.clear();
  listedTables = [table];
  session.phase = 'signedIn';
  session.connection = 'open';
  session.serverUrl = window.location.origin.replace(/^http/, 'ws') + '/ws';
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('location', window.location);
  Object.defineProperty(document, 'modelContext', { configurable: true, value: { registerTool } });
});

test('[PM-SETUP-AC-03] an unlisted table opens from its link while absent from the lobby', async () => {
  listedTables = [];
  const page = mount({ mode: 'friend', guestEngineName: null, unlisted: true });
  const join = await page.findByRole('button', { name: 'Take a seat' });
  expect(getTable).toHaveBeenCalledWith(session.roomId, tableId);
  expect(page.fetch.mock.calls.some(([uri]) => uri === `${inviteUrl}/claim`)).toBe(false);
  fireEvent.click(join);
  expect(await page.findByText('Tables route')).toBeTruthy();
  expect(joinTable).toHaveBeenCalledWith(table, 'first', fixturePassword, undefined);
});

afterEach(() => {
  Reflect.deleteProperty(document, 'modelContext');
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function mount(invitation: object | null = matchingInvite, claim?: () => Promise<Response>) {
  const fetch = vi.fn(async (uri: string) => {
    if (uri === `${inviteUrl}/claim`) return claim?.() ?? Response.json({ tableId, password: fixturePassword });
    return invitation ? Response.json(invitation) : new Response('', { status: 404 });
  });
  vi.stubGlobal('fetch', fetch);
  const page = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[`/join/${tableId}`]}>
        <Routes>
          <Route path="/join/:tableId" element={<JoinScreen />} />
          <Route path="/tables" element={<p>Tables route</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...page, fetch };
}

test('[PM-AC-04] the invited guest can use WebMCP to take the seat with the selected deck', async () => {
  const page = mount();
  const selector = await page.findByRole('combobox', { name: 'Deck' });
  fireEvent.change(selector, { target: { value: 'second' } });
  await waitFor(() => expect(tools.has('join_match')).toBe(true));
  const tool = tools.get('join_match')!;

  await act(async () => {
    expect(await tool.execute({})).toEqual({ joined: true, tableId });
  });

  expect(page.fetch).toHaveBeenCalledWith(`${inviteUrl}/claim`, expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }));
  expect(joinTable).toHaveBeenCalledWith(table, 'second', fixturePassword, expect.any(AbortSignal));
  expect(select).toHaveBeenCalledWith('second');
  expect(await page.findByText('Tables route')).toBeTruthy();
  expect(tools.has('join_match')).toBe(false);
});

test.each([
  ['someone else’s invite', { mode: 'friend', guestEngineName: 'Other' }],
  ['a missing invite', null],
  ['a delegated remote MCP seat', { mode: 'mcp' }],
])('[PM-AC-04] WebMCP exposes no browser seat for %s', async (_, invitation) => {
  const page = mount(invitation);
  await page.findByText('Pioneer test');
  expect(registerTool).not.toHaveBeenCalled();
  expect(joinTable).not.toHaveBeenCalled();
});

test('[PM-AC-04] WebMCP waits until the invite metadata arrives and the session is connected', async () => {
  session.connection = 'reconnecting';
  const page = mount();
  expect(page.getByText('Looking for the table…')).toBeTruthy();
  expect(registerTool).not.toHaveBeenCalled();
  await page.findByText('Pioneer test');
  expect(registerTool).not.toHaveBeenCalled();
});

test('[PM-AC-04] WebMCP prevents a second claim and cancellation before the seat operation', async () => {
  const controller = new AbortController();
  let resolveClaim!: (response: Response) => void;
  const page = mount(matchingInvite, () => new Promise<Response>((resolve) => { resolveClaim = resolve; }));
  await waitFor(() => expect(tools.has('join_match')).toBe(true));
  const tool = tools.get('join_match')!;
  await act(async () => {
    const invoking = tool.execute({}, { signal: controller.signal });
    expect(await tool.execute({})).toEqual(expect.objectContaining({ error: expect.any(String) }));
    controller.abort();
    resolveClaim(Response.json({ tableId, password: fixturePassword }));
    await expect(invoking).rejects.toMatchObject({ name: 'AbortError' });
  });

  expect(page.fetch.mock.calls.filter(([uri]) => uri === `${inviteUrl}/claim`)).toHaveLength(1);
  expect(joinTable).not.toHaveBeenCalled();
  expect(page.getByRole('button', { name: 'Take a seat' })).not.toHaveProperty('disabled', true);
});
