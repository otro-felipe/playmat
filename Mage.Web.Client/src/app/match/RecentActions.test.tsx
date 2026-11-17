// @vitest-environment happy-dom
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RecentActions } from './RecentActions';
import { GameSession } from '../../core/game/gameSession';
import { ACTION_BEAT_MS } from '../../core/game/actionPresentation';
import { createFakeConnection } from '../../test/fakeConnection';

describe('[READ-AC-003] recent action receipts', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('presents rapid public actions in order as read-only history while the real stack has advanced', () => {
    const connection = createFakeConnection();
    const session = new GameSession(connection.api as never, connection.events, { gameId: 'g', playerId: 'me', mode: 'play' });
    session.store.setState({ view: { turn: 4, stack: {} } });
    const { unmount } = render(<RecentActions session={session} seatDisplayNames={{ Bob: 'Spell Pilot' }} />);
    act(() => {
      session.store.setState({ view: { turn: 4, stack: { bolt: { name: 'Lightning Bolt', targets: ['rival'] } }, players: [{ playerId: 'rival', name: 'Bob' }] } });
      session.store.setState({ view: { turn: 4, stack: {} } });
    });
    expect(session.getState().view?.stack).toEqual({});
    expect(screen.getByLabelText('Recent action').textContent).toContain('On the stack');
    expect(screen.queryByText(/Targets:/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    act(() => vi.advanceTimersByTime(ACTION_BEAT_MS));
    expect(screen.getByText('Left the stack')).toBeTruthy();
    act(() => vi.advanceTimersByTime(ACTION_BEAT_MS));
    expect(screen.queryByLabelText('Recent action')).toBeNull();
    unmount();
    session.dispose();
  });
});
