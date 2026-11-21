import { act, fireEvent, render, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { SpectatorCommentary, SpectatorCommentaryProvider, SpectatorLineBubble } from './SpectatorCommentary';
import { spectatorFeed } from './spectatorFeed';

afterEach(() => { vi.useRealTimers(); });
const players = [{ playerId: 'one', name: 'Agente' }, { playerId: 'two', name: 'Agente2' }];
const chat = { at: 990, messageId: 'same', playerName: 'Agente', message: 'Buen ataque' };
const note = { at: 1000, lineId: 'same', playerId: 'two', playerName: 'Agente2', reasoning: 'Guardo [Bosque](card://Forest) para después.', turn: 3 };

test('an audience note stays with its exact seat and is distinct from table dialogue, even after a duplicate snapshot', () => {
  vi.useFakeTimers(); vi.setSystemTime(1001);
  const feed = spectatorFeed('game', [note, note], [chat, chat]);
  const page = render(<SpectatorCommentaryProvider gameId="game" players={players} events={feed}>
    <div aria-label="seat one"><SpectatorLineBubble playerId="one" side="lower" /></div>
    <div aria-label="seat two"><SpectatorLineBubble playerId="two" side="upper" /></div>
    <SpectatorCommentary />
  </SpectatorCommentaryProvider>);
  expect(within(page.getByLabelText('seat one')).queryByText(/Guardo/)).toBeNull();
  expect(within(page.getByLabelText('seat two')).getByRole('button', { name: /Bosque/ })).toBeTruthy();
  fireEvent.click(page.getByRole('button', { name: 'Chat' }));
  const rows = within(page.getByRole('list')).getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toMatch(/Table chat.*Agente.*Buen ataque/);
  expect(rows[1].textContent).toMatch(/Audience note.*Agente2.*Guardo/);
  expect(page.queryByRole('textbox')).toBeNull();
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(within(page.getByLabelText('seat two')).queryByText(/Guardo/)).toBeNull();
  expect(within(page.getByRole('list')).getByText(/Guardo/)).toBeTruthy();
});

test('a private player, replay or different game cannot mount a public audience note', () => {
  const feed = spectatorFeed('another-game', [note], [chat]);
  const page = render(<><SpectatorLineBubble playerId="two" side="upper" /><SpectatorCommentaryProvider
    gameId="game" players={players} events={feed}><SpectatorLineBubble playerId="two" side="lower" /><SpectatorCommentary /></SpectatorCommentaryProvider></>);
  fireEvent.click(page.getByRole('button', { name: 'Chat' }));
  expect(page.queryByText(/Guardo|Buen ataque/)).toBeNull();
});

test('a reconnected seat uses the note’s original twelve-second deadline and never revives expired notes', () => {
  vi.useFakeTimers();
  vi.setSystemTime(13_000);
  const snapshot = (at: number) => <SpectatorCommentaryProvider gameId="game" players={players}
    events={spectatorFeed('game', [{ ...note, at }], [])}>
    <SpectatorLineBubble playerId="two" side="upper" />
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
