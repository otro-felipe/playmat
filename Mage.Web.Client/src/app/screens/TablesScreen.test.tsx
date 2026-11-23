import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from '../i18n/translate';
import spanish from '../i18n/es';
import { useI18n } from '../i18n';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import type { TableView } from '../../protocol/generated/views';
import { TablesScreen } from './TablesScreen';

const tableId = '22222222-2222-4222-8222-222222222222';
const roomId = '33333333-3333-4333-8333-333333333333';
const deck = { id: 'fixture', name: 'Pioneer fixture', format: 'Constructed - Pioneer', cards: [], sideboard: [] };
let tables: TableView[];
let friends: string[] = [];
const calls = vi.hoisted(() => ({ create: vi.fn(), join: vi.fn(), notify: vi.fn() }));

vi.mock('../playtesting', async (original) => ({ ...await original<typeof import('../playtesting')>(), PRIVATE_PLAYTESTING: true }));
vi.mock('../connection', () => ({ api: { roomCreateTable: calls.create, roomJoinTable: calls.join } }));
vi.mock('../queries', () => ({
  useTables: () => ({ data: tables }), useServerState: () => ({ data: { gameTypes: [{ name: 'Two Player Duel', minPlayers: 2, maxPlayers: 2 }] } }), refreshTables: vi.fn(),
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
  expect(invite).not.toHaveProperty('allowExternalMcp');
  expect(invite).not.toHaveProperty('guestPlayerId');
  expect(invite).not.toHaveProperty('guestAccountName');
});

test.each([
  ['en', 'Allow external players', 'Only MCP players enabled on your account can join.', 'An MCP player from another account can also join with the invitation link.'],
  ['es', 'Permitir externos', 'Solo pueden unirse los jugadores MCP habilitados en tu cuenta.', 'Un jugador MCP de otra cuenta también puede unirse con el enlace de invitación.'],
])('[PM-AC-16] %s explains the guest scope and lets the host opt in by keyboard', async (locale, label, defaultHint, externalHint) => {
  const heading = locale === 'es' ? 'Crear una mesa' : 'Host a table';
  const opponentLabel = locale === 'es' ? 'Rival' : 'Opponent';
  const originalLanguage = useI18n.getState();
  if (locale === 'es') useI18n.setState({ locale: 'es', t: createTranslator({ locale: 'es', messages: spanish, fallback: spanish }) });
  const user = userEvent.setup();
  try {
    tables = [];
    calls.create.mockResolvedValue({ tableId });
    calls.join.mockResolvedValue(true);
    const fetcher = vi.fn(async (_url: string, request?: RequestInit) => request?.method === 'POST'
      ? Response.json({}, { status: 201 })
      : Response.json({ tables: [] }));
    vi.stubGlobal('fetch', fetcher);
    const { page } = mount();
    await user.click(page.getByRole('button', { name: heading }));
    let dialog = within(await page.findByRole('dialog', { name: heading }));
    expect(dialog.queryByRole('switch', { name: label })).toBeNull();
    await user.selectOptions(dialog.getByLabelText(opponentLabel), 'mcp');
    const guide = within(await page.findByRole('dialog', { name: /Thoughtseize/ }));
    await user.click(guide.getByRole('button', { name: /Continue|Continuar/ }));
    dialog = within(await page.findByRole('dialog', { name: heading }));
    if (locale === 'es') {
      expect(dialog.getByLabelText('Nombre de la mesa').getAttribute('placeholder')).toBe('Mesa de Host');
      expect(dialog.getByLabelText<HTMLSelectElement>('Formato').selectedOptions[0].textContent).toBe('Pioneer');
      const game = dialog.getByLabelText<HTMLSelectElement>('Tipo de juego').selectedOptions[0];
      expect([game.value, game.textContent]).toEqual(['Two Player Duel', 'Duelo entre dos jugadores']);
      expect(dialog.getByLabelText<HTMLSelectElement>('Victorias necesarias').selectedOptions[0].textContent).toBe('2 (al mejor de tres)');
      expect(dialog.getByLabelText<HTMLSelectElement>('Rival').selectedOptions[0].textContent).toBe('Jugar contra MCP');
      expect(dialog.getByLabelText<HTMLSelectElement>('Estilo de chat MCP').selectedOptions[0].textContent).toBe('Silencioso');
      expect(dialog.getByRole('button', {name: 'Cancelar'})).toBeTruthy();
      await user.click(dialog.getByRole('button', {name: 'Opciones avanzadas Reglas estándar'}));
      expect(dialog.getByLabelText('Tiempo de la partida')).toBeTruthy();
      const seed = dialog.getByLabelText('Semilla');
      await user.type(seed, '77');
      expect(dialog.getByRole('button', {name: /Opciones avanzadas.*Semilla 77/})).toBeTruthy();
    }
    const toggle = dialog.getByRole('switch', { name: label, description: defaultHint, checked: false });
    expect(dialog.queryByRole('textbox', { name: /Invited account|Cuenta invitada/ })).toBeNull();
    toggle.focus();
    await user.keyboard(' ');
    expect(dialog.getByRole('switch', { name: label, description: externalHint, checked: true })).toBe(toggle);
    await user.selectOptions(dialog.getByLabelText(opponentLabel), 'friend');
    expect(dialog.queryByRole('switch', { name: label })).toBeNull();
    await user.selectOptions(dialog.getByLabelText(opponentLabel), 'mcp');
    await user.click(within(await page.findByRole('dialog', { name: /Thoughtseize/ })).getByRole('button', { name: /Continue|Continuar/ }));
    dialog = within(await page.findByRole('dialog', { name: heading }));
    await user.click(dialog.getByRole('switch', { name: label, checked: false }));
    await user.click(dialog.getByRole('button', { name: locale === 'es' ? 'Crear mesa' : 'Host' }));
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === '/api/playtesting/invites')).toBe(true));
    const [, request] = fetcher.mock.calls.find(([url]) => url === '/api/playtesting/invites')!;
    const invite = JSON.parse(String(request?.body));
    expect(invite).toMatchObject({ tableId, mode: 'mcp', allowExternalMcp: true });
    expect(invite.guestPlayerId).toBeUndefined();
    expect(invite.guestAccountName).toBeUndefined();
  } finally {
    act(() => useI18n.setState(originalLanguage));
  }
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
  expect(guide.getByText(/turn on Allow external players and share the invitation link/)).toBeTruthy();
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

