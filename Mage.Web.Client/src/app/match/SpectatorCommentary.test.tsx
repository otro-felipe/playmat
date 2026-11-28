import { act, fireEvent, render, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { SpectatorCommentary, SpectatorCommentaryProvider, SpectatorChatBubble } from './SpectatorCommentary';
import { spectatorFeed } from './spectatorFeed';

afterEach(() => { vi.useRealTimers(); });
const players = [{ playerId: 'one', name: 'Agente' }, { playerId: 'two', name: 'Agente2' }];
const chat = { at: 990, messageId: 'same', playerName: 'Agente', message: 'Buen ataque' };
const note = { at: 1000, lineId: 'same', playerId: 'two', playerName: 'Agente2', reasoning: 'Guardo [Bosque](card://Forest) para después.', turn: 3 };

test('only the last real message appears beside its seat and a deduplicated line opens from chat', () => {
  vi.useFakeTimers(); vi.setSystemTime(1001);
  const feed = spectatorFeed('game', [note, note], [chat, chat]);
  const page = render(<SpectatorCommentaryProvider gameId="game" players={players} events={feed}>
    <div aria-label="seat one"><SpectatorChatBubble playerId="one" side="lower" /></div>
    <div aria-label="seat two"><SpectatorChatBubble playerId="two" side="upper" /></div>
    <SpectatorCommentary />
  </SpectatorCommentaryProvider>);
  expect(within(page.getByLabelText('seat one')).queryByText(/Guardo/)).toBeNull();
  expect(within(page.getByLabelText('seat two')).queryByRole('status')).toBeNull();
  expect(within(page.getByLabelText('seat one')).getByText('Buen ataque')).toBeTruthy();
  fireEvent.click(page.getByRole('button', { name: 'Chat' }));
  const rows = within(page.getByRole('list')).getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toMatch(/Table chat.*Agente.*Buen ataque/);
  expect(rows[1].textContent).toContain('Agente2');
  expect(rows[1].textContent).not.toContain('Guardo');
  fireEvent.click(within(rows[1]).getByRole('button', { name: 'Pilot commentary' }));
  expect(within(page.getByRole('dialog')).getByText(/Guardo/)).toBeTruthy();
  fireEvent.click(within(page.getByRole('dialog')).getByRole('button', {name:'Close'}));
  expect(page.queryByRole('textbox')).toBeNull();
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(within(page.getByLabelText('seat two')).queryByText(/Guardo/)).toBeNull();
  expect(within(page.getByRole('list')).getByRole('button',{name:'Pilot commentary'})).toBeTruthy();
});

test('a private player, replay or different game cannot mount a public audience note', () => {
  const feed = spectatorFeed('another-game', [note], [chat]);
  const page = render(<><SpectatorChatBubble playerId="two" side="upper" /><SpectatorCommentaryProvider
    gameId="game" players={players} events={feed}><SpectatorChatBubble playerId="two" side="lower" /><SpectatorCommentary /></SpectatorCommentaryProvider></>);
  fireEvent.click(page.getByRole('button', { name: 'Chat' }));
  expect(page.queryByText(/Guardo|Buen ataque/)).toBeNull();
});

test('a reconnected seat uses the table message’s original twelve-second deadline and never revives expired notes', () => {
  vi.useFakeTimers();
  vi.setSystemTime(13_000);
  const snapshot = (at: number) => <SpectatorCommentaryProvider gameId="game" players={players}
    events={spectatorFeed('game', [], [{ ...chat, at, playerName: 'Agente2' }])}>
    <SpectatorChatBubble playerId="two" side="upper" />
  </SpectatorCommentaryProvider>;
  const page = render(snapshot(1000));
  expect(page.queryByRole('status')).toBeNull();
  page.rerender(snapshot(2000));
  expect(page.getByRole('status')).toBeTruthy();
  act(() => { vi.advanceTimersByTime(999); });
  page.rerender(snapshot(2000));
  expect(page.getByRole('status')).toBeTruthy();
  act(() => { vi.advanceTimersByTime(1); });
  expect(page.queryByRole('status')).toBeNull();
  page.rerender(snapshot(2000));
  expect(page.queryByRole('status')).toBeNull();
});

test('public and both-hands links accept only audience-public explanations, preserving legacy notes only on their original scope', () => {
  const modern = { ...note, explanation: 'Explicit audience text', audience: 'public' as const };
  for (const visibility of ['public-board','both-hands'] as const) {
    expect(spectatorFeed('game', [note, { ...modern, lineId: 'new' }, { ...modern, lineId: 'private', audience: undefined }], [],visibility).map(e=>e.text)).toEqual(['Explicit audience text']);
  }
  expect(spectatorFeed('game',[note])[0].text).toBe(note.reasoning);
});

test('[PM-LINE-REPLAY-2] opens formatted commentary with an accessible card preview', async () => {
  const user = userEvent.setup();
  const feed = spectatorFeed('game', [{
    ...note,
    audience: 'public',
    explanation: '### Attack now\n\n- **Chosen:** attack with the flyer.\n- **Alternative:** hold [Llanowar Elves](card://Llanowar%20Elves) back.',
  }], [], 'public-board');
  const page = render(<SpectatorCommentaryProvider gameId="game" players={players} events={feed}>
    <SpectatorCommentary />
  </SpectatorCommentaryProvider>);

  await user.click(page.getByRole('button', { name: 'Chat' }));
  await user.click(page.getByRole('button', { name: 'Pilot commentary' }));
  const commentary = within(page.getByRole('dialog'));
  expect(commentary.getByRole('heading', { name: 'Attack now' })).toBeTruthy();
  expect(commentary.getAllByRole('listitem')).toHaveLength(2);
  expect(commentary.getByText('Chosen:').tagName).toBe('STRONG');
  const preview = commentary.getByRole('button', { name: /Llanowar Elves/ });
  act(() => { preview.focus(); });
  await user.keyboard('{Enter}');
  expect(preview.getAttribute('aria-expanded')).toBe('true');
});
