import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { BuildScreen } from '../events/BuildScreen';
import { GameScreen } from '../screens/GameScreen';
import { api, events } from '../connection';
import { queryClient } from '../queries';
import { useEvents } from './events';
import { useGames } from './games';
import { useSession } from './session';
import type { GameView } from '../../protocol/generated/views';
import { parsePrompt } from '../../core/game/prompt';
import { deriveInteraction } from '../../core/game/interaction';
import { RequestDialog } from '../RequestDialog';

vi.mock('../playtesting', async (original) => ({ ...await original<typeof import('../playtesting')>(), PRIVATE_PLAYTESTING: true }));

afterEach(() => {
  cleanup();
  for (const id of Object.keys(useGames.getState().sessions)) useGames.getState().forget(id);
  useEvents.setState({ construct: null });
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(result: { status: number; humanName?: string; allowed?: boolean }, tableId: string | null = 'duel') {
  useSession.setState({ userName: 'Alice', phase: 'signedIn', connection: 'open' });
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    if (String(input).includes('/human-seat/')) {
      await ready;
      return Response.json({ tableId: 'duel', humanMcpAllowed: result.allowed ?? true, humanName: result.humanName }, { status: result.status });
    }
    return Response.json({});
  }));
  const session = useGames.getState().open('game', 'alice-id', 'play', { tableId, parentTableId: null });
  const view: GameView = { myPlayerId: 'alice-id', activePlayerId: 'alice-id', turn: 2, step: 'PRECOMBAT_MAIN',
    players: [{ playerId: 'alice-id', name: 'Alice', life: 20 }, { playerId: 'other', name: 'Rival', life: 20 }],
    myHand: { forest: { id: 'forest', name: 'Forest' } } };
  const prompt = parsePrompt('GAME_SELECT', { message: 'Play spells and abilities' });
  session.store.setState({ view, prompt, interaction: deriveInteraction(view, prompt) });
  return { session, release: () => act(async () => { release(); await ready; }) };
}

test('a human MCP seat observes its live private board without commands from mount through exit', async () => {
  const { session, release } = setup({ status: 200, humanName: 'ALICE' });
  const answer = vi.spyOn(api, 'sendPlayerBoolean').mockResolvedValue(true);
  const action = vi.spyOn(api, 'sendPlayerAction').mockResolvedValue(true);
  const quit = vi.spyOn(api, 'matchQuit').mockResolvedValue(true);
  const resync = vi.spyOn(api, 'gameResync').mockResolvedValue(true);
  const page = render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/game/game']}><Routes>
    <Route path="/game/:gameId" element={<><GameScreen /><RequestDialog /></>} /><Route path="/" element={<h1>Home</h1>} />
  </Routes></MemoryRouter></QueryClientProvider>);
  await session.respond({ type: 'boolean', value: true });
  expect(answer).not.toHaveBeenCalled();
  await release();
  expect(await page.findByText('Player controlled by MCP · Read only')).toBeTruthy();
  expect(page.getAllByLabelText(/Forest/i).length).toBeGreaterThan(0);
  expect(page.queryByRole('button', { name: /pass turn|pass priority|keep hand|mulligan/i })).toBeNull();
  act(() => { events.dispatch({ method: 'USER_REQUEST_DIALOG', objectId: 'game', messageId: 1, data: {
    gameId: 'game', title: 'Reveal your hand?', button1Action: 'ADD_PERMISSION_TO_SEE_HAND_CARDS', button1Text: 'Reveal cards',
  } }); });
  expect(page.queryByRole('button', { name: 'Reveal cards' })).toBeNull();
  expect(page.queryByRole('button', { name: 'Game menu' })).toBeNull();
  fireEvent.keyDown(document, { key: ' ' });
  await session.respond({ type: 'action', action: 'CONCEDE' });
  expect(action).not.toHaveBeenCalled();
  await act(async () => { await session.resync(); });
  expect(resync).toHaveBeenCalledWith('game');
  fireEvent.click(page.getByRole('button', { name: 'Back to Play' }));
  expect(page.getByRole('heading', { name: 'Home' })).toBeTruthy();
  expect(quit).not.toHaveBeenCalled();
  expect(useGames.getState().sessions.game).toBe(session);
});

test.each([{ status: 200, humanName: 'Other' }, { status: 200, humanName: 'ALICE', allowed: false }, { status: 404 }])('a different human or a legacy table regains ordinary controls after verification ($status)', async (result) => {
  const { session, release } = setup(result);
  const answer = vi.spyOn(api, 'sendPlayerBoolean').mockResolvedValue(true);
  await release();
  await waitFor(async () => {
    await session.respond({ type: 'boolean', value: true });
    expect(answer).toHaveBeenCalled();
  });
});

test.each([{ status: 503 }, { status: 200, humanName: 'Alice' }])('sideboarding keeps the delegated or unverified seat from editing or submitting ($status)', async (result) => {
  const { release } = setup(result);
  const submit = vi.spyOn(api, 'submitDeck').mockResolvedValue(true);
  useEvents.setState({ construct: { kind: 'sideboard', limited: false, tableId: 'duel', parentTableId: null, deadline: null, submitted: false, deck: { cards: {}, sideboard: {} } } });
  const page = render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={['/build/duel']}><Routes>
    <Route path="/build/:tableId" element={<BuildScreen />} />
  </Routes></MemoryRouter></QueryClientProvider>);
  expect(page.queryByRole('button', { name: 'Submit deck' })).toBeNull();
  await release();
  expect(await page.findByText(result.status === 503 ? 'Match permissions unavailable' : 'Player controlled by MCP · Read only')).toBeTruthy();
  await act(async () => { await useEvents.getState().submit({ name: 'deck', cards: [], sideboard: [] }); });
  expect(submit).not.toHaveBeenCalled();
});

test('restoring a private game without its table id waits until START_GAME identifies the table', async () => {
  const { session, release } = setup({ status: 200, humanName: 'Alice' }, null);
  await release();
  expect(session.getState().browserInputLock).toBe('pending');
  expect(useGames.getState().open('game', 'alice-id', 'play', { tableId: 'duel', parentTableId: null })).toBe(session);
  await waitFor(() => expect(session.getState().browserInputLock).toBe('delegated'));
});
