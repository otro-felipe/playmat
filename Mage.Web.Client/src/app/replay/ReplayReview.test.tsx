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
const moments = [
  { cursor: 1, frameCursor: 0, type: 'action', turn: 6, text: 'Played Island' },
  { cursor: 3, frameCursor: 2, type: 'action', turn: 7, text: 'Two Burst Lightning against Sheoldred' },
];
const annotation = {
  gameId: 'game', cursor: 3, frameCursor: 2, seatId: 'alice-seat', category: 'good', actual: { kind: 'cast', text: 'Two Burst Lightning against Sheoldred' },
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
    total: 4,
    events: [{ view: { ...view, turn: 6 }, myHand: fromHand }, { log: { message: 'Played Island' } },
      { view, myHand: fromHand }, { log: { message: 'Two Burst Lightning against Sheoldred' } }],
  });
  request.mockImplementation((raw) => {
    const url = new URL(raw, 'http://localhost');
    if (url.pathname.endsWith('/annotations')) return json({ annotations: [annotation], next: null });
    if (!url.pathname.endsWith('/evidence')) return json(game);
    if (url.searchParams.get('scope') === 'public') return json({ events: moments, next: null });
    return json({ events: [{ cursor: 0, view: { ...view, turn: 6 }, myHand: fromHand },
      { cursor: 2, view, myHand: url.searchParams.get('seatId') === 'bob-seat' ? hiddenHand : fromHand,
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
  const moment = await screen.findByRole('button', { name: /Two Burst Lightning against Sheoldred/ });
  fireEvent.click(moment);
  expect(await screen.findByText('Preserve reach')).toBeTruthy();
  expect(screen.getByTestId('turn').textContent).toBe('7');
  expect(within(screen.getByRole('region', { name: 'Evidence before the play' })).queryByText(/Fatal Push/)).toBeNull();
  const hands = screen.getByRole('switch', { name: 'Show both hands' });
  fireEvent.click(hands);
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

test('[PM-REVIEW-UI-2] an unauthorized archive never requests another hand', async () => {
  request.mockImplementation(() => json({}, 404));
  openReplay('/replay/game?cursor=3');
  await waitFor(() => expect(screen.getByTestId('turn').textContent).toBe('7'));
  expect(screen.queryByRole('switch', { name: 'Show both hands' })).toBeNull();
  expect(request.mock.calls.every(([path]) => !path.includes('scope=full') && !path.includes('seatId='))).toBe(true);
  expect(screen.getByTestId('hand').textContent).toBe('Burst Lightning');
});

test('[PM-REVIEW-UI-2] a historical grant is explicit and sends no shared hand request while pending', async () => {
  request.mockImplementation((raw, options) => {
    if (raw.endsWith('/privacy/matches/match')) {
      expect(options?.method).toBe('PUT');
      return json({ ownGranted: true, available: false });
    }
    if (raw.endsWith('/games/game')) return json({ ...game, fullAvailable: false, availablePerspectives: [perspectives[0]], privacy: {
      canGrantLegacy: true, legacyGranted: request.mock.calls.some(([path]) => path.endsWith('/privacy/matches/match')),
    } });
    return json({ events: [], annotations: [], next: null });
  });
  openReplay('/replay/game?cursor=3');
  const grant = await screen.findByRole('button', { name: 'Allow both hands for this match' });
  expect(request.mock.calls.every(([path]) => !path.includes('/privacy/matches/'))).toBe(true);
  fireEvent.click(grant);
  expect(await screen.findByText('Waiting for the other participant to grant access.')).toBeTruthy();
  expect(screen.queryByRole('switch', { name: 'Show both hands' })).toBeNull();
  expect(screen.getByTestId('turn').textContent).toBe('7');
});

test('[PM-REVIEW-UI-2] a participant gets no opponent perspective before the entire match completes', async () => {
  request.mockImplementation((path) => path.endsWith('/games/game') ? json({
    ...game, status: 'active', availablePerspectives: [perspectives[0], { ...perspectives[1], allowed: false }],
    privacy: { canGrantLegacy: false, fullAvailable: false, viewerSeatId: 'alice-seat' },
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
  fireEvent.click(await screen.findByRole('switch', { name: 'Show both hands' }));
  await waitFor(() => expect(oldResponse).toBeDefined());
  act(() => useSession.setState({ userName: 'Bob' }));
  await waitFor(() => expect(screen.getByLabelText('Perspective')).toBeTruthy());
  await act(async () => oldResponse!(await json({ events: [{ cursor: 2, view, hands: { 'bob-player': hiddenHand } }] })));
  expect(screen.getByTestId('full-hands').textContent).toBe('');
  expect(screen.queryByRole('switch', { name: 'Show both hands' })).toBeNull();
});
