import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { JoinScreen } from './JoinScreen';

const tableId = '22222222-2222-4222-8222-222222222222';
const invitePath = `/join/${tableId}`;
const rules = 'playmat://guides/rules';
const refetch = vi.fn();

vi.mock('../playtesting', async (original) => ({ ...await original<typeof import('../playtesting')>(), PRIVATE_PLAYTESTING: true }));
vi.mock('../queries', () => ({
  useTables: () => ({ data: [{ tableId, tableName: 'Pioneer fixture', seats: [] }], refetch }),
}));
vi.mock('../stores/session', () => ({
  useSession: Object.assign((pick: (state: object) => unknown) => pick({ userName: 'Host' }), { subscribe: vi.fn() }),
}));
vi.mock('../stores/decks', () => ({ useDecks: () => ({ loaded: true }) }));
vi.mock('../stores/useDeckRoster', () => ({ useDeckRoster: () => [] }));
vi.mock('./joinTable', () => ({ joinTable: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(chatMode?: 'quiet' | 'chatty' | 'coach') {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tableId, mode: 'mcp', chatMode })));
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[invitePath]}>
        <Routes><Route path="/join/:tableId" element={<JoinScreen />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test('[PM-AC-04] an MCP invite shows and copies its endpoint, private link, resources and chat style', async () => {
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  const page = mount('coach');
  expect(await page.findByText(rules)).toBeTruthy();
  expect(page.getByRole('heading', { name: 'Thoughtseize guides' })).toBeTruthy();
  expect(page.getByText(/get_guide with/)).toBeTruthy();
  expect(page.getByText('Coach', { exact: false })).toBeTruthy();
  fireEvent.click(page.getByRole('button', { name: 'Copy agent instructions' }));
  expect(await page.findByText('Agent instructions copied')).toBeTruthy();
  const [instructions] = writeText.mock.calls[0];
  for (const detail of [
    `${window.location.origin}/mcp`, `${window.location.origin}${invitePath}`,
    'playmat://guides/getting-started', 'playmat://guides/card-catalog', 'playmat://guides/turn-planning', rules,
    'Connect to Thoughtseize', 'get_guide with {"bundle":true}', 'join_game', 'Coach',
    'Before creating, joining or playing, load all four guides', 'Repeat after losing context',
    'play_line', 'as far as the visible state justifies',
    'strong public opportunity', 'After each completed human turn', 'concrete benefit',
    'without hindsight', 'Coach grants no hand access', 'Resolve pending engine decisions first',
  ]) expect(instructions).toContain(detail);
  expect(instructions.indexOf('get_guide')).toBeLessThan(instructions.indexOf('join_game'));
});

test.each(['quiet', 'chatty'] as const)('copying a %s invite does not enable Coach advice', async (mode) => {
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  const page = mount(mode);
  await page.findByText(rules);
  fireEvent.click(page.getByRole('button', { name: 'Copy agent instructions' }));
  await page.findByText('Agent instructions copied');
  const [instructions] = writeText.mock.calls[0];
  expect(instructions).not.toContain('After each completed human turn');
  expect(instructions).not.toContain('genuinely strong public opportunity');
});

test('[PM-AC-04] existing invites use Quiet and instructions can be copied manually when clipboard access fails', async () => {
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Clipboard denied'));
  const page = mount();
  expect(await page.findByText('Quiet', { exact: false })).toBeTruthy();
  fireEvent.click(page.getByRole('button', { name: 'Copy agent instructions' }));
  const instructions = await page.findByRole('textbox', { name: 'Agent instructions' }) as HTMLTextAreaElement;
  expect(instructions.readOnly).toBe(true);
  expect(instructions.value).toContain(`${window.location.origin}${invitePath}`);
});
