import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { revealGroups } from '../../core/game/reveals';
import { useMatchUi } from './matchUi';
import { Reveals } from './Reveals';

afterEach(cleanup);

it.each([
  ['Narset, Parter of Veils', 'Opt'],
  ['Board the Weatherlight', 'Sol Ring'],
])('names the card publicly revealed by %s on the board before the opponent opens it', async (source, chosen) => {
  const groups = revealGroups({ myPlayerId: 'opponent', revealed: [{ name: source, cards: {
    picked: { id: 'picked', ownerId: 'pilot', name: chosen, zone: 'LIBRARY' },
  } }] });
  const ui = render(<Reveals groups={groups} myPlayerId="opponent" opponentIds={['pilot']} />);
  const button = await ui.findByRole('button', { name: new RegExp(chosen) });
  expect(button.textContent).toContain(chosen);
  fireEvent.click(button);
  expect(useMatchUi.getState().viewer?.cards.map(card => card.name)).toEqual([chosen]);
});

it('does not announce a reveal when the private choice was declined', () => {
  const ui = render(<Reveals groups={revealGroups({ myPlayerId: 'opponent' })} myPlayerId="opponent" opponentIds={['pilot']} />);
  expect(ui.queryAllByRole('button')).toHaveLength(0);
});
