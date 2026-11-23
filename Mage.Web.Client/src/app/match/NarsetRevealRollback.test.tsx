import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test } from 'vitest';
import { useStore } from 'zustand';
import { GameSession } from '../../core/game/gameSession';
import { EventBus } from '../../core/rpc/EventBus';
import type { GameView } from '../../protocol/generated/views';
import { api, rpc } from '../connection';
import { MatchStage } from './MatchStage';

function LiveMatch({ session }: { session: GameSession }) {
  return <MatchStage session={session} state={useStore(session.store)} />;
}

test('the rival sees the one card revealed by Narset through batched updates, then forgets the notice on rollback', () => {
  const gameId = 'synthetic-narset';
  const source = 'Narset, Parter of Veils';
  const bus = new EventBus(rpc);
  const session = new GameSession(api, bus, { gameId, playerId: 'rival', mode: 'play' });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const before: GameView = {
    myPlayerId: 'rival', activePlayerId: 'pilot', turn: 4, step: 'PRECOMBAT_MAIN',
    players: [{ playerId: 'pilot', name: 'A', handCount: 0 }, { playerId: 'rival', name: 'B', handCount: 0 }],
  };
  let messageId = 0;
  const update = (data: GameView) => bus.dispatch({ method: 'GAME_UPDATE', objectId: gameId, messageId: ++messageId, data });
  update(before);
  const screen = render(<QueryClientProvider client={queries}><MemoryRouter><LiveMatch session={session} /></MemoryRouter></QueryClientProvider>);
  const notice = () => screen.queryByRole('button', { name: /Opt, Revealed: Narset/ });
  try {
    expect(notice()).toBeNull();
    // Synthetic top four. The rival receives precisely the selected card from the controller's private look.
    const topFour = ['Island', 'Opt', 'Mountain', 'Forest'];
    const chosen = topFour[1];
    act(() => {
      update({ ...before, revealed: [{ name: source, cards: {
        pick: { id: 'pick', ownerId: 'pilot', name: chosen, zone: 'LIBRARY' },
      } }] });
      update({ ...before, players: [{ ...before.players![0], handCount: 1 }, before.players![1]] });
    });
    expect(session.getState().view?.revealed ?? []).toHaveLength(0);
    const visibleNotice = screen.getByRole('button', { name: /Opt, Revealed: Narset/ });
    const namedOutsideArtwork = within(visibleNotice).getAllByText(chosen, { exact: true })
      .some(node => !node.closest('[aria-hidden="true"]'));
    expect(namedOutsideArtwork).toBe(true);
    for (const hidden of topFour.filter(card => card !== chosen)) {
      expect(screen.queryByText(hidden, { exact: true })).toBeNull();
      expect(screen.queryByRole('button', { name: new RegExp(hidden) })).toBeNull();
    }

    // XMage restored the start of this same turn. No change of turn number can clear the strip by accident.
    act(() => {
      bus.dispatch({ method: 'GAME_ROLLBACK', objectId: gameId, messageId: ++messageId, data: 4 });
      update(before);
    });
    expect(session.getState().rollbackRevision).toBe(1);
    expect(notice()).toBeNull();
    expect(screen.queryByText(chosen, { exact: true })).toBeNull();
  } finally {
    screen.unmount();
    session.dispose();
    bus.dispose();
    queries.clear();
  }
});