test('[PM-TABLE-ROW] a waiting owner sees their table instead of an empty lobby message', async () => {
  tables = [];
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({tables:[]})));
  const {page,update} = mount();
  expect(page.getByText(/No one is waiting right now/)).toBeTruthy();
  tables = [{tableId,tableName:'Mesa del valle',controllerName:'Host',tableState:'WAITING',seats:[{playerName:'Host'},{}]}];
  update();
  expect(page.getByRole('heading',{name:'Mesa del valle'})).toBeTruthy();
  expect(page.queryByText(/No one is waiting right now/)).toBeNull();
});

test('[PM-TABLE-ROW] external invitation is retrieved on demand without exposing it in copy feedback', async () => {
  tables = [{ tableId, tableName:'External fixture', controllerName:'Host', tableState:'WAITING', seats:[{playerName:'Host'},{}] }];
  const path = '/join/mcp/' + tableId + '#invite=' + 'x'.repeat(43);
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/share-link')) { reads++; return Response.json({path}); }
    return Response.json({ tableId, mode:'mcp', allowExternalMcp:true });
  }));
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('clipboard disabled')).mockResolvedValue(undefined);
  const {page} = mount();
  const button = await page.findByRole('button', {name:'Copy external MCP invitation'});
  expect(reads).toBe(0);
  fireEvent.click(button);
  await waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(calls.notify).toHaveBeenCalled());
  expect(JSON.stringify(calls.notify.mock.calls).includes(path)).toBe(false);
  expect(document.body.textContent?.includes(path)).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(copy).toHaveBeenCalledTimes(2));
  expect(copy.mock.calls.every(([value]) => value === window.location.origin + path)).toBe(true);
  expect(reads).toBe(2);
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
  expect(page.queryByRole('switch', {name:/both hands/i})).toBeNull();
  expect(page.getByRole('button', { name: 'Watch match' })).toBeTruthy();
  expect(button.getAttribute('title')).toContain('public board');
  fireEvent.click(button);
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(window.location.origin + '/watch/public-fixture'));
});

