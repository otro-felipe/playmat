import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { GameView } from '../../protocol/generated/views';
import { api } from '../connection';
import { useSession } from '../stores/session';
import { ReplayScreen } from './ReplayScreen';

vi.mock('../playtesting', () => ({ PRIVATE_PLAYTESTING: true }));
vi.mock(import('../connection'), async (original) => {
  const actual = await original();
  return { ...actual, api: { ...actual.api, replayPage: vi.fn() } };
});
vi.mock('../solo/soloData', () => ({ useSoloTurns: () => ({ data: [] }) }));
vi.mock('../match/MatchStage', () => ({ MatchStage: ({ state, replayHands, plateAccessories }: {
  state: { playerId: string | null; view?: GameView };
  replayHands?: Record<string, Record<string, { name?: string }>>;
  plateAccessories?: Record<string, import('react').ReactNode>;
}) => (
  <div aria-label="Test table">
    <div data-testid="seat">{state.playerId}</div>
    <div data-testid="turn">{state.view?.turn}</div>
    <div data-testid="stack">{Object.values(state.view?.stack ?? {}).map(({ name }) => name).join(', ')}</div>
    <div data-testid="hand">{Object.values(state.view?.myHand ?? {}).map(({ name }) => name).join(', ')}</div>
    <div data-testid="full-hands">{Object.values(replayHands ?? {}).flatMap((hand) => Object.values(hand).map(({ name }) => name)).join(', ')}</div>
    {Object.entries(plateAccessories ?? {}).map(([playerId, accessory]) => <div key={playerId} data-testid={`plate-${playerId}`}>{accessory}</div>)}
  </div>
) }));

const view: GameView = {
  turn: 7,
  players: [{ playerId: 'alice-player', name: 'Alice', handCount: 1 }, { playerId: 'bob-player', name: 'Bob', handCount: 1 }],
};
const fromHand = { bolt: { name: 'Burst Lightning', id: 'bolt' } };
const hiddenHand = { spell: { name: 'Fatal Push', id: 'spell' } };
const perspectives = [{ seatId: 'alice-seat', playerId: 'alice-player', name: 'Alice' }, { seatId: 'bob-seat', playerId: 'bob-player', name: 'Bob' }];
const game = {
  gameId: 'game', matchId: 'match', status: 'completed', gameNumber: 3, viewerSeatId: 'alice-seat',
  availablePerspectives: perspectives, fullAvailable: true, coverage: { hands: 'complete', draws: 'partial' },
  analysis: { status: 'partial', eligible: 2, reviewed: 1, counts: { good: 1 }, bySeat: [] },
};
const positioned = { ...view, stack: { bolt: { name: 'Burst Lightning', id: 'bolt' } } };
const actual = {
  kind: 'cast', text: 'mcp_e70ebd2d48 casts Burst Lightning [28c] targeting Sheoldred [711]',
  cardRef: { id: 'bolt', name: 'Burst Lightning' }, targets: [{ id: 'sheoldred', name: 'Sheoldred', kind: 'card' }],
  modes: ['Kicked'], paidMana: { R: 1, C: 4 },
};
const moments = [
  { cursor: 1, frameCursor: 0, type: 'action', turn: 6, text: 'Played Island' },
  { cursor: 3, frameCursor: 2, actionFrameCursor: 4, type: 'action', turn: 7, actor: 'Alice', actual, text: actual.text },
];
const annotation = {
  gameId: 'game', cursor: 3, frameCursor: 2, seatId: 'alice-seat', category: 'good', actual,
  alternatives: [{ line: 'Hold the second Burst', legality: 'legal', benefit: 'Preserve reach', risk: 'Sheoldred stays in play' }],
  confidence: 'high', rationale: 'Sheoldred was on the battlefield.', evidence: { basis: 'engine_log', frameCursor: 2, turn: 7 }, retrospective: 'Bob held Fatal Push.',
};
const request = vi.fn<(url: string, options?: RequestInit) => Promise<Response>>();
const pageRequest = vi.fn<(url: string, options?: RequestInit) => Promise<Response>>();
const json = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status }));

