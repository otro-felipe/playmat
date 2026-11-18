import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { CounterBadges } from './CounterBadges';

test('Saga chapter number is visible at one counter and updates when lore is added or removed', () => {
  const { rerender } = render(<CounterBadges permanent={{ subTypes: ['SAGA'], counters: [{ name: 'lore', count: 1 }] }} />);
  expect(screen.getByLabelText('Saga: 1 lore counter').textContent).toBe('Ch.1');
  rerender(<CounterBadges permanent={{ subTypes: ['SAGA'], counters: [{ name: 'lore', count: 2 }] }} />);
  expect(screen.getByLabelText('Saga: 2 lore counters').textContent).toBe('Ch.2');
  rerender(<CounterBadges permanent={{ subTypes: ['SAGA'], counters: [] }} />);
  expect(screen.getByLabelText('Saga: 0 lore counters').textContent).toBe('Ch.0');
  rerender(<CounterBadges permanent={{ subTypes: ['HUMAN'], counters: [] }} />);
  expect(screen.queryByRole('list')).toBeNull();
});
