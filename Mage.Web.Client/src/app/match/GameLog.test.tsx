// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createFakeConnection, type FakeConnection } from '../../test/fakeConnection';

async function load() {
  vi.resetModules();
  vi.doMock('../connection', () => createFakeConnection());
  const { GameLog } = await import('./GameLog');
  const { useMatchUi } = await import('./matchUi');
  return { GameLog, useMatchUi, connection: (await import('../connection')) as unknown as FakeConnection };
}

beforeEach(() => {
  localStorage.clear();
});

describe('GameLog (#249)', () => {
  test('an open log closes on Escape and on a click elsewhere, and stays open while pinned', async () => {
    const { GameLog, useMatchUi } = await load();
    render(
      <>
        <GameLog gameId="g1" notices={[]} canChat={false} view={null} />
        <button type="button">the table</button>
      </>,
    );
    const open = () => act(() => useMatchUi.getState().toggleLog(true));

    open();
    expect(screen.getByRole('complementary', { name: 'Game log' })).toBeTruthy();
    // a click inside the log keeps it open
    fireEvent.pointerDown(screen.getByRole('heading', { name: 'Log' }));
    expect(useMatchUi.getState().logOpen).toBe(true);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(escape);
    });
    expect(useMatchUi.getState().logOpen).toBe(false);
    expect(escape.defaultPrevented).toBe(true);

    open();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'the table' }));
    expect(useMatchUi.getState().logOpen).toBe(false);

    open();
    fireEvent.click(screen.getByRole('button', { name: /Pin the log/ }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'the table' }));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(useMatchUi.getState().logOpen).toBe(true);
    expect(localStorage.getItem('playmat.logPinned')).toBe('true');
  });

  test('[PM-AC-04] a player opens chat directly, sends a message and keeps the game log in the same connection', async () => {
    const { GameLog, connection } = await load();
    connection.api.chatFindByGame.mockResolvedValue('chat1');
    connection.api.chatJoin.mockResolvedValue(true);
    render(<GameLog gameId="g1" notices={[]} canChat view={null} />);

    fireEvent.click(screen.getByRole('button', { name: 'Chat', exact: true }));
    const drawer = within(screen.getByRole('complementary', { name: 'Game chat' }));
    const input = drawer.getByRole('textbox', { name: 'Chat message' }) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: 'Nice play!' } });
    fireEvent.click(drawer.getByRole('button', { name: 'Send', exact: true }));
    expect(connection.api.chatSendMessage).toHaveBeenCalledWith('chat1', expect.any(String), 'Nice play!');
    expect(input.value).toBe('');

    fireEvent.click(drawer.getByRole('button', { name: 'Log', exact: true }));
    expect(screen.getByRole('complementary', { name: 'Game log' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Chat message' })).toBeNull();
    expect(connection.api.chatJoin).toHaveBeenCalledTimes(1);
  });
});