beforeEach(() => {
  useSession.setState({ userName: 'Alice', phase: 'signedIn' });
  vi.stubGlobal('fetch', (url: string, options?: RequestInit) => url.startsWith('/api/playtesting/replays/')
    ? pageRequest(url, options) : request(url, options));
  vi.mocked(api.replayPage).mockResolvedValue(null);
  pageRequest.mockImplementation(() => json({
    info: { gameId: 'game' },
    start: 0,
    total: 5,
    events: [{ view: { ...view, turn: 6 }, myHand: fromHand }, { log: { message: 'Played Island' } },
      { view, myHand: fromHand }, { log: { message: actual.text } }, { view: positioned, myHand: fromHand }],
  }));
  request.mockImplementation((raw) => {
    const url = new URL(raw, 'http://localhost');
    if (url.pathname.endsWith('/annotations')) return json({ annotations: [annotation], next: null });
    if (!url.pathname.endsWith('/evidence')) return json(game);
    if (url.searchParams.get('scope') === 'public') return json({ events: moments, next: null });
    return json({ events: [{ cursor: 0, view: { ...view, turn: 6 }, myHand: fromHand },
      { cursor: 4, view: positioned, myHand: url.searchParams.get('seatId') === 'bob-seat' ? hiddenHand : fromHand,
        ...(url.searchParams.get('scope') === 'full' ? { hands: { 'alice-player': fromHand, 'bob-player': hiddenHand } } : {}) }], next: null });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function openReplay(address = '/replay/game?cursor=1') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[address]}>
        <Routes><Route path="/replay/:gameId" element={<ReplayScreen />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test('[PM-REVIEW-UI-2] a browser history replay follows the owned player perspective across pages', async () => {
  useSession.setState({ userName: 'ProfileOwner', phase: 'signedIn' });
  request.mockImplementation(() => json({}, 404));
  const players = [{ playerId: 'p1', name: 'ProfileOne', life: 11 }, { playerId: 'p2', name: 'ProfileTwo', life: 7 }];
  pageRequest.mockImplementation((path) => {
    const start = Number(new URL(path, 'http://localhost').searchParams.get('start'));
    return json({ info: { gameId: 'game', viewerName: 'profiletwo' }, start, total: 2, events: [{ view: { players, turn: 8 + start } }] });
  });
  openReplay('/replay/game?frame=1');
  await waitFor(() => expect(screen.getByTestId('turn').textContent).toBe('9'));
  expect(screen.getByTestId('seat').textContent).toBe('p2');
  expect(pageRequest.mock.calls.map(([url]) => url)).toEqual([
    '/api/playtesting/replays/game?start=0&count=40', '/api/playtesting/replays/game?start=1&count=40',
  ]);
  expect(api.replayPage).not.toHaveBeenCalled();
});

test.each([
  [404, 'This replay is unavailable.'],
  [503, 'The replay archive could not be read.'],
])('[PM-REVIEW-UI-2] a private archive returns its unavailable state (%i) without switching transport', async (status, message) => {
  pageRequest.mockImplementation(() => json({}, status));
  openReplay();
  expect(await screen.findByText(message)).toBeTruthy();
  expect(api.replayPage).not.toHaveBeenCalled();
});

test('[PM-REVIEW-UI-1] jumping to a reviewed play preserves the cursor when changing hands and perspective', async () => {
  openReplay();
  const analysis = await screen.findByRole('switch', { name: 'Show analysis' });
  fireEvent.click(analysis);
  const list = await screen.findByRole('navigation', { name: 'Key moments' });
  const moment = await within(list).findByRole('button', { name: /Alice casts Burst Lightning targeting Sheoldred/ });
  fireEvent.click(moment);
  expect(await screen.findByText('Preserve reach')).toBeTruthy();
  expect(screen.getByTestId('turn').textContent).toBe('7');
  expect(screen.queryByRole('region', { name: 'Evidence before the play' })).toBeNull();
  const hands = screen.getByRole('switch', { name: 'Show both hands' });
  expect(hands.getAttribute('aria-checked')).toBe('true');
  await waitFor(() => expect(screen.getByTestId('full-hands').textContent).toContain('Fatal Push'));
  expect(screen.getByTestId('turn').textContent).toBe('7');
  fireEvent.click(hands);
  expect(screen.getByTestId('full-hands').textContent).toBe('');
  fireEvent.change(screen.getByLabelText('Perspective'), { target: { value: 'bob-seat' } });
  await waitFor(() => expect(screen.getByTestId('hand').textContent).toBe('Fatal Push'));
  expect(screen.getByTestId('seat').textContent).toBe('bob-player');
  expect(screen.getByTestId('turn').textContent).toBe('7');
  fireEvent.click(analysis);
  expect(screen.queryByText('Preserve reach')).toBeNull();
  expect(screen.getByTestId('turn').textContent).toBe('7');
});

test('[PM-REVIEW-API-6] own sideboard evidence stays with the viewer when changing the board perspective', async () => {
  const original = request.getMockImplementation()!;
  request.mockImplementation((path, options) => path.endsWith('/games/game')
    ? json({ ...game, sideboardDelta: { status: 'available', fromGameNumber: 2, toGameNumber: 3,
      broughtIn: [{ name: 'Abrade', amount: 2 }], tookOut: [{ name: 'Island', amount: 1 }] } })
    : original(path, options));
  openReplay('/replay/game?cursor=3');
  fireEvent.click(await screen.findByRole('switch', { name: 'Show analysis' }));
  const delta = await screen.findByRole('region', { name: 'Your sideboard changes' });
  expect(delta.textContent).toContain('Game 2 to game 3');
  expect(delta.textContent).toContain('2 × Abrade');
  expect(delta.textContent).toContain('1 × Island');
  fireEvent.change(screen.getByLabelText('Perspective'), { target: { value: 'bob-seat' } });
  await waitFor(() => expect(screen.getByTestId('hand').textContent).toBe('Fatal Push'));
  expect(screen.getByRole('region', { name: 'Your sideboard changes' }).textContent).toContain('2 × Abrade');
  expect(screen.getByTestId('turn').textContent).toBe('7');
});

test.each([
  ['available', 'You made no sideboard changes.'],
  ['unavailable', 'Sideboard changes could not be verified from the recorded deck lists.'],
  ['initial_game', null],
] as const)('[PM-REVIEW-API-6] sideboard delta distinguishes %s evidence', async (status, message) => {
  const original = request.getMockImplementation()!;
  request.mockImplementation((path, options) => path.endsWith('/games/game')
    ? json({
      ...game, gameNumber: status === 'initial_game' ? 1 : 3,
      sideboardDelta: status === 'available' ? {
        status, fromGameNumber: 2, toGameNumber: 3, broughtIn: [], tookOut: [],
      } : { status },
    })
    : original(path, options));
  openReplay();
  fireEvent.click(await screen.findByRole('switch', { name: 'Show analysis' }));
  if (message) expect(within(await screen.findByRole('region', { name: 'Your sideboard changes' })).getByText(message)).toBeTruthy();
  else expect(screen.queryByRole('region', { name: 'Your sideboard changes' })).toBeNull();
});

test('[PM-THEORY-6] an authorized annotation links only its valid saved study downloads', async () => {
  const studyId = '00000000-0000-4000-8000-000000000123';
  const original = request.getMockImplementation()!;
  request.mockImplementation((path, options) => new URL(path, 'http://localhost').pathname.endsWith('/annotations')
    ? json({ annotations: [{ ...annotation, theoryStudies: [
      { studyId, tool: 'get_theory_study' }, { studyId: 'https://elsewhere.invalid', tool: 'get_theory_study' },
    ] }], next: null })
    : original(path, options));
  openReplay('/replay/game?cursor=3');
  fireEvent.click(await screen.findByRole('switch', { name: 'Show analysis' }));
  const download = await screen.findByRole('link', { name: /Download study 1 \(JSON\)/ });
  expect(download.getAttribute('href')).toBe('/api/playtesting/theory/studies/' + studyId);
  expect(download.getAttribute('download')).toBe('theory-study-' + studyId + '.json');
  expect(screen.queryByRole('link', { name: /Download study 2/ })).toBeNull();
});

test('[PM-REVIEW-UI-2] an unauthorized archive never requests another hand', async () => {
  request.mockImplementation(() => json({}, 404));
  openReplay('/replay/game?cursor=3');
  await waitFor(() => expect(screen.getByTestId('turn').textContent).toBe('7'));
  expect(screen.queryByRole('switch', { name: 'Show both hands' })).toBeNull();
  expect(request.mock.calls.every(([path]) => !path.includes('scope=full') && !path.includes('seatId='))).toBe(true);
  expect(screen.getByTestId('hand').textContent).toBe('Burst Lightning');
});

test('[PM-REVIEW-UI-2] a participant gets no opponent perspective before the entire match completes', async () => {
  request.mockImplementation((path) => path.endsWith('/games/game') ? json({
    ...game, status: 'active', availablePerspectives: [perspectives[0], { ...perspectives[1], allowed: false }],
    privacy: { fullAvailable: false, viewerSeatId: 'alice-seat' },
  }) : json({ events: [], annotations: [], next: null }));
  openReplay('/replay/game?cursor=3');
  const perspective = await screen.findByLabelText('Perspective');
  expect(within(perspective).queryByRole('option', { name: 'Bob' })).toBeNull();
  expect(screen.queryByRole('switch', { name: 'Show both hands' })).toBeNull();
  expect(request.mock.calls.every(([path]) => !path.includes('scope=full') && !path.includes('seatId='))).toBe(true);
});

test('[PM-REVIEW-UI-2] a late full hand response for a previous account cannot reach the next viewer', async () => {
  let oldResponse: ((result: Response) => void) | undefined;
  const original = request.getMockImplementation()!;
  request.mockImplementation((path, options) => {
    if (path.includes('scope=full')) return new Promise((resolve) => { oldResponse = resolve; });
    if (useSession.getState().userName === 'Bob' && path.endsWith('/games/game')) return json({
      ...game, viewerSeatId: 'bob-seat', fullAvailable: false, availablePerspectives: [perspectives[1]],
    });
    return original(path, options);
  });
  openReplay('/replay/game?cursor=3');
  expect((await screen.findByRole('switch', { name: 'Show both hands' })).getAttribute('aria-checked')).toBe('true');
  await waitFor(() => expect(oldResponse).toBeDefined());
  act(() => useSession.setState({ userName: 'Bob' }));
  await waitFor(() => expect(screen.getByLabelText('Perspective')).toBeTruthy());
  await act(async () => oldResponse!(await json({ events: [{ cursor: 2, view, hands: { 'bob-player': hiddenHand } }] })));
  expect(screen.getByTestId('full-hands').textContent).toBe('');
  expect(screen.queryByRole('switch', { name: 'Show both hands' })).toBeNull();
});


test('[PM-REVIEW-UI-4] a timeline marker opens the recorded stack and shows the decision and its rating', async () => {
  openReplay();
  const timeline = await screen.findByRole('group', { name: 'Reviewed decisions' });
  const marker = await within(timeline).findByRole('button', { name: /Normal.*Burst Lightning/ });
  fireEvent.click(marker);
  await waitFor(() => expect(screen.getByTestId('stack').textContent).toBe('Burst Lightning'));
  expect(screen.queryByLabelText('Recorded decision')).toBeNull();

  fireEvent.click(screen.getByRole('switch', { name: 'Show analysis' }));
  expect(await screen.findByRole('heading', { name: /Alice casts Burst Lightning targeting Sheoldred/ })).toBeTruthy();
  const decision = screen.getByLabelText('Recorded decision');
  expect(within(decision).getByText('Kicked')).toBeTruthy();
  expect(within(decision).getByText('Sheoldred')).toBeTruthy();
  expect(within(screen.getByRole('article')).getByText('Normal')).toBeTruthy();
  expect(decision.textContent).not.toMatch(/mcp_|\[28c\]|\[711\]/);
  const noteTitle = screen.getByRole('article').querySelector('h3')!;
  expect(within(noteTitle).getByRole('button', { name: 'Burst Lightning, show card' })).toBeTruthy();
});


test('[PM-REVIEW-UI-5] later action pages include unreviewed decisions with pending copy', async () => {
  const original = request.getMockImplementation()!;
  request.mockImplementation((raw, options) => {
    const url = new URL(raw, 'http://localhost');
    if (url.searchParams.get('scope') !== 'public') return original(raw, options);
    if (url.searchParams.get('cursor') === '0') return json({ events: [moments[0]], next: 3 });
    return json({ events: [moments[1]], next: null });
  });
  openReplay();
  fireEvent.click(await screen.findByRole('switch', { name: 'Show analysis' }));
  const list = await screen.findByRole('navigation', { name: 'Key moments' });
  expect(await within(list).findByRole('button', { name: /Alice casts Burst Lightning/ })).toBeTruthy();
  fireEvent.click(within(list).getByRole('button', { name: /Played Island/ }));
  expect(await screen.findByText('Awaiting analysis for this decision.')).toBeTruthy();
});

test('[PM-REVIEW-UI-2] a missing archived opponent hand never displays the acting viewer’s hand as that seat', async () => {
  const original = request.getMockImplementation()!;
  request.mockImplementation((raw, options) => raw.includes('scope=full') ? json({
    events: [{ cursor: 4, view: positioned, myHand: fromHand, hands: { 'alice-player': fromHand } }], next: null,
  }) : original(raw, options));
  openReplay('/replay/game?cursor=3');
  expect(await screen.findByText('This frame has no recorded hand for the selected view.')).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId('hand').textContent).toBe('Burst Lightning'));
  fireEvent.change(screen.getByLabelText('Perspective'), { target: { value: 'bob-seat' } });
  await waitFor(() => expect(screen.getByTestId('seat').textContent).toBe('bob-player'));
  expect(screen.getByTestId('hand').textContent).toBe('');
});

test('[PM-REVIEW-UI-6] Left and Right use the same action cursor as the playback buttons without taking focus', async () => {
  const { container } = openReplay();
  const next = await screen.findByRole('button', { name: 'Next play' });
  await within(await screen.findByRole('group', { name: 'Reviewed decisions' })).findByRole('button', { name: /Burst Lightning/ });
  const replay = container.querySelector('[data-replay-cursor]')!;
  expect(replay.getAttribute('data-replay-cursor')).toBe('1');

  next.focus();
  fireEvent.keyDown(next, { key: 'ArrowRight' });
  await waitFor(() => expect(replay.getAttribute('data-replay-cursor')).toBe('3'));
  expect(screen.getByTestId('stack').textContent).toBe('Burst Lightning');
  expect(document.activeElement).toBe(next);

  fireEvent.keyDown(next, { key: 'ArrowLeft' });
  expect(replay.getAttribute('data-replay-cursor')).toBe('1');
  expect(document.activeElement).toBe(next);
  fireEvent.click(next);
  expect(replay.getAttribute('data-replay-cursor')).toBe('3');
});

test('[PM-REVIEW-UI-6] keyboard stepping leaves range, editable controls, menus and modified chords alone', async () => {
  const { container } = openReplay();
  const next = await screen.findByRole('button', { name: 'Next play' });
  const replay = container.querySelector('[data-replay-cursor]')!;
  const slider = screen.getByRole('slider', { name: 'Position in the replay' });
  const perspective = screen.getByLabelText('Perspective');
  for (const control of [slider, perspective]) {
    control.focus();
    expect(fireEvent.keyDown(control, { key: 'ArrowRight' })).toBe(true);
    expect(replay.getAttribute('data-replay-cursor')).toBe('1');
  }
  expect(fireEvent.keyDown(next, { key: 'ArrowRight', altKey: true })).toBe(true);
  expect(fireEvent.keyDown(next, { key: 'ArrowRight', metaKey: true })).toBe(true);
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  document.body.append(dialog);
  try {
    expect(fireEvent.keyDown(document.body, { key: 'ArrowRight' })).toBe(true);
    expect(replay.getAttribute('data-replay-cursor')).toBe('1');
  } finally {
    dialog.remove();
  }
});

test('[PM-REVIEW-UI-6] a public replay still steps over consecutive snapshots with the arrow keys', async () => {
  request.mockImplementation(() => json({}, 404));
  const { container } = openReplay('/replay/game?frame=0');
  await screen.findByRole('button', { name: 'Step forward' });
  const replay = container.querySelector('[data-replay-cursor]')!;
  expect(replay.getAttribute('data-replay-cursor')).toBe('0');
  fireEvent.keyDown(document.body, { key: 'ArrowRight' });
  expect(replay.getAttribute('data-replay-cursor')).toBe('2');
  fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
  expect(replay.getAttribute('data-replay-cursor')).toBe('0');
});

test('[PM-REVIEW-UI-6] opening-hand context and confidence follow the current authorized decision', async () => {
  const mulligan = {
    ...moments[0], actor: 'Alice', seatId: 'alice-seat',
    actual: { kind: 'mulligan', text: 'Alice mulligans' },
  };
  const original = request.getMockImplementation()!;
  request.mockImplementation((raw, options) => {
    const url = new URL(raw, 'http://localhost');
    if (url.pathname.endsWith('/annotations')) return json({ annotations: [{
      ...annotation, ...mulligan, confidence: 'low', category: 'insufficient',
      rationale: 'The matchup was unknown.',
    }], next: null });
    if (url.searchParams.get('scope') === 'public') return json({ events: [mulligan, moments[1]], next: null });
    if (url.searchParams.get('cursor') === '1' && url.searchParams.get('count') === '1') {
      return json({ events: [url.searchParams.get('seatId') === 'bob-seat' ? mulligan : {
        ...mulligan, decision: { cards: [{ id: 'opening-land', name: 'Mountain' }] },
      }], next: null });
    }
    return original(raw, options);
  });
  openReplay('/replay/game?cursor=1&analysis=1');
  expect(await screen.findByText('Low confidence')).toBeTruthy();
  const hand = await screen.findByRole('region', { name: 'Hand before the decision' });
  expect(within(hand).getByRole('button', { name: 'Mountain, show card' })).toBeTruthy();

  fireEvent.click(screen.getByRole('switch', { name: 'Show both hands' }));
  fireEvent.change(screen.getByLabelText('Perspective'), { target: { value: 'bob-seat' } });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Mountain, show card' })).toBeNull());
});

test('[PM-REVIEW-UI-6] a saved omission is accessible and identified as inferred', async () => {
  const omitted = {
    ...moments[1], cursor: 2, frameCursor: 2, actionFrameCursor: undefined,
    actual: { kind: 'omission', text: 'Alice · omission' },
    evidence: { basis: 'inferred_omission', frameQuality: 'preceding_snapshot', window: 'before_combat' },
  };
  const original = request.getMockImplementation()!;
  request.mockImplementation((raw, options) => {
    const url = new URL(raw, 'http://localhost');
    if (url.pathname.endsWith('/annotations')) return json({ annotations: [{
      ...annotation, ...omitted, confidence: 'medium', category: 'inaccuracy', rationale: 'Waiting gave up early tempo.',
    }], next: null });
    if (url.searchParams.get('scope') === 'public') return json({ events: [moments[0], omitted, moments[1]], next: null });
    return original(raw, options);
  });
  openReplay('/replay/game?cursor=1&analysis=1');
  const markers = await screen.findByRole('group', { name: 'Reviewed decisions' });
  await within(markers).findByRole('button', { name: /Inaccuracy.*Alice lets an opportunity pass/ });
  fireEvent.keyDown(document.body, { key: 'ArrowRight' });
  expect(await screen.findByRole('heading', { name: 'Alice lets an opportunity pass before combat' })).toBeTruthy();
  expect(screen.getByText('Medium confidence')).toBeTruthy();
  expect(screen.getByText('Inferred from the recorded priority window.')).toBeTruthy();
});

test.each([
  { kind: 'mulligan', cards: undefined, heading: null, message: 'The replay has no opening hand capture for this decision.' },
  {
    kind: 'pass', cards: [{ id: 'bolt', name: 'Burst Lightning' }], heading: 'Recorded options',
    message: 'Manual pass · End step · 0 objects on the stack · 1 playable option recorded',
  },
])('[PM-REVIEW-UI-6] a recorded $kind shows its available context', async ({ kind, cards, heading, message }) => {
  const play = { ...moments[0], actor: 'Alice', seatId: 'alice-seat', actual: { kind, text: 'Alice acts' } };
  const original = request.getMockImplementation()!;
  request.mockImplementation((raw, options) => {
    const url = new URL(raw, 'http://localhost');
    if (url.searchParams.get('scope') === 'public') return json({ events: [play], next: null });
    if (url.searchParams.get('scope') === 'full' && url.searchParams.get('count') === '1') {
      return json({
        events: [cards ? { ...play, decision: { cards, passKind: 'manual', endsTurn: true, stackSize: 0, playableCount: 1 } } : play],
        next: null,
      });
    }
    return original(raw, options);
  });
  openReplay('/replay/game?cursor=1&analysis=1');
  if (heading) {
    const context = await screen.findByRole('region', { name: heading });
    expect(within(context).getByRole('button', { name: 'Burst Lightning, show card' })).toBeTruthy();
  }
  expect(await screen.findByText(message)).toBeTruthy();
});

test('[PM-REVIEW-UI-6] attached choices show the selected mode, opponent or card target, and declined options only in authorized context', async () => {
  const cast = { ...moments[1], seatId: 'alice-seat', hasDecisionContext: true };
  const mode = {
    id: 'decision-mode', choiceKind: 'mode',
    optionDetails: [{ id: 'opaque-mode-0', label: 'Draw two cards' }, { id: 'opaque-mode-1', label: 'Deal damage' }],
    selectedOptionIds: ['opaque-mode-1'],
  };
  const target = {
    id: 'decision-target', choiceKind: 'target',
    optionDetails: [
      { id: 'opaque-target-0', label: 'Bob', playerId: 'bob-player' },
      { id: 'opaque-target-1', label: 'Fatal Push', card: { id: 'private-card', name: 'Fatal Push' } },
    ],
    selectedOptionIds: ['opaque-target-1'],
  };
  const confirmation = { id: 'decision-confirmation', choiceKind: 'use', prompt: 'Pay the additional cost?', declined: true };
  const original = request.getMockImplementation()!;
  request.mockImplementation((raw, options) => {
    const url = new URL(raw, 'http://localhost');
    if (url.searchParams.get('scope') === 'public') return json({ events: [cast], next: null });
    if (url.searchParams.get('cursor') === '3' && url.searchParams.get('count') === '1') {
      const includeChoices = url.searchParams.get('seatId') !== 'bob-seat';
      return json({ events: [includeChoices ? { ...cast, decision: mode, decisions: [mode, target, confirmation] } : cast], next: null });
    }
    return original(raw, options);
  });
  openReplay('/replay/game?cursor=3&analysis=1');
  const modes = await screen.findByRole('region', { name: 'Modes' });
  expect(within(modes).getByText('Draw two cards')).toBeTruthy();
  expect(within(modes).getByText('Deal damage').closest('li')?.textContent).toContain('Selected');
  const targets = screen.getByRole('region', { name: 'Targets' });
  expect(within(targets).getByText('Bob')).toBeTruthy();
  expect(within(targets).queryByRole('button', { name: 'Bob, show card' })).toBeNull();
  expect(within(targets).getByRole('button', { name: 'Fatal Push, show card' }).closest('li')?.textContent).toContain('Selected');
  const confirm = screen.getByRole('region', { name: 'Confirmation' });
  expect(within(confirm).getByText('Pay the additional cost?')).toBeTruthy();
  expect(within(confirm).getByText('Declined')).toBeTruthy();
  expect(modes.textContent).not.toContain('opaque-mode-');

  fireEvent.click(screen.getByRole('switch', { name: 'Show both hands' }));
  fireEvent.change(screen.getByLabelText('Perspective'), { target: { value: 'bob-seat' } });
  await waitFor(() => expect(request.mock.calls.some(([raw]) => {
    const params = new URL(raw, 'http://localhost').searchParams;
    return params.get('scope') === 'seat' && params.get('seatId') === 'bob-seat' && params.get('count') === '1';
  })).toBe(true));
  expect(screen.queryByText('Pay the additional cost?')).toBeNull();
  expect(screen.queryByText('Draw two cards')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Fatal Push, show card' })).toBeNull();
});

test('[PM-REVIEW-UI-6] a forced choice names the chooser and affected seat and previews its source', async () => {
  const discard = {
    ...moments[1], actor: 'Bob', seatId: 'bob-seat', decisionActor: 'Alice', decisionSeatId: 'alice-seat',
    affectedActor: 'Bob', hasDecisionContext: true,
    actual: { kind: 'discard', text: 'Bob discards a card', cardRef: { name: 'Lightning Strike' } },
  };
  const context = {
    choiceKind: 'discard', sourceCard: { name: 'Duress' },
    cards: [{ id: 'chosen-card', name: 'Lightning Strike' }], selectedIds: ['chosen-card'],
  };
  const original = request.getMockImplementation()!;
  request.mockImplementation((raw, options) => {
    const url = new URL(raw, 'http://localhost');
    if (url.searchParams.get('scope') === 'public') return json({ events: [discard], next: null });
    if (url.searchParams.get('cursor') === '3' && url.searchParams.get('count') === '1') {
      return json({ events: [{ ...discard, decision: context }], next: null });
    }
    return original(raw, options);
  });
  openReplay('/replay/game?cursor=3&analysis=1');
  const title = await screen.findByRole('heading', { name: /Alice chooses Lightning Strike.*for Bob to discard/ });
  expect(within(title).getByRole('button', { name: 'Lightning Strike, show card' })).toBeTruthy();
  const choices = await screen.findByRole('region', { name: 'Discard choices' });
  expect(within(choices).getByRole('button', { name: 'Duress, show card' })).toBeTruthy();
  expect(within(choices).getByRole('button', { name: 'Lightning Strike, show card' }).closest('li')?.textContent).toContain('Selected');
});

test('[PM-REVIEW-UI-8] annotation card links select a face and legacy names retain previews', async () => {
  const previous = request.getMockImplementation()!;
  request.mockImplementation((path, options) => path.includes('/annotations')
    ? json({ annotations: [{ ...annotation, rationale: 'Usa [la tierra](card://Bala%20Ged%20Recovery:back), luego Sheoldred.',
      benefit: 'No tocar [inválida](card://%zz) ni [web](javascript:alert).' }], next: null })
    : path.includes('scryfall-links') ? json({ cards: {}, tokens: {} }) : previous(path, options));
  openReplay('/replay/game?cursor=3');
  fireEvent.click(await screen.findByRole('switch', { name: 'Show analysis' }));
  const detail = await screen.findByRole('article');
  const card = await within(detail).findByRole('button', { name: /la tierra/ });
  expect(within(card.closest('p')!).getByRole('button', { name: /Sheoldred/ })).toBeTruthy();
  fireEvent.click(card);
  await waitFor(() => expect(document.body.querySelector('img[src*="face=back"]')?.getAttribute('src')).toContain('Bala+Ged+Recovery'));
  expect(card.getAttribute('aria-expanded')).toBe('true');
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(card.getAttribute('aria-expanded')).toBe('false'));
  expect(detail.textContent).toContain('[inválida](card://%zz)');
  expect(detail.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(screen.getByTestId('turn').textContent).toBe('7');
});


test.each([
  { reasoning: 'Keep mana available.' },
  { audience:'public', explanation:'Keep mana available.', reasoning:'Legacy text must not replace the public explanation.' },
])('[PM-LINE-REPLAY-1] the seat’s brain opens the agent’s explanation and the plays it sent', async (note) => {
  const original = request.getMockImplementation()!;
  const sent = { cursor: 3, frameCursor: 2, actionFrameCursor: 4, turn: 7, seatId: 'alice-seat', actor: 'Alice', actual, text: actual.text };
  request.mockImplementation((path, options) => path.includes('/evidence?') && path.includes('scope=full')
    ? json({ next: null, events: [{ cursor: 0, view, lines: [{ cursor: 1, commandId: 'a', actor: 'Alice', seatId: 'alice-seat', ...note, plays: [sent] }] }] })
    : original(path, options));
  openReplay('/replay/game?frame=0');
  const brain = await within(await screen.findByTestId('plate-alice-player')).findByRole('button', { name: 'See the reasoning of Alice' });
  expect(screen.queryByText('Keep mana available.')).toBeNull();
  expect(screen.queryByRole('switch', { name: /explanations/i })).toBeNull();
  expect(screen.queryByTestId('plate-bob-player')).toBeNull();
  fireEvent.click(brain);
  const dialog = screen.getByRole('dialog', { name: 'Reasoning of Alice' });
  expect(within(dialog).getByText('Keep mana available.')).toBeTruthy();
  expect(dialog.textContent).not.toContain('Legacy text');
  fireEvent.click(within(dialog).getByRole('button', { name: /Alice casts Burst Lightning targeting Sheoldred/ }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(screen.getByTestId('stack').textContent).toBe('Burst Lightning'));
  fireEvent.click(brain);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});
