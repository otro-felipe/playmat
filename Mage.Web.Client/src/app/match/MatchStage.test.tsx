import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GameSession, type GameSessionState } from '../../core/game/gameSession';
import { deriveInteraction } from '../../core/game/interaction';
import { parsePrompt } from '../../core/game/prompt';
import { EventBus } from '../../core/rpc/EventBus';
import { loadTestCatalog } from '../../test/catalog';
import type { GameView } from '../../protocol/generated/views';
import { api, rpc } from '../connection';
import { queryClient } from '../queries';
import { useDecks } from '../stores/decks';
import { usePlay } from '../stores/play';
import { useSession } from '../stores/session';
import { useSettings } from '../stores/settings';
import { rememberLook } from '../support/supportData';
import { MatchStage } from './MatchStage';
import type { MatCloth } from './playmats';

vi.mock('./MatPrint', () => ({
  MatPrint: ({ cloth, enabled }: { cloth: MatCloth | null; enabled: boolean }) => <div data-cloth={cloth?.id} data-print={enabled} />,
}));

beforeEach(() => {
  vi.useFakeTimers();
  loadTestCatalog();
  queryClient.setQueryData(['serverInfo'], { accounts: true });
  useSession.setState({ phase: 'signedIn', userName: 'Alice' });
  usePlay.setState({ deckId: 'starter:test', returnPath: null });
  useDecks.setState({
    saved: [], sleeves: { 'starter:test': '#6e3f24' },
    starters: [{ file: 'test', name: 'Test', cards: 60, cover: { name: 'Forest', setCode: 'M21', cardNumber: '274' } }],
  });
  useSettings.getState().update({ matCloth: 'sand', matArt: 'deck', sound: false });
  rememberLook({ name: 'Alice', sleeve: '#20302b', cloth: 'navy' });
  rememberLook({ name: 'Bob', sleeve: '#1f2a44', cloth: 'plum' });
});

afterEach(() => {
  queryClient.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function match(watch = false) {
  const bus = new EventBus(rpc);
  const session = new GameSession(api, bus, { gameId: 'g1', playerId: watch ? null : 'me', mode: watch ? 'watch' : 'play' });
  const state = {
    ...session.getState(),
    view: { players: [
      { playerId: 'me', name: 'Alice', life: 20, handCount: 1 },
      { playerId: 'them', name: 'Bob', life: 20, handCount: 1 },
    ] },
  };
  const stage = (snapshot: GameSessionState) => <QueryClientProvider client={queryClient}><MemoryRouter><MatchStage session={session} state={snapshot} /></MemoryRouter></QueryClientProvider>;
  const rendered = render(stage(state));
  return {
    ...rendered,
    updateView(view: GameView, hasPrompt: boolean) {
      const prompt = hasPrompt ? parsePrompt('GAME_SELECT', { message: 'Play spells and abilities' }) : null;
      const snapshot = { ...state, view, prompt, interaction: deriveInteraction(view, prompt) };
      act(() => {
        session.store.setState(snapshot);
        rendered.rerender(stage(snapshot));
      });
    },
    dispose: () => { rendered.unmount(); session.dispose(); bus.dispose(); },
  };
}

const BOARD: GameView = {
  myPlayerId: 'me',
  activePlayerId: 'me',
  activePlayerName: 'Alice',
  priorityPlayerName: 'Alice',
  turn: 3,
  step: 'PRECOMBAT_MAIN',
  stack: {},
  players: [{ playerId: 'me', name: 'Alice', life: 20 }, { playerId: 'them', name: 'Bob', life: 20 }],
  canPlayObjects: { objects: { bolt: {} } },
};

test('[PM-AC-01] priority can change without moving the phase and the stack changes the offered action', () => {
  const game = match();
  game.updateView(BOARD, true);
  const phases = within(game.getByRole('navigation', { name: /turn 3/i }));
  expect(phases.getAllByRole('button')).toHaveLength(5);
  expect(phases.getByRole('button', { name: 'Main I' }).getAttribute('aria-current')).toBe('step');
  expect(game.getByRole('button', { name: /^Go to combat$/i })).toBeTruthy();

  game.updateView({ ...BOARD, priorityPlayerName: 'Bob' }, false);
  expect(phases.getByRole('button', { name: 'Main I' }).getAttribute('aria-current')).toBe('step');
  expect(game.getByText('Your turn · Waiting for Bob')).toBeTruthy();

  game.updateView({ ...BOARD, stack: { shock: { name: 'Shock' } } }, true);
  expect(phases.getByRole('button', { name: 'Main I' }).getAttribute('aria-current')).toBe('step');
  expect(game.getByRole('button', { name: /^Pass$/i })).toBeTruthy();
  game.dispose();
});

test('[PM-AC-02] a phase tap sets a stop for this turn while leaving persistent preferences unchanged', () => {
  const game = match();
  const settings = useSettings.getState().settings.stops;
  game.updateView(BOARD, true);
  const phase = () => game.getByRole('button', { name: /^Combat$/ });
  expect(phase().getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(phase());
  expect(phase().getAttribute('aria-pressed')).toBe('true');
  expect(useSettings.getState().settings.stops).toEqual(settings);
  game.updateView({ ...BOARD, turn: 4 }, true);
  expect(phase().getAttribute('aria-pressed')).toBe('false');
  game.dispose();
});

test('the own seat uses the local deck sleeve and cloth immediately, even while the server look is stale', () => {
  const { container, dispose } = match();
  const ownPlate = container.querySelector('[data-object-id="me"]');
  expect(ownPlate).toBeTruthy();
  expect(container.querySelector('[data-cloth="sand"]')).toBeTruthy();
  expect(container.querySelector('[data-cloth="plum"]')).toBeTruthy();
  expect(container.querySelector('[data-cloth="navy"]')).toBeNull();
  expect(ownPlate?.getAttribute('style')).toContain('#6e3f24');
  act(() => useSettings.getState().update({ matCloth: 'teal' }));
  expect(container.querySelector('[data-cloth="teal"]')).toBeTruthy();
  act(() => useDecks.setState({ sleeves: { 'starter:test': '#24403f' } }));
  expect(ownPlate?.getAttribute('style')).toContain('#24403f');
  act(() => rememberLook({ name: 'Alice', sleeve: '#5a2320', cloth: 'oxblood' }));
  expect(ownPlate?.getAttribute('style')).toContain('#24403f');
  expect(container.querySelector('[data-cloth="teal"]')).toBeTruthy();
  act(() => useSettings.getState().update({ matArt: 'none' }));
  expect(container.querySelectorAll('[data-print="false"]').length).toBe(2);
  dispose();
});

test('watching uses the seated players server looks and contrasts identical sleeves', () => {
  rememberLook({ name: 'Alice', sleeve: '#1f2a44', cloth: 'navy' });
  const { container, dispose } = match(true);
  expect(container.querySelector('[data-cloth="navy"]')).toBeTruthy();
  expect(container.querySelector('[data-cloth="sand"]')).toBeNull();
  const ownPlate = container.querySelector('[data-object-id="me"]');
  const theirPlate = container.querySelector('[data-object-id="them"]');
  expect(ownPlate?.getAttribute('style')).toContain('#1f2a44');
  expect(theirPlate?.getAttribute('style')).not.toContain('#1f2a44');
  dispose();
});
