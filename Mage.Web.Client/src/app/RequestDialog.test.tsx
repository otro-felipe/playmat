import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import type { UserRequestMessage } from '../protocol/generated/views';
import { RequestDialog } from './RequestDialog';

const mocks = vi.hoisted(() => ({
  receive: undefined as ((request: UserRequestMessage) => void) | undefined,
  send: vi.fn(async () => true),
}));
vi.mock('./connection', async (original) => {
  const actual = await original<typeof import('./connection')>();
  return {
    ...actual,
    api: { ...actual.api, sendPlayerAction: mocks.send },
    events: { on: (method: string, handler: (request: UserRequestMessage) => void) => {
      if (method === 'USER_REQUEST_DIALOG') mocks.receive = handler;
      return () => { if (method === 'USER_REQUEST_DIALOG') mocks.receive = undefined; };
    } },
  };
});

const rollback: UserRequestMessage = {
  title: 'Request by Rival', message: 'Allow rollback to the start of turn 1?', gameId: 'game', relatedUserId: 'vote-id',
  button1Text: 'Accept', button1Action: 'ADD_PERMISSION_TO_ROLLBACK_TURN',
  button2Text: 'Deny', button2Action: 'DENY_PERMISSION_TO_ROLLBACK_TURN',
};
const reveal: UserRequestMessage = {
  title: 'Reveal hand', message: 'Show your hand?', gameId: 'game', relatedUserId: 'rival',
  button1Text: 'Reveal', button1Action: 'ADD_PERMISSION_TO_SEE_HAND_CARDS',
};

beforeEach(() => { mocks.send.mockClear(); });

function mount() {
  render(<><button type="button">Outside</button><RequestDialog /></>);
  act(() => mocks.receive?.(rollback));
  return userEvent.setup();
}

test('rollback cannot be dismissed by outside click, touch, Escape or a close button, and keeps its place in the queue', async () => {
  const user = mount();
  act(() => mocks.receive?.(reveal));
  const modal = screen.getByRole('dialog', { name: 'Request by Rival' });
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  await user.keyboard('{Escape}');
  // Radix locks background pointer interaction; the overlay itself receives real outside clicks.
  const overlay = modal.previousElementSibling!;
  await user.click(overlay);
  await user.pointer([{ keys: '[TouchA>]', target: overlay }, { keys: '[/TouchA]' }]);
  expect(screen.getByRole('dialog', { name: 'Request by Rival' })).toBe(modal);
  expect(screen.queryByRole('dialog', { name: 'Reveal hand' })).toBeNull();
  expect(mocks.send).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Deny' }));
  expect(mocks.send).toHaveBeenCalledExactlyOnceWith('DENY_PERMISSION_TO_ROLLBACK_TURN', 'game', 'vote-id');
  expect(await screen.findByRole('dialog', { name: 'Reveal hand' })).toBeTruthy();
});

for (const [label, action] of [
  ['Accept', 'ADD_PERMISSION_TO_ROLLBACK_TURN'], ['Deny', 'DENY_PERMISSION_TO_ROLLBACK_TURN'],
]) {
  test(`rollback requires an explicit ${label} vote carrying the request ID`, async () => {
    const user = mount();
    await user.click(screen.getByRole('button', { name: label }));
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(action, 'game', 'vote-id');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
}

test('other requests retain their normal close control and Escape behavior', async () => {
  render(<RequestDialog />);
  act(() => mocks.receive?.(reveal));
  expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  await userEvent.setup().keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(mocks.send).not.toHaveBeenCalled();
});
