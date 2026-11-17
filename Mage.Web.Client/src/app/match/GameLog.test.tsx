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

    fireEvent.click(screen.getByRole('button', { name: /^Chat$/ }));
    const drawer = within(screen.getByRole('complementary', { name: 'Game chat' }));
    const input = drawer.getByRole('textbox', { name: 'Chat message' }) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: 'Nice play!' } });
    fireEvent.click(drawer.getByRole('button', { name: /^Send$/ }));
    expect(connection.api.chatSendMessage).toHaveBeenCalledWith('chat1', expect.any(String), 'Nice play!');
    expect(input.value).toBe('');

    fireEvent.click(drawer.getByRole('button', { name: /^Log$/ }));
    expect(screen.getByRole('complementary', { name: 'Game log' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Chat message' })).toBeNull();
    expect(connection.api.chatJoin).toHaveBeenCalledTimes(1);
  });

  test('[PM-AC-04] a rival’s chosen name labels authenticated chat and log entries, including entries that arrived before the alias', async () => {
    const { GameLog, connection } = await load();
    connection.api.chatFindByGame.mockResolvedValue('chat1');
    connection.api.chatJoin.mockResolvedValue(true);
    const props = { gameId: 'g1', notices: [], canChat: true, view: null };
    const { rerender } = render(<GameLog {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /^Chat$/ }));
    const drawer = within(screen.getByRole('complementary', { name: 'Game chat' }));
    await waitFor(() => expect((drawer.getByRole('textbox', { name: 'Chat message' }) as HTMLInputElement).disabled).toBe(false));
    act(() => {
      connection.rpc.emit({
        method: 'CHATMESSAGE', objectId: 'chat1', messageId: 1,
        data: { messageType: 'TALK', username: 'mcp_fixture', message: 'Nice play!' },
      });
      connection.rpc.emit({
        method: 'CHATMESSAGE', objectId: 'chat1', messageId: 2,
        data: { messageType: 'TALK', username: 'Roberto', message: 'mcp_fixture is the other player.' },
      });
      connection.rpc.emit({
        method: 'CHATMESSAGE', objectId: 'chat1', messageId: 3,
        data: { messageType: 'GAME', message: "<font color='#20B2AA'>mcp_fixture</font> plays Island", turnInfo: 'T1.M1' },
      });
    });
    rerender(<GameLog {...props} seatDisplayNames={{ mcp_fixture: 'Spell Pilot' }} />);
    expect(drawer.getByText('Spell Pilot:')).toBeTruthy();
    expect(drawer.queryByText('mcp_fixture:')).toBeNull();
    expect(drawer.getByText('Roberto:')).toBeTruthy();
    expect(drawer.getByText('mcp_fixture is the other player.')).toBeTruthy();

    fireEvent.click(drawer.getByRole('button', { name: /^Log$/ }));
    const log = within(screen.getByRole('complementary', { name: 'Game log' }));
    expect(log.getByText('Spell Pilot', { exact: true })).toBeTruthy();
    expect(connection.api.chatJoin).toHaveBeenCalledTimes(1);
  });
});
