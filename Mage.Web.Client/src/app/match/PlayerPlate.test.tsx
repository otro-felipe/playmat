import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PlayerPlate } from './PlayerPlate';
import styles from './PlayerPlate.module.css';

describe('player plate identity', () => {
  it('draws a saved sigil at the match seat and keeps the initial fallback', () => {
    const props = { isMe: true, targetable: false, selected: false, deciding: false, onClick: () => undefined };
    const { container, rerender } = render(<PlayerPlate {...props} player={{ name: 'Player', life: 20, userData: { avatarId: 12 } }} />);
    const avatar = () => container.querySelector(`.${styles.avatar}`)!;
    expect(avatar().querySelector('svg path')?.getAttribute('d')).toBeTruthy();
    expect(avatar().textContent).toBe('');

    rerender(<PlayerPlate {...props} player={{ name: 'Player', life: 20, userData: { avatarId: 10 } }} />);
    expect(avatar().querySelector('svg')).toBeNull();
    expect(avatar().textContent).toBe('P');
  });
});

describe('player plate hand count', () => {
  const props = { isMe: false, targetable: false, selected: false, deciding: false, onClick: () => undefined };

  it('prints the cards in hand on the seat, including zero, with an accessible count', () => {
    const { getByTestId, getByRole, rerender, queryByTestId } = render(<PlayerPlate {...props} handCount={4} player={{ name: 'Rival', life: 18 }} />);
    expect(getByTestId('plate-hand-count').textContent).toBe('4');
    expect(getByRole('img', { name: '4 cards in hand' })).toBeTruthy();
    rerender(<PlayerPlate {...props} handCount={0} player={{ name: 'Rival', life: 18 }} />);
    expect(getByTestId('plate-hand-count').textContent).toBe('0');
    rerender(<PlayerPlate {...props} player={{ name: 'Rival', life: 18 }} />);
    expect(queryByTestId('plate-hand-count')).toBeNull();
  });

  it('keeps the accessory beside life', () => {
    const { getByRole } = render(<PlayerPlate {...props} handCount={2} accessory={<button type="button">Reasoning</button>} player={{ name: 'Rival', life: 18 }} />);
    expect(getByRole('button', { name: 'Reasoning' })).toBeTruthy();
  });
});
