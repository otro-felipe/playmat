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

test('the live header shows the numeric audience, running table clock, and named match score across games', async () => {
  const deadlineAt = Date.now() + 70_000;
  const score = (winsA: number, winsB: number) => [{ name: 'Brasa', wins: winsA }, { name: 'Cirro', wins: winsB }];
  const frame = {
    role: 'spectator', gameId: null, visibility: 'public-board', status: 'waiting', spectators: 0,
    players: [], view: null, hands: {}, chat: [], lines: [],
    matchScore: score(0, 0), deadlineAt,
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(frame)));
  class FixtureStream extends EventTarget {
    close() {}
  }
  const stream = new FixtureStream();
  vi.stubGlobal('EventSource', vi.fn(function () { return stream; }));
  const board = render(<MemoryRouter><SpectatorBroadcast endpoint="/fixture" /></MemoryRouter>);
  const header = await board.findByRole('banner');
  await board.findByText(/0 watching/);
  expect(header.textContent).not.toContain('{count}');
  const matchScore = board.getByRole('group', { name: 'Match score' });
  expect(matchScore.textContent).toContain('Brasa0–0Cirro');
  expect(board.getByText('Table clock').nextElementSibling?.tagName).toBe('TIME');

  const update = (payload: object) => act(() => { stream.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(payload) })); });
  update({ ...frame, status: 'between_games', spectators: 2, matchScore: score(1, 0) });
  expect(header.textContent).toContain('Between games · 2 watching');
  expect(matchScore.textContent).toContain('Brasa1–0Cirro');

  update({ ...frame, status: 'playing', spectators: 3, matchScore: score(1, 1), deadlineAt: undefined });
  expect(header.textContent).toContain('Live · 3 watching');
  expect(matchScore.textContent).toContain('Brasa1–1Cirro');
  expect(board.queryByText('Table clock')).toBeNull();
  board.unmount();
});

test('a standalone spectator feed with no audience count never displays a translation placeholder', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
    role: 'spectator', status: 'finished', gameId: null, players: [], hands: {}, lines: [], chat: [], view: null,
  })));
  const board = render(<MemoryRouter><SpectatorBroadcast endpoint="/fixture" /></MemoryRouter>);
  await board.findByText('Match finished', { selector: 'header span' });
  expect(board.getByRole('banner').textContent).not.toContain('{count}');
  expect(board.queryByRole('group', { name: 'Match score' })).toBeNull();
  board.unmount();
});