test('an owner selects the existing both-hands link for one eligible table without granting a pilot permission', async () => {
  tables = [];
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/spectator-links')) return Response.json({ tables:[{ tableId, tableName:'Fixture', spectatorVisibility:'both-hands' }] });
    return Response.json({path:url.endsWith('?visibility=both-hands') ? '/watch/private-fixture' : '/watch/public-fixture'});
  }));
  const {page} = mount();
  const toggle = await page.findByRole('switch',{name:/both hands/i});
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(page.getByText(/anyone with this link.*both hands/i)).toBeTruthy();
  fireEvent.click(page.getByRole('button',{name:'Copy spectator link'}));
  await waitFor(()=>expect(writeText).toHaveBeenCalledWith(window.location.origin+'/watch/private-fixture'));
  fireEvent.click(toggle);
  fireEvent.click(page.getByRole('button',{name:'Copy spectator link'}));
  await waitFor(()=>expect(writeText).toHaveBeenCalledWith(window.location.origin+'/watch/public-fixture'));
});

test('an eligible owner changes the table permission independently of the spectator link and rolls back a rejected save', async () => {
  tables = [];
  let visibility = 'public-board';
  let failure = false;
  let locked = false;
  const changes: string[] = [];
  let linksRead = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/spectator-links')) return Response.json({ tables: [
      { tableId, tableName: 'Waiting fixture', spectatorVisibility: visibility, canConfigureSpectatorVisibility: !locked },
    ] });
    if (init?.method === 'PATCH') {
      const proposed = JSON.parse(String(init.body)).spectatorVisibility;
      changes.push(proposed);
      if (locked || failure) return new Response(null, { status: locked ? 409 : 503 });
      visibility = proposed;
      return Response.json({ tableId, spectatorVisibility: visibility });
    }
    if (url.includes('/spectator-link')) linksRead++;
    return Response.json({});
  }));
  const { page } = mount();
  const permission = () => page.getByRole('switch', { name: 'Show both hands to spectators' });
  const sharing = () => page.queryByRole('switch', { name: 'Share both hands with this spectator link' });
  await page.findByText('Waiting fixture');
  expect(permission().getAttribute('aria-checked')).toBe('false');
  expect(sharing()).toBeNull();
  fireEvent.click(permission());
  await waitFor(() => expect(sharing()).not.toBeNull());
  expect(sharing()?.getAttribute('aria-checked')).toBe('false');
  fireEvent.click(permission());
  await waitFor(() => expect(sharing()).toBeNull());
  failure = true;
  fireEvent.click(permission());
  await page.findByRole('alert');
  expect(permission().getAttribute('aria-checked')).toBe('false');
  expect(sharing()).toBeNull();
  locked = true;
  fireEvent.click(permission());
  await waitFor(() => expect(page.queryByRole('switch', {name:'Show both hands to spectators'})).toBeNull());
  expect(page.getByRole('alert').textContent).toMatch(/locked/i);
  expect(changes).toEqual(['both-hands','public-board','both-hands','both-hands']);
  expect(linksRead).toBe(0);
});

test('a guest claiming before revoke freezes the enabled permission and keeps the owner’s link selector available', async () => {
  tables = [];
  let eligible = true;
  const links: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/spectator-links')) return Response.json({ tables: [
      { tableId, tableName:'Claim race fixture', canConfigureSpectatorVisibility:eligible, spectatorVisibility:'both-hands' },
    ] });
    if (init?.method === 'PATCH') {
      eligible = false;
      return new Response(null, {status:409});
    }
    if (url.includes('/spectator-link')) links.push(url);
    return Response.json({});
  }));
  const {page} = mount();
  const config = await page.findByRole('switch', {name:'Show both hands to spectators'});
  expect(config.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(config);
  await page.findByRole('alert');
  expect(page.queryByRole('switch', {name:'Show both hands to spectators'})).toBeNull();
  const share = page.getByRole('switch', {name:'Share both hands with this spectator link'});
  expect(share.getAttribute('aria-checked')).toBe('false');
  expect(links).toEqual([]);
});
