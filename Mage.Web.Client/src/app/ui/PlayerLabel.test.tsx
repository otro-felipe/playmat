import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PlayerLabel } from './PlayerLabel';
import { playerLabelText } from './playerIdentity';
import { PublicBroadcast } from './usePlayerIdentity';

vi.mock('../playtesting', () => ({ PRIVATE_PLAYTESTING: true }));
beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => Response.json({ players: [] }))));
afterEach(() => vi.unstubAllGlobals());

describe('the public identity of a player seat', () => {
  test('a human and their agent can share the same display name', () => {
    const { rerender } = render(<PlayerLabel name="Felipe" />);
    expect(screen.getByText('Felipe')).toBeTruthy();
    expect(screen.queryByText('MCP')).toBeNull();
    rerender(<PlayerLabel name="mcp_Felipe" />);
    expect(screen.getByText('Felipe')).toBeTruthy();
    expect(screen.getByText('MCP')).toBeTruthy();
    expect(playerLabelText('mcp_Felipe')).toBe('Felipe (MCP)');
  });

  test('legacy grants and humans with reserved prefixes resolve together from the public directory', async () => {
    const lookup = vi.fn(async () => Response.json({ players: [
      { name: 'old-rival', displayName: 'Camila', isMcp: true },
      { name: 'mcp_original', displayName: 'mcp_original', isMcp: false },
    ] }));
    vi.stubGlobal('fetch', lookup);
    render(<><div data-testid="agent"><PlayerLabel name="old-rival" displayName="Old deck alias" /></div>
      <div data-testid="human"><PlayerLabel name="mcp_original" /></div></>);
    const agent = within(screen.getByTestId('agent'));
    const human = within(screen.getByTestId('human'));
    expect(await agent.findByText('Camila')).toBeTruthy();
    expect(agent.getByText('MCP')).toBeTruthy();
    await waitFor(() => expect(human.queryByText('MCP')).toBeNull());
    expect(human.getByText('mcp_original')).toBeTruthy();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test('an authenticated owner can identify an old opaque seat without guessing from its hash', () => {
    expect(playerLabelText('mcp_e70ebd2d48', 'Felipe', true)).toBe('Felipe (MCP)');
    expect(playerLabelText('mcp_e70ebd2d48')).toBe('MCP');
    expect(playerLabelText('mcp_legacy', 'mcp_legacy', false)).toBe('mcp_legacy');
  });
});

test('a human seat can carry match consent without changing its player identity elsewhere', () => {
  const page = render(<><div data-testid="allowed"><PlayerLabel name="Camila" isMcp={false} humanMcpAllowed /></div>
    <div data-testid="ordinary"><PlayerLabel name="Camila" isMcp={false} /></div></>);
  expect(within(page.getByTestId('allowed')).getByText('MCP enabled')).toBeTruthy();
  expect(within(page.getByTestId('ordinary')).queryByText('MCP enabled')).toBeNull();
});

test('[PM-MCP-PLAYER-VIEW-MODEL] a player identity shows recorded provider and model while preserving broadcast aliases', async () => {
  const name = 'mcp_modeltest';
  const lookup = vi.fn(async () => Response.json({ players: [
    { name, displayName: 'Luna', isMcp: true, provider: 'openai', model: 'gpt-6.2-sol' },
  ] }));
  vi.stubGlobal('fetch', lookup);
  const page = render(<>
    <div data-testid="private"><PlayerLabel name={name} showModel /></div>
    <div data-testid="public"><PublicBroadcast.Provider value><PlayerLabel name={name} displayName="Seat B" showModel /></PublicBroadcast.Provider></div>
  </>);
  const privateLabel = within(page.getByTestId('private'));
  const publicLabel = within(page.getByTestId('public'));
  expect(await privateLabel.findByRole('img', { name: 'OpenAI' })).toBeTruthy();
  expect(privateLabel.getByText('gpt-6.2-sol')).toBeTruthy();
  expect(publicLabel.getByText('Seat B')).toBeTruthy();
  expect(publicLabel.queryByRole('img')).toBeNull();
  expect(publicLabel.queryByText('gpt-6.2-sol')).toBeNull();
});
