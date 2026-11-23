import { QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { queryClient } from '../queries';
import { SpectatorBroadcast } from './SpectatorScreen';

afterEach(() => { vi.unstubAllGlobals(); queryClient.clear(); });

test.each(['public-board', 'both-hands'])('a %s broadcast drops abandoned reveals on a committed rollback to the same turn', async visibility => {
  const players = [{ playerId: 'a', name: 'Alice', life: 20 }, { playerId: 'b', name: 'Bob', life: 20 }];
  const view = { turn: 8, activePlayerId: 'a', activePlayerName: 'Alice', step: 'PRECOMBAT_MAIN', players };
  const frame = { role: 'spectator', gameId: 'fixture', visibility, status: 'playing', spectators: 1,
    revision: 10, view, players, hands: {}, lines: [], chat: [] };
  const revealed = [{ name: 'Public fixture', cards: { land: { id: 'land', name: 'Forest', ownerId: 'a', zone: 'GRAVEYARD' } } }];
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...frame, view: { ...view, revealed } })));
  class FixtureStream extends EventTarget {
    close() {}
  }
  const stream = new FixtureStream();
  vi.stubGlobal('EventSource', vi.fn(function () { return stream; }));
  const board = render(<MemoryRouter><QueryClientProvider client={queryClient}><SpectatorBroadcast endpoint="/fixture" /></QueryClientProvider></MemoryRouter>);
  const label = { name: /Revealed: Public fixture/ };
  expect(await board.findByRole('button', label)).toBeTruthy();
  const update = (payload: object) => act(() => { stream.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(payload) })); });
  update({ ...frame, revision: 11 });
  expect(board.getByRole('button', label)).toBeTruthy();
  update({ ...frame, revision: 15, rollbackRevision: 2 });
  expect(board.queryByRole('button', label)).toBeNull();
  update({ ...frame, revision: 16, rollbackRevision: 2, view: { ...view, revealed } });
  expect(board.getByRole('button', label)).toBeTruthy();
  board.unmount();
});
