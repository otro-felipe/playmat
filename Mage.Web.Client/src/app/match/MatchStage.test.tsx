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
import type { Prompt } from '../../core/game/prompt';
import { api, rpc } from '../connection';
import { queryClient } from '../queries';
import { useDecks } from '../stores/decks';
import { usePlay } from '../stores/play';
import { useSession } from '../stores/session';
import { useSettings } from '../stores/settings';
import { rememberLook } from '../support/supportData';
import { MatchStage, type MatchStageProps } from './MatchStage';
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
  useSettings.getState().update({ matCloth: 'sand', matArt: 'deck', sound: false, animations: true });
  rememberLook({ name: 'Alice', sleeve: '#20302b', cloth: 'navy' });
  rememberLook({ name: 'Bob', sleeve: '#1f2a44', cloth: 'plum' });
});

afterEach(() => {
  queryClient.clear();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function match(watch = false, seatDisplayNames?: Readonly<Record<string, string>>, publicSpectator?: MatchStageProps['publicSpectator']) {
  const bus = new EventBus(rpc);
  const session = new GameSession(api, bus, { gameId: 'g1', playerId: watch ? null : 'me', mode: watch ? 'watch' : 'play' });
  const state = {
    ...session.getState(),
    view: { players: [
      { playerId: 'me', name: 'Alice', life: 20, handCount: 1 },
      { playerId: 'them', name: 'Bob', life: 20, handCount: 1 },
    ] },
  };
  const stage = (snapshot: GameSessionState) => <QueryClientProvider client={queryClient}><MemoryRouter><MatchStage session={session} state={snapshot} seatDisplayNames={seatDisplayNames} publicSpectator={publicSpectator} /></MemoryRouter></QueryClientProvider>;
  const rendered = render(stage(state));
  return {
    ...rendered,
    updateView(view: GameView, next: boolean | Prompt, status: string | null = null, resyncing = false, rollbackRevision = 0) {
      const prompt = next === true ? parsePrompt('GAME_SELECT', { message: 'Play spells and abilities' }) : next || null;
      const snapshot = { ...state, view, prompt, status, resyncing, rollbackRevision, interaction: deriveInteraction(view, prompt) };
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

test.each([{ targets: ['shock'] }, { targets: [] }])('[READ-AC-005] opens the revealed hand with ineligible cards visible but disabled ($targets)', ({ targets }) => {
  const game = match();
  const cards = {
    swamp: { id: 'swamp', ownerId: 'them', name: 'Swamp' },
    shock: { id: 'shock', ownerId: 'them', name: 'Shock' },
  };
  const prompt = parsePrompt('GAME_TARGET', {
    message: 'Choose a nonland card',
    cardsView1: cards,
    options: { targetZone: 'HAND', possibleTargets: targets },
    flag: targets.length > 0,
  })!;
  game.updateView({ ...BOARD, myHand: { bolt: { id: 'bolt', name: 'Lightning Bolt' } } }, prompt);
  const picker = within(game.getByRole('dialog', { name: 'Choose cards' }));
  expect((picker.getByRole('button', { name: 'Swamp' }) as HTMLButtonElement).disabled).toBe(true);
  expect((picker.getByRole('button', { name: 'Shock' }) as HTMLButtonElement).disabled).toBe(targets.length === 0);
  expect(picker.queryByRole('button', { name: 'Lightning Bolt' })).toBeNull();
  game.dispose();
});

test('[READ-AC-006] groups selectable graveyard cards under their seat names', () => {
  const game = match(false, { Bob: 'Rival' });
  const myCard = { id: 'mine', name: 'Opt' };
  const rivalCard = { id: 'theirs', name: 'Consider' };
  const view: GameView = {
    ...BOARD,
    players: [
      { ...BOARD.players![0], graveyard: { mine: myCard } },
      { ...BOARD.players![1], graveyard: { theirs: rivalCard } },
    ],
  };
  const picked = { message: 'Exile a card from a graveyard', targets: ['mine', 'theirs'], flag: true };
  for (const cardsView1 of [undefined, { mine: myCard, theirs: rivalCard }]) {
    game.updateView(view, parsePrompt('GAME_TARGET', { ...picked, cardsView1 })!);
    const picker = within(game.getByRole('dialog', { name: 'Choose cards' }));
    expect(within(picker.getByRole('region', { name: 'Your graveyard' })).getByRole('button', { name: 'Opt' })).toBeTruthy();
    expect(within(picker.getByRole('region', { name: "Rival's graveyard" })).getByRole('button', { name: 'Consider' })).toBeTruthy();
  }
  game.dispose();
});

test('[READ-AC-007] clears the mark after a private zone change and accepts a fresh reveal', () => {
  const game = match();
  const forest = { id: 'forest', cardId: 'forest', ownerId: 'me', name: 'Forest' };
  const bolt = { id: 'bolt', ownerId: 'me', name: 'Lightning Bolt' };
  const held = { ...BOARD, myHand: { forest, bolt } };
  const marked = () => game.queryByRole('listitem', { name: 'Forest, Revealed' });
  game.updateView(held, false);
  expect(marked()).toBeNull();
  const revealed: GameView['revealed'] = [{ name: 'Duress [1a2]', cards: { forest: { ...forest, zone: 'HAND' } } }];
  game.updateView({ ...held, revealed }, false);
  expect(marked()).toBeTruthy();
  expect(game.getByRole('listitem', { name: 'Lightning Bolt' })).toBeTruthy();
  game.updateView({ ...held, step: 'POSTCOMBAT_MAIN' }, false);
  expect(marked()).toBeTruthy();
  game.updateView({ ...held, myHand: { bolt }, revealed }, false);
  game.updateView({ ...held, revealed }, false);
  expect(game.getByRole('listitem', { name: 'Forest' })).toBeTruthy();
  expect(marked()).toBeNull();
  game.updateView({ ...held, revealed: [...revealed, { ...revealed[0], name: 'Thoughtseize [1a3]' }] }, false);
  expect(marked()).toBeTruthy();
  game.updateView(held, false, null, false, 1);
  expect(marked()).toBeNull();
  game.dispose();
});

test('[READ-AC-007] restores only the hand knowledge from before the target turn and reopens repeated reveals', () => {
  const game = match();
  const forest = { id: 'forest', name: 'Forest', ownerId: 'me', zone: 'HAND' as const };
  const shock = { id: 'shock', name: 'Shock', ownerId: 'them', zone: 'HAND' as const };
  const board = { ...BOARD, myHand: { forest }, players: BOARD.players!.map(p => ({ ...p, handCount: 2 })) };
  const reveal = (card: typeof forest) => [{ name: 'Fixture reveal', cards: { [card.id]: card } }];
  const known = () => game.queryByRole('listitem', { name: 'Forest, Revealed' });
  game.updateView({ ...board, turn: 2, revealed: reveal(forest) }, false);
  game.updateView(board, false);
  expect(known()).toBeTruthy();
  game.updateView({ ...board, myHand: {}, revealed: reveal(shock) }, false);
  const strip = () => game.queryByRole('button', { name: /Revealed: Fixture reveal/ });
  expect(known()).toBeNull();
  fireEvent.click(game.getByRole('button', { name: 'Dismiss revealed cards' }));
  expect(strip()).toBeNull();
  game.updateView({ ...board, knownHandCards: { forest } }, false, null, false, 1);
  expect(known()).toBeTruthy();
  expect(game.queryByLabelText(/cards in hand, revealed: Shock/)).toBeNull();
  expect(strip()).toBeNull();
  game.updateView({ ...board, revealed: reveal(shock) }, false, null, false, 1);
  expect(strip()).toBeTruthy();
  game.dispose();
});

test('[READ-AC-007] reconnect relies on current hand markers even when hand counts did not change', () => {
  const game = match();
  const forest = { id: 'forest', name: 'Forest', ownerId: 'me', zone: 'HAND' as const };
  const shock = { id: 'shock', name: 'Shock', ownerId: 'them', zone: 'HAND' as const };
  const board = { ...BOARD, myHand: { forest }, players: BOARD.players!.map(p => ({ ...p, handCount: 2 })) };
  game.updateView({ ...board, knownHandCards: { forest, shock } }, false);
  expect(game.getByLabelText(/cards in hand, revealed: Shock/)).toBeTruthy();
  expect(game.getByRole('listitem', { name: 'Forest, Revealed' })).toBeTruthy();
  game.updateView({ ...board, knownHandCards: { forest }, revealed: [{ name: 'earlier reveal', cards: { shock } }] }, false);
  expect(game.queryByLabelText(/cards in hand, revealed: Shock/)).toBeNull();
  game.dispose();
});

test('[READ-AC-007] reconnect cannot revive a look from a discarded branch in the same turn', () => {
  const game = match();
  const seen = { ...BOARD, lookedAt: [{ name: 'private look', cards: { card: { id: 'card' } } }] };
  const strip = () => game.queryByRole('button', { name: /Looked at: private look/ });
  game.updateView(seen, false);
  expect(strip()).toBeTruthy();
  game.updateView(seen, false, null, true);
  game.updateView(seen, false); // the transport reports available before delivering the new snapshot
  game.updateView({ ...BOARD, knownHandCards: {} }, false);
  expect(strip()).toBeNull();
  game.dispose();
});

test('[READ-AC-007] a watcher remembers the public reveal as history without tracking a hidden hand', () => {
  const game = match(true);
  const shock = { id: 'shock', name: 'Shock', ownerId: 'them', zone: 'HAND' as const };
  const board = { ...BOARD, myPlayerId: undefined, players: BOARD.players!.map(p => ({ ...p, handCount: 2 })) };
  game.updateView({ ...board, revealed: [{ name: 'public choice', cards: { shock } }] }, false);
  expect(game.queryByLabelText(/cards in hand, revealed: Shock/)).toBeNull();
  game.updateView(board, false);
  expect(game.queryByLabelText(/cards in hand, revealed: Shock/)).toBeNull();
  expect(game.getByRole('button', { name: /Revealed: public choice/ })).toBeTruthy();
  game.updateView(board, false, null, false, 1);
  expect(game.queryByRole('button', { name: /Revealed: public choice/ })).toBeNull();
  game.dispose();
});

test('[PM-AC-01] priority can change without moving the phase and the stack changes the offered action', () => {
  const game = match(false, { Bob: 'CodexRival' });
  game.updateView(BOARD, true);
  const phases = within(game.getByRole('navigation', { name: /turn 3/i }));
  expect(within(game.getByRole('region', { name: 'Your decision' })).getByRole('navigation', { name: /turn 3/i })).toBeTruthy();
  expect(phases.getAllByRole('button')).toHaveLength(5);
  expect(phases.getByRole('button', { name: 'Main I' }).getAttribute('aria-current')).toBe('step');
  expect(game.getByRole('button', { name: /^Go to combat$/i })).toBeTruthy();

  game.updateView({ ...BOARD, priorityPlayerName: 'Bob' }, false, 'Precombat Main - Waiting for Bob');
  expect(phases.getByRole('button', { name: 'Main I' }).getAttribute('aria-current')).toBe('step');
  expect(phases.getByText('Main I', { exact: true })).toBeTruthy();
  expect(game.queryByText(/Precombat Main|Waiting for (Bob|CodexRival)|Your turn ·/i)).toBeNull();
  expect(game.getByRole('navigation', { name: /turn 3/i }).getAttribute('aria-description')).toContain('Waiting for CodexRival');
  expect(game.container.querySelector('[data-object-id="them"]')?.getAttribute('aria-label')).toContain('CodexRival, 20 life');

  game.updateView({ ...BOARD, stack: { shock: { name: 'Shock' } } }, true);
  expect(phases.getByRole('button', { name: 'Main I' }).getAttribute('aria-current')).toBe('step');
  expect(game.getByRole('button', { name: /^Pass$/i })).toBeTruthy();
  game.dispose();
});

test('[PM-AC-03] a new live draw flies from the library once without animating opening hands and resyncs', () => {
  // Happy DOM does not perform layout; the stage needs a measurable frame and card bounds.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1440, 810));
  const game = match();
  const drawn = { id: 'drawn', name: 'Plains' };
  const draw = { kind: 'DRAW' as const, seq: 1, playerId: 'me', targetId: 'drawn' };
  const initial = { ...BOARD, turn: 0, step: undefined, myHand: { drawn }, events: [draw] };
  const effects = () => game.container.querySelectorAll('[data-draw-animation]');
  const frame = () => act(() => { vi.advanceTimersByTime(20); });

  game.updateView(initial, false);
  frame();
  expect(effects()).toHaveLength(0);

  game.updateView(BOARD, false);
  const view = { ...BOARD, myHand: { drawn }, events: [{ ...draw, seq: 2 }] };
  game.updateView(view, false);
  expect(game.container.querySelector('[data-object-id="library:me"]')).toBeTruthy();
  expect(game.container.querySelector('[data-object-id="drawn"]')).toBeTruthy();
  frame();
  expect(effects()).toHaveLength(1);

  game.updateView({ ...view }, true);
  frame();
  expect(effects()).toHaveLength(1);

  act(() => { vi.advanceTimersByTime(1000); });
  game.updateView({ ...view, events: [{ ...draw, seq: 3 }] }, false, null, true);
  frame();
  expect(effects()).toHaveLength(0);

  // Resuming from the same snapshot or drawing with reduced motion enables neither effect.
  game.updateView({ ...view, events: [{ ...draw, seq: 3 }] }, false);
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const originalMatchMedia = window.matchMedia;
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => query === media.media
    ? { ...media, matches: true }
    : originalMatchMedia.call(window, query));
  const next = { id: 'next', name: 'Swamp' };
  game.updateView({ ...view, myHand: { drawn, next }, events: [{ ...draw, seq: 4, targetId: 'next' }] }, false);
  frame();
  expect(effects()).toHaveLength(0);
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
  const { container, dispose, getByRole, queryByRole } = match(true);
  expect(getByRole('button', { name: /^Log$/ })).toBeTruthy();
  expect(queryByRole('button', { name: /^Chat$/ })).toBeNull();
  expect(container.querySelector('[data-cloth="navy"]')).toBeTruthy();
  expect(container.querySelector('[data-cloth="sand"]')).toBeNull();
  const ownPlate = container.querySelector('[data-object-id="me"]');
  const theirPlate = container.querySelector('[data-object-id="them"]');
  expect(ownPlate?.getAttribute('style')).toContain('#1f2a44');
  expect(theirPlate?.getAttribute('style')).not.toContain('#1f2a44');
  dispose();
});

test('ordinary game seats never mount broadcast commentary, including with identical seat and game IDs', () => {
  const game = match(false, undefined, { events: [{ gameId: 'g1', key: 'line', kind: 'line', playerId: 'me',
    at: Date.now(), playerName: 'Alice', text: 'Audience only fixture' }] });
  expect(game.queryByText('Audience only fixture')).toBeNull();
  fireEvent.click(game.getByRole('button', { name: /^Chat$/ }));
  expect(game.queryByText('Audience only fixture')).toBeNull();
  game.dispose();
});

test('land animation compares identical legal targets by engine state before deciding and keeps mana independent', () => {
  const game = match();
  const first = { id: 'old', name: 'Forest', cardTypes: ['LAND' as const], zone: 'BATTLEFIELD' as const, summoningSickness: false };
  const fresh = { ...first, id: 'new', summoningSickness: true };
  const unknown = { ...first, id: 'legacy', summoningSickness: undefined };
  const view: GameView = { ...BOARD, players: [{ ...BOARD.players![0], battlefield: { old: first, new: fresh, legacy: unknown } }, BOARD.players![1]],
    canPlayObjects: { objects: { old: {}, new: {}, legacy: {} } } };
  const card = (id: string) => game.container.querySelector<HTMLElement>(`[data-object-id="${id}"]`)!;
  game.updateView(view, true);
  expect(card('new').textContent).toContain('Recent control');
  expect(card('old').textContent).not.toContain('Recent control');
  expect(card('new').getAttribute('aria-label')).not.toContain('summoning sick');
  expect(card('new').parentElement).not.toBe(card('old').parentElement);
  expect(card('new').getAttribute('role')).toBe('button');

  game.updateView(view, parsePrompt('GAME_PLAY_MANA', { message: 'Pay green mana' })!);
  expect(card('new').getAttribute('role')).toBe('button');
  expect(card('new').textContent).not.toContain('Needs haste');
  expect(game.queryByRole('dialog', { name: 'Choose a land to animate' })).toBeNull();

  const target = (intent?: string) => parsePrompt('GAME_TARGET', {
    message: 'Choose target land', targets: ['old', 'new', 'legacy'], flag: true,
    options: intent ? { targetAnimation: intent } : {},
  })!;
  game.updateView(view, target());
  expect(game.queryByRole('dialog', { name: 'Choose a land to animate' })).toBeNull();
  expect(card('new').textContent).not.toContain('Needs haste');
  const mixed = parsePrompt('GAME_TARGET', { message: 'Choose a target', targets: ['new', 'them'], flag: true,
    options: { targetAnimation: 'becomesCreature' } })!;
  game.updateView(view, mixed);
  expect(game.queryByRole('dialog', { name: 'Choose a land to animate' })).toBeNull();
  expect(card('new').textContent).toContain('Needs haste');
  game.updateView(view, target('becomesCreature'));
  const choose = within(game.getByRole('dialog', { name: 'Choose a land to animate' }));
  const recent = choose.getByRole('button', { name: 'Forest', description: /needs haste to attack/i });
  expect((recent as HTMLButtonElement).disabled).toBe(false);
  expect(choose.getByRole('button', { name: 'Forest', description: /no summoning sickness indicated/i })).toBeTruthy();
  expect(choose.getByRole('button', { name: 'Forest', description: /unknown/i })).toBeTruthy();
  fireEvent.click(choose.getByRole('button', { name: 'See the board' }));
  expect(card('new').textContent).toContain('Needs haste');
  expect(card('old').textContent).not.toContain('Needs haste');
  game.updateView(view, target('grantsHaste'));
  expect(card('new').textContent).toContain('Grants haste');
  expect(card('new').textContent).not.toContain('Needs haste');
  game.updateView(view, true);
  expect(card('new').textContent).toContain('Recent control');
  expect(card('new').textContent).not.toContain('Grants haste');
  const animated = { ...fresh, cardTypes: ['LAND' as const, 'CREATURE' as const] };
  game.updateView({ ...view, players: [{ ...view.players![0], battlefield: { new: animated } }, BOARD.players![1]] }, true);
  expect(card('new').getAttribute('aria-label')).toContain('summoning sick');
  expect(card('new').textContent).not.toContain('Recent control');
  game.dispose();
});
