// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ACTION_BEAT_MS } from '../../core/game/actionPresentation';
import { GameSession } from '../../core/game/gameSession';
import { createFakeConnection, type FakeConnection } from '../../test/fakeConnection';
import type { GameView } from '../../protocol/generated/views';

describe('[READ-AC-003] autopass presentation cadence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function game() {
    vi.resetModules();
    vi.doMock('../connection', () => createFakeConnection());
    const connection = await import('../connection') as unknown as FakeConnection;
    const { useAutoPass } = await import('./useAutoPass');
    const { useSettings } = await import('../stores/settings');
    useSettings.setState((state) => ({ settings: { ...state.settings, autoPass: true, stops: { yourTurn: {}, opponentTurn: {} } } }));
    const session = new GameSession(connection.api as never, connection.events, { gameId: 'g', playerId: 'me', mode: 'play' });
    let seq = 0;
    const view: GameView = { myPlayerId: 'me', activePlayerId: 'rival', turn: 4, step: 'PRECOMBAT_MAIN', players: [{ playerId: 'me', hasPriority: true }, { playerId: 'rival', name: 'Bob' }], stack: { bolt: { name: 'Lightning Bolt', targets: ['me'] } } };
    const prompt = (next = view) => connection.rpc.emit({ method: 'GAME_SELECT', objectId: 'g', messageId: ++seq, data: { message: 'Play spells and abilities', gameView: next } });
    prompt();
    const hook = renderHook(() => useAutoPass(session, session.getState(), true, true));
    return { connection, session, prompt, view, hook, close: () => { hook.unmount(); session.dispose(); } };
  }

  test('leaves a complete reading beat for a targeted stack object even while passing the turn', async () => {
    const { connection, session, close } = await game();
    act(() => vi.advanceTimersByTime(ACTION_BEAT_MS - 1));
    expect(connection.api.sendPlayerBoolean).not.toHaveBeenCalled();
    expect(session.getState().view?.stack?.bolt.targets).toEqual(['me']);
    act(() => vi.advanceTimersByTime(1));
    expect(connection.api.sendPlayerBoolean).toHaveBeenCalledWith('g', false);
    close();
  });

  test('manual priority responses are immediate during the presentation beat', async () => {
    const { connection, session, close } = await game();
    await act(async () => { await session.respond({ type: 'boolean', value: false }); });
    expect(connection.api.sendPlayerBoolean).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(ACTION_BEAT_MS));
    expect(connection.api.sendPlayerBoolean).toHaveBeenCalledTimes(1);
    close();
  });

  test('does not answer a newer prompt arriving before React cleans up the old timer', async () => {
    const { connection, prompt, view, close } = await game();
    act(() => prompt({ ...view, turn: 5 }));
    act(() => vi.advanceTimersByTime(ACTION_BEAT_MS));
    expect(connection.api.sendPlayerBoolean).not.toHaveBeenCalled();
    close();
  });

  test.each(['disconnect', 'end', 'targets'] as const)('rejects the old automated answer after %s', async (change) => {
    const { connection, session, close } = await game();
    act(() => {
      if (change === 'disconnect') session.markResyncing();
      if (change === 'end') session.store.setState({ gameOver: 'Game over' });
      if (change === 'targets') session.store.setState((state) => ({ view: { ...state.view, stack: { bolt: { name: 'Lightning Bolt', targets: ['rival'] } } } }));
    });
    act(() => vi.advanceTimersByTime(ACTION_BEAT_MS));
    expect(connection.api.sendPlayerBoolean).not.toHaveBeenCalled();
    close();
  });

  test('rechecks the live settings before executing a previously scheduled automated answer', async () => {
    const { connection, session, hook, close } = await game();
    const { useSettings } = await import('../stores/settings');
    // Ordinary smart pass, rather than the explicit pass-turn override.
    hook.unmount();
    const { useAutoPass } = await import('./useAutoPass');
    const ordinary = renderHook(() => useAutoPass(session, session.getState(), true));
    act(() => useSettings.setState({ fullControl: true }));
    act(() => vi.advanceTimersByTime(ACTION_BEAT_MS));
    expect(connection.api.sendPlayerBoolean).not.toHaveBeenCalled();
    ordinary.unmount();
    close();
  });
});
