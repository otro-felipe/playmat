import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ActionPresentation, ACTION_BEAT_MS, MAX_ACTION_PREVIEWS } from './actionPresentation';
import { GameSession } from './gameSession';
import { createFakeConnection } from '../../test/fakeConnection';
import type { GameView } from '../../protocol/generated/views';

describe('[READ-AC-003] public action presentation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function game() {
    const connection = createFakeConnection();
    const session = new GameSession(connection.api as never, connection.events, { gameId: 'g', playerId: 'me', mode: 'play' });
    let seq = 0;
    const update = (view: GameView) => connection.rpc.emit({ method: 'GAME_UPDATE', objectId: 'g', messageId: ++seq, data: view });
    const initial: GameView = { turn: 3, players: [{ playerId: 'rival', name: 'Bob' }], stack: {} };
    update(initial);
    const feed = new ActionPresentation();
    feed.connect(session);
    return { connection, session, update, feed, initial, close: () => { feed.dispose(); session.dispose(); } };
  }

  test('captures cast, targets and stack departure across unrendered updates without delaying the real state', () => {
    const { update, initial, feed, session, close } = game();
    update({ ...initial, stack: { bolt: { name: 'Lightning Bolt' } } });
    update({ ...initial, stack: { bolt: { name: 'Lightning Bolt', targets: ['rival'] } } });
    update({ ...initial, turn: 4, stack: {} });
    expect(session.getState().view?.turn).toBe(4);
    expect(session.getState().view?.stack).toEqual({});
    expect(feed.getSnapshot().items.map((action) => [action.kind, action.targets])).toEqual([
      ['On the stack', []], ['Targets announced', ['Bob']], ['Left the stack', ['Bob']],
    ]);
    vi.advanceTimersByTime(ACTION_BEAT_MS - 1);
    expect(feed.getSnapshot().items[0].kind).toBe('On the stack');
    vi.advanceTimersByTime(1);
    expect(feed.getSnapshot().items[0].kind).toBe('Targets announced');
    close();
  });

  test('bounds a burst and accounts for every omitted preview, then drains and resumes', () => {
    const { update, initial, feed, close } = game();
    const stack = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`s${i}`, { name: `Spell ${i}` }]));
    update({ ...initial, stack });
    expect(feed.getSnapshot().items).toHaveLength(MAX_ACTION_PREVIEWS);
    expect(feed.getSnapshot().items.map((item) => item.name)).toEqual(Array.from({ length: 8 }, (_, i) => `Spell ${i}`));
    expect(feed.getSnapshot().overflow).toBe(12);
    vi.advanceTimersByTime(ACTION_BEAT_MS * MAX_ACTION_PREVIEWS);
    expect(feed.getSnapshot()).toEqual({ items: [], overflow: 12 });
    vi.advanceTimersByTime(ACTION_BEAT_MS);
    expect(feed.getSnapshot()).toEqual({ items: [], overflow: 0 });
    update({ ...initial, stack: { ...stack, new: { name: 'Next spell' } } });
    expect(feed.getSnapshot().items[0].name).toBe('Next spell');
    close();
  });

  test.each(['reconnect', 'rollback', 'end'] as const)('discards obsolete receipts on %s and never replays the reconnect snapshot', (boundary) => {
    const { update, initial, feed, session, close } = game();
    update({ ...initial, stack: { bolt: { name: 'Lightning Bolt' } } });
    if (boundary === 'reconnect') session.markResyncing();
    else if (boundary === 'rollback') session.store.setState({ rollbackRevision: 1 });
    else session.store.setState({ gameOver: 'Game over' });
    expect(feed.getSnapshot()).toEqual({ items: [], overflow: 0 });
    update({ ...initial, turn: 5, stack: { unseen: { name: 'Existing spell' } } });
    expect(feed.getSnapshot().items).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(feed.getSnapshot().items).toEqual([]);
    close();
  });

  test('shows battlefield entries and hides the identity of a face-down play', () => {
    const { update, initial, feed, close } = game();
    update({ ...initial, players: [{ playerId: 'rival', battlefield: { land: { name: 'Forest' }, secret: { name: 'Private identity', faceDown: true } } }] });
    expect(feed.getSnapshot().items.map((item) => [item.kind, item.name])).toEqual([
      ['Entered the battlefield', 'Forest'], ['Entered the battlefield', 'Face-down card'],
    ]);
    close();
  });
});
