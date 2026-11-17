import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameSession } from '../../core/game/gameSession';
import type { EventBus } from '../../core/rpc/EventBus';
import type { GameView } from '../../protocol/generated/views';
import { isSiteToolOrigin } from '../webmcp';
import { useMatchSiteTools } from './useMatchSiteTools';

type BrowserTool = {
  name: string;
  execute(input: Record<string, unknown>, options?: { signal: AbortSignal }): unknown;
};

const tools = new Map<string, BrowserTool>();
const registerTool = vi.fn((tool: BrowserTool, { signal }: { signal: AbortSignal }) => {
  tools.set(tool.name, tool);
  signal.addEventListener('abort', () => tools.delete(tool.name), { once: true });
});

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
  Object.defineProperty(document, 'modelContext', { configurable: true, value: { registerTool } });
});

afterEach(() => {
  Reflect.deleteProperty(document, 'modelContext');
  tools.clear();
  registerTool.mockClear();
  vi.unstubAllGlobals();
});

function fixture(mode: 'play' | 'watch' = 'play') {
  const listeners = new Map<string, (data: unknown, event: { objectId: string }) => void>();
  const bus = {
    on(method: string, handler: (data: unknown, event: { objectId: string }) => void) {
      listeners.set(method, handler);
      return () => listeners.delete(method);
    },
  } as unknown as EventBus;
  const api = { sendPlayerUUID: vi.fn(async () => true), sendPlayerBoolean: vi.fn(async () => true) };
  const session = new GameSession(api as never, bus, { gameId: 'game', playerId: mode === 'play' ? 'one' : null, mode });
  const opponent = {
    playerId: 'two', name: 'Roberto', handCount: 5,
    hand: { private: { name: 'Opponent secret' } },
    battlefield: { hidden: { id: 'hidden', name: 'Face-down secret', faceDown: true } },
  };
  const view: GameView = {
    myPlayerId: 'one', activePlayerName: 'Felipe', priorityPlayerName: 'Felipe',
    turn: 2, step: 'PRECOMBAT_MAIN',
    myHand: { forest: { id: 'forest', name: 'Forest', cardTypes: ['LAND'] } },
    canPlayObjects: { objects: { forest: {} } },
    players: [{ playerId: 'one', name: 'Felipe', life: 20 }, opponent],
  };
  const emit = (method: string, data: unknown) => act(() => listeners.get(method)?.(data, { objectId: 'game' }));
  const priority = () => emit('GAME_SELECT', { message: 'Play or pass', gameView: view, options: {} });
  const hook = renderHook(({ enabled }) => useMatchSiteTools(session, enabled), {
    initialProps: { enabled: true }, wrapper: StrictMode,
  });
  return { api, session, emit, priority, hook };
}

async function call<Result>(name: string, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Result> {
  await waitFor(() => expect(tools.has(name)).toBe(true));
  return await tools.get(name)!.execute(input, signal ? { signal } : undefined) as Result;
}

type MatchSnapshot = { decision: { id: string; choices: { id: string; label: string }[] } | null };

describe('[PM-AC-08] Site tools for a live Playmat seat', () => {
  it('registers on the configured same-origin server with localhost support', () => {
    vi.stubGlobal('location', new URL('https://mtg.eigen.cl/game/123'));
    expect(isSiteToolOrigin('wss://mtg.eigen.cl/ws')).toBe(true);
    expect(isSiteToolOrigin('wss://other.test/ws')).toBe(false);
    expect(isSiteToolOrigin('ws://mtg.eigen.cl/ws')).toBe(false);
    expect(isSiteToolOrigin('wss://private@mtg.eigen.cl/ws')).toBe(false);
    vi.stubGlobal('location', new URL('http://127.0.0.1:8787/game/123'));
    expect(isSiteToolOrigin('ws://localhost:17172')).toBe(true);
  });

  it('reads only the player view, then submits an offered choice exactly once', async () => {
    const game = fixture();
    try {
      game.priority();
      const state = await call<MatchSnapshot>('get_match_state');
      expect(state).toMatchObject({
        ownHand: [{ name: 'Forest' }],
        players: [{ yourSeat: true }, { yourSeat: false, handCount: 5, battlefield: [{ name: 'Face-down card' }] }],
      });
      expect(JSON.stringify(state)).not.toMatch(/Opponent secret|Face-down secret/);
      const id = state.decision!.choices.find((choice) => choice.label === 'Forest')!.id;
      const decision = { decisionId: state.decision!.id, choiceId: id };
      expect(await call('submit_choice', { ...decision, choiceId: 'not an offered choice' })).toHaveProperty('error');
      expect(await call('submit_choice', decision)).toEqual({ submitted: true });
      expect(await call('submit_choice', decision)).toHaveProperty('error');
      expect(game.api.sendPlayerUUID).toHaveBeenCalledExactlyOnceWith('game', 'forest');
      expect(registerTool).toHaveBeenCalledTimes(3);
    } finally {
      game.session.dispose();
    }
  });

  it('wakes for the next prompt and game end and aborts pending calls when disabled', async () => {
    const game = fixture();
    try {
      game.priority();
      const before = (await call<MatchSnapshot>('get_match_state')).decision!;
      const wait = tools.get('wait_for_decision')!;
      const next = wait.execute({ afterDecisionId: before.id, timeoutMs: 1000 });
      game.priority();
      await expect(next).resolves.toMatchObject({ event: 'decision' });
      const after = (await call<MatchSnapshot>('get_match_state')).decision!;
      expect(after.id).not.toBe(before.id);
      const end = wait.execute({ afterDecisionId: after.id, timeoutMs: 1000 });
      game.emit('GAME_OVER', { message: 'Game over' });
      await expect(end).resolves.toEqual({ event: 'game_over' });
    } finally {
      game.session.dispose();
    }
  });

  it('cancels unfinished waits when the route is left and registers nothing for spectators', async () => {
    const game = fixture();
    try {
      await waitFor(() => expect(tools.has('wait_for_decision')).toBe(true));
      const waiting = tools.get('wait_for_decision')!.execute({ timeoutMs: 1000 });
      const assertAbort = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
      game.hook.unmount();
      await assertAbort;
      expect(tools.size).toBe(0);
      const watcher = fixture('watch');
      try {
        await Promise.resolve();
        expect(tools.size).toBe(0);
      } finally {
        watcher.session.dispose();
      }
    } finally {
      game.session.dispose();
    }
  });
});
