import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useStore } from 'zustand';
import { GameSession } from '../../core/game/gameSession';
import { deriveInteraction } from '../../core/game/interaction';
import { parsePrompt, type Prompt } from '../../core/game/prompt';
import type { Api } from '../../protocol/generated/api';
import type { GameView, PlayerView } from '../../protocol/generated/views';
import { createFakeConnection } from '../../test/fakeConnection';
import { buildPlayerBoard } from './boardModel';
import { useAutoPay } from './useAutoPay';

afterEach(() => { vi.useRealTimers(); });
const forest = { id: 'forest', cardTypes: ['LAND' as const], subTypes: ['FOREST' as const] };
const island = { id: 'island', cardTypes: ['LAND' as const], subTypes: ['ISLAND' as const] };
const player: PlayerView = { playerId: 'me', battlefield: { forest, island } };

function setup(enabled = false) {
  vi.useFakeTimers();
  const connection = createFakeConnection();
  const session = new GameSession(connection.api as unknown as Api, connection.events, { gameId: 'g', playerId: 'me', mode: 'play' });
  function ask(cost: string | null, me = player, given?: Prompt) {
    const prompt = given ?? parsePrompt(cost ? 'GAME_PLAY_MANA' : 'GAME_SELECT', { message: cost ? `Pay ${cost}` : 'Play spells and abilities' })!;
    const view: GameView = { myPlayerId: 'me', players: [me], canPlayObjects: { objects: Object.fromEntries(Object.keys(me.battlefield ?? {}).map((id) => [id, {}])) } };
    act(() => session.store.setState({ view, prompt, interaction: deriveInteraction(view, prompt), awaitingServer: false }));
  }
  ask('{1}{G}');
  const hook = renderHook(() => {
    const state = useStore(session.store);
    const me = state.view?.players?.[0];
    return useAutoPay(session, state, me ? buildPlayerBoard(me, true) : null, enabled, { hybrid: true });
  });
  const flushReadyTap = () => act(() => { vi.advanceTimersByTime(0); });
  const dispose = () => { hook.unmount(); session.dispose(); connection.events.dispose(); };
  return { ...hook, session, connection, ask, flushReadyTap, dispose };
}

test('one explicit request pays each confirmed step without a timed pause, despite repeated clicks', () => {
  const game = setup();
  game.flushReadyTap();
  expect(game.connection.api.sendPlayerUUID).not.toHaveBeenCalled();
  act(() => { game.result.current.start(); game.result.current.start(); });
  game.flushReadyTap();
  expect(game.connection.api.sendPlayerUUID).toHaveBeenCalledExactlyOnceWith('g', 'forest');
  game.flushReadyTap();
  expect(game.connection.api.sendPlayerUUID).toHaveBeenCalledTimes(1);
  game.ask('{1}', { ...player, battlefield: { forest: { ...forest, tapped: true }, island } });
  game.flushReadyTap();
  expect(game.connection.api.sendPlayerUUID).toHaveBeenLastCalledWith('g', 'island');
  game.ask(null);
  game.ask('{G}');
  game.flushReadyTap();
  expect(game.connection.api.sendPlayerUUID).toHaveBeenCalledTimes(2);
  game.dispose();
});

test('cancel stops a scheduled tap immediately and never restarts for the next unpaid prompt', () => {
  const game = setup(true);
  act(() => { game.result.current.stop(); game.session.cancelPayment(); });
  game.flushReadyTap();
  expect(game.connection.api.sendPlayerUUID).not.toHaveBeenCalled();
  expect(game.connection.api.sendPlayerBoolean).toHaveBeenCalledExactlyOnceWith('g', false);
  game.ask('{G}');
  game.flushReadyTap();
  expect(game.connection.api.sendPlayerUUID).not.toHaveBeenCalled();
  game.dispose();
});

test('cancel during an in-flight tap leaves the next prompt to cancellation', () => {
  const game = setup();
  act(() => game.result.current.start());
  game.flushReadyTap();
  act(() => { game.result.current.stop(); game.session.cancelPayment(); });
  game.ask('{1}', { ...player, battlefield: { forest: { ...forest, tapped: true }, island } });
  game.flushReadyTap();
  expect(game.connection.api.sendPlayerUUID).toHaveBeenCalledTimes(1);
  game.dispose();
});

test('cancel can stop the next scheduled tap after the server confirms the first', () => {
  const game = setup();
  act(() => game.result.current.start());
  game.flushReadyTap();
  game.ask('{1}', { ...player, battlefield: { forest: { ...forest, tapped: true }, island } });
  act(() => { game.result.current.stop(); game.session.cancelPayment(); });
  game.flushReadyTap();
  expect(game.connection.api.sendPlayerUUID).toHaveBeenCalledExactlyOnceWith('g', 'forest');
  expect(game.connection.api.sendPlayerBoolean).toHaveBeenCalledExactlyOnceWith('g', false);
  game.dispose();
});

test('manual pool mode spends floating mana instead of tapping again or hanging', () => {
  const game = setup();
  game.ask('{G}', { playerId: 'me', manaPool: { green: 1 }, battlefield: {} });
  act(() => game.result.current.start());
  game.flushReadyTap();
  expect(game.connection.api.sendPlayerManaType).toHaveBeenCalledExactlyOnceWith('g', 'me', 'GREEN');
  expect(game.connection.api.sendPlayerUUID).not.toHaveBeenCalled();
  game.dispose();
});

test('no-progress and insufficient mana stop safely with a visible manual fallback', () => {
  const game = setup();
  act(() => game.result.current.start());
  game.flushReadyTap();
  game.ask('{1}{G}');
  game.flushReadyTap();
  expect(game.connection.api.sendPlayerUUID).toHaveBeenCalledTimes(1);
  expect(game.result.current).toMatchObject({ available: false, busy: false, reason: 'manual' });
  game.ask('{4}{G}');
  expect(game.result.current).toMatchObject({ available: false, busy: false, reason: 'insufficient' });
  game.dispose();
});


test('a one-shot request follows a dual land ability choice and continues the remaining payment', () => {
  const game = setup();
  const dual = { id: 'dual', cardTypes: ['LAND' as const], subTypes: ['FOREST' as const, 'ISLAND' as const] };
  const second = { ...dual, id: 'second' };
  const me = { playerId: 'me', battlefield: { dual, second } };
  game.ask('{G}{U}', me);
  act(() => game.result.current.start());
  game.flushReadyTap();
  expect(game.connection.api.sendPlayerUUID).toHaveBeenLastCalledWith('g', 'dual');
  game.ask(null, me, parsePrompt('GAME_CHOOSE_ABILITY', { choices: { green: '{T}: Add {G}.', blue: '{T}: Add {U}.' } })!);
  expect(game.connection.api.sendPlayerUUID).toHaveBeenLastCalledWith('g', 'blue');
  game.ask('{G}', { ...me, battlefield: { dual: { ...dual, tapped: true }, second } });
  game.flushReadyTap();
  expect(game.connection.api.sendPlayerUUID).toHaveBeenLastCalledWith('g', 'second');
  game.dispose();
});
