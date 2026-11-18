import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { PrivateSession } from './PrivateSession';
import { useSession } from './stores/session';

vi.mock('./connection', async () => ({ ...(await import('../test/fakeConnection')).createFakeConnection(), DEFAULT_SERVER_URL: 'wss://private.test/ws' }));
const connect = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('./privateSessionConnect', () => ({ connectPrivateSession: connect, SignInRequired: class extends Error {} }));
afterEach(() => { cleanup(); connect.mockReset(); useSession.setState({ signedInElsewhere: false }); });

test('private connection never paints an engine login form, including errors and retries', async () => {
  connect.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce();
  const { container } = render(<MemoryRouter initialEntries={['/decks']}><PrivateSession /></MemoryRouter>);
  expect(container.querySelector('form, input')).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
  expect(container.querySelector('form, input')).toBeNull();
});

test('a session open elsewhere waits for an explicit take-back', async () => {
  useSession.setState({ signedInElsewhere: true });
  connect.mockResolvedValue();
  render(<MemoryRouter initialEntries={['/decks']}><PrivateSession /></MemoryRouter>);
  expect(connect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Continue here' }));
  await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
});
