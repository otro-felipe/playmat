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
  test('[READ-AC-002] receives turns and resolutions after reconnect, including lines delivered during chatJoin', async () => {
    const { GameLog, useMatchUi, connection } = await load();
    const { useSession } = await import('../stores/session');
    connection.api.chatFindByGame.mockResolvedValue('chat1');
    let id = 0;
    const line = (message: string, turn: number) => connection.rpc.emit({ method: 'CHATMESSAGE', objectId: 'chat1', messageId: ++id, data: { messageType: 'GAME', message, turnInfo: `T${turn}.M1` } });
    connection.api.chatJoin.mockImplementation(async () => {
      line('Joined chat before RPC resolves', 3);
      return true;
    });
    const { rerender } = render(<GameLog gameId="g1" notices={[]} canChat={false} view={{ turn: 3, activePlayerName: 'Bob' }} />);
    act(() => useMatchUi.getState().toggleLog(true));
    await screen.findByText('Joined chat before RPC resolves');
    act(() => { line('Bob casts Lightning Bolt', 3); });
    expect(screen.getByText('Bob casts Lightning Bolt')).toBeTruthy();
    connection.api.chatJoin.mockResolvedValue(true);
    act(() => {
      connection.rpc.setStatus('open');
      id = 0; // callback ids restart with the authenticated server session
      useSession.setState({ loginCount: 2 });
    });
    await waitFor(() => expect(connection.api.chatJoin).toHaveBeenCalledTimes(2));
    rerender(<GameLog gameId="g1" notices={[]} canChat={false} view={{ turn: 4, activePlayerName: 'Alice' }} />);
    act(() => {
      line('Lightning Bolt deals 3 damage to Bob', 4);
      line('Alice plays Island', 5);
    });
    expect(screen.getByText('Bob casts Lightning Bolt')).toBeTruthy();
    expect(screen.getByText('Lightning Bolt deals 3 damage to Bob')).toBeTruthy();
    expect(screen.getByText('Alice plays Island')).toBeTruthy();
    expect(screen.getByText(/Turn 5/)).toBeTruthy();
  });

  test('[READ-AC-002] a full log still scrolls to new actions after the bounded buffer stops growing', async () => {
    const { GameLog, useMatchUi, connection } = await load();
    connection.api.chatFindByGame.mockResolvedValue('chat1');
    connection.api.chatJoin.mockResolvedValue(true);
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(() => undefined);
    render(<GameLog gameId="g1" notices={[]} canChat={false} view={null} />);
    act(() => useMatchUi.getState().toggleLog(true));
    await waitFor(() => expect(connection.api.chatJoin).toHaveBeenCalled());
    const line = (n: number) => connection.rpc.emit({ method: 'CHATMESSAGE', objectId: 'chat1', messageId: n, data: { messageType: 'GAME', message: `Action ${n}`, turnInfo: 'T3.M1' } });
    act(() => { for (let n = 1; n <= 300; n++) line(n); });
    expect(screen.getByText('Action 300')).toBeTruthy();
    const before = scroll.mock.calls.length;
    act(() => line(301));
    expect(screen.queryByText('Action 1')).toBeNull();
    expect(screen.getByText('Action 301')).toBeTruthy();
    expect(scroll.mock.calls.length).toBeGreaterThan(before);
    scroll.mockRestore();
  });

  test('[READ-AC-002] retries an initially refused chat join and receives subsequent actions', async () => {
    const { GameLog, useMatchUi, connection } = await load();
    connection.api.chatFindByGame.mockResolvedValue('chat1');
    connection.api.chatJoin.mockResolvedValueOnce(false).mockResolvedValue(true);
    render(<GameLog gameId="g1" notices={[]} canChat={false} view={null} />);
    act(() => useMatchUi.getState().toggleLog(true));
    await waitFor(() => expect(connection.api.chatJoin).toHaveBeenCalledTimes(2), { timeout: 3000 });
    act(() => connection.rpc.emit({ method: 'CHATMESSAGE', objectId: 'chat1', messageId: 1, data: { messageType: 'GAME', message: 'Turn four action' } }));
    expect(screen.getByText('Turn four action')).toBeTruthy();
  });

  test('[READ-AC-002] an old join resolving late cannot leave the newer membership', async () => {
    const { GameLog, connection } = await load();
    const { useSession } = await import('../stores/session');
    connection.api.chatFindByGame.mockResolvedValue('chat1');
    let finishOld!: (joined: boolean) => void;
    connection.api.chatJoin.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishOld = resolve; })).mockResolvedValue(true);
    render(<GameLog gameId="g1" notices={[]} canChat view={null} />);
    await waitFor(() => expect(connection.api.chatJoin).toHaveBeenCalledTimes(1));
    act(() => useSession.setState({ loginCount: 2 }));
    await waitFor(() => expect(connection.api.chatJoin).toHaveBeenCalledTimes(2));
    await act(async () => { finishOld(true); });
    expect(connection.api.chatLeave).not.toHaveBeenCalled();
  });

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
    expect(drawer.getByText('Spell Pilot')).toBeTruthy();
    expect(drawer.getByText('MCP')).toBeTruthy();
    expect(drawer.queryByText('mcp_fixture:')).toBeNull();
    expect(drawer.getByText('Roberto:')).toBeTruthy();
    expect(drawer.getByText('mcp_fixture is the other player.')).toBeTruthy();

    fireEvent.click(drawer.getByRole('button', { name: /^Log$/ }));
    const log = within(screen.getByRole('complementary', { name: 'Game log' }));
    expect(log.getAllByText('Spell Pilot')).toHaveLength(2);
    expect(connection.api.chatJoin).toHaveBeenCalledTimes(1);
  });
});

test('chat text keeps accents, literal entities and HTML as text while the MCP opponent keeps its seat alias', async () => {
  const { GameLog, useMatchUi, connection } = await load();
  connection.api.chatFindByGame.mockResolvedValue('chat1');
  const { container } = render(<GameLog gameId="g1" notices={[]} canChat view={null} seatDisplayNames={{ mcp_1234567890: 'Rakún' }} />);
  act(() => useMatchUi.getState().toggleLog(true));
  await waitFor(() => expect(connection.api.chatJoin).toHaveBeenCalled());
  act(() => connection.rpc.emit({ method: 'CHATMESSAGE', objectId: 'chat1', messageId: 20, data: {
    username: 'mcp_1234567890', messageType: 'TALK', message: 'Ahora s&iacute; 😈 &amp;iacute; [abc] {G} &lt;img src=x onerror=alert(1)&gt;',
  } }));
  await screen.findByText('Rakún');
  expect(screen.getByText('MCP')).toBeTruthy();
  expect(container.textContent).toContain('Ahora sí 😈 &iacute; [abc] {G} <img src=x onerror=alert(1)>');
  expect(container.querySelector('img[src="x"], [onerror], script')).toBeNull();
  expect(container.querySelector('.ms-g')).toBeNull();
  expect(container.textContent).not.toContain('mcp_1234567890');
});
