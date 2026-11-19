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
vi.mock('../match/MatchStage', () => ({ MatchStage: ({ state, replayHands }: {
  state: { playerId: string | null; view?: GameView };
  replayHands?: Record<string, Record<string, { name?: string }>>;
}) => (
  <div aria-label="Test table">
    <div data-testid="seat">{state.playerId}</div>
    <div data-testid="turn">{state.view?.turn}</div>
    <div data-testid="stack">{Object.values(state.view?.stack ?? {}).map(({ name }) => name).join(', ')}</div>
    <div data-testid="hand">{Object.values(state.view?.myHand ?? {}).map(({ name }) => name).join(', ')}</div>
    <div data-testid="full-hands">{Object.values(replayHands ?? {}).flatMap((hand) => Object.values(hand).map(({ name }) => name)).join(', ')}</div>
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
const json = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status }));

beforeEach(() => {
  useSession.setState({ userName: 'Alice', phase: 'signedIn' });
  vi.stubGlobal('fetch', request);
  vi.mocked(api.replayPage).mockResolvedValue({
    info: { gameId: 'game' },
    start: 0,
    total: 5,
    events: [{ view: { ...view, turn: 6 }, myHand: fromHand }, { log: { message: 'Played Island' } },
      { view, myHand: fromHand }, { log: { message: actual.text } }, { view: positioned, myHand: fromHand }],
  });
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
  const decision = screen.getByRole('region', { name: 'Recorded decision' });
  expect(within(decision).getByText('Kicked')).toBeTruthy();
  expect(within(decision).getByText('Sheoldred')).toBeTruthy();
  expect(within(decision).getByLabelText('Normal')).toBeTruthy();
  expect(decision.textContent).not.toMatch(/mcp_|\[28c\]|\[711\]/);

  fireEvent.click(screen.getByRole('switch', { name: 'Show analysis' }));
  expect(await screen.findByRole('heading', { name: /Alice casts Burst Lightning targeting Sheoldred/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Burst Lightning, show card' })).toBeTruthy();
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
  await screen.findByText('Played Island');
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
