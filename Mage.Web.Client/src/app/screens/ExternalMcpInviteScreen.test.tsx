import { fireEvent, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { ExternalMcpInviteScreen } from './ExternalMcpInviteScreen';

const table = '77777777-7777-4777-8777-777777777777';
const fragment = '#invite=' + 'x'.repeat(43);

function renderInvite(hash = fragment) {
  return render(<MemoryRouter initialEntries={[`/join/mcp/${table}${hash}`]}>
    <Routes><Route path="/join/mcp/:tableId" element={<ExternalMcpInviteScreen />} /></Routes>
  </MemoryRouter>);
}

afterEach(() => vi.restoreAllMocks());

test('the recipient can copy the complete invitation for their MCP without loading or joining the table', async () => {
  const request = vi.spyOn(globalThis, 'fetch');
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  const screen = renderInvite();
  fireEvent.click(screen.getByRole('button', { name: 'Copy agent instructions' }));
  expect((await screen.findByRole('status')).textContent).toContain('Agent instructions copied');
  const instructions = clipboard.mock.calls[0][0];
  expect(instructions).toContain(window.location.origin + '/join/mcp/' + table + fragment);
  expect(instructions).toContain('list_joinable_games');
  expect(instructions).toContain('inviteLink');
  expect(instructions).toContain('join_game');
  expect(request).not.toHaveBeenCalled();
  expect(screen.container.innerHTML).not.toContain(fragment);
});

test('a clipboard failure offers the address bar and keeps the invitation out of the document', async () => {
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('unavailable'));
  const screen = renderInvite();
  fireEvent.click(screen.getByRole('button', { name: 'Copy agent instructions' }));
  expect((await screen.findByRole('status')).textContent).toContain('address bar');
  expect(screen.container.innerHTML).not.toContain(fragment);
});

test.each(['', '#invite=short', fragment + '&extra=value'])('an incomplete or malformed link cannot be copied', (hash) => {
  const screen = renderInvite(hash);
  expect(screen.getByText('Ask the host for the complete MCP invitation link.')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});
