import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { combatPreview } from '../../core/game/combatPreview';
import type { GameView } from '../../protocol/generated/views';
import { CombatPreview } from './CombatPreview';

const view: GameView = {
  myPlayerId: 'me', players: [{ playerId: 'me', name: 'Alice', life: 20 }, { playerId: 'them', name: 'Bob', life: 12 }],
  combat: [{ defenderId: 'them', defenderName: 'Bob', attackers: { bear: { id: 'bear', name: 'Bear', power: '2', toughness: '2', cardTypes: ['CREATURE'] } } }],
};

test('attack summary preserves the numerical prediction and its uncertainty without a fixed overlay', () => {
  render(<CombatPreview view={view} mode="declareAttackers" preview={combatPreview(view)} />);
  expect(screen.getByRole('region', { name: 'Attack estimate' }).textContent).toContain('2 damage, Bob goes to 10');
  expect(screen.getByText('Estimate: ignores tricks and triggers.')).toBeTruthy();
});

test('blocking details are available in a collapsed disclosure; no forecast means no panel', () => {
  const blocked: GameView = { ...view, combat: [{ ...view.combat![0], blockers: { guard: { id: 'guard', name: 'Guard', power: '2', toughness: '2', cardTypes: ['CREATURE'] } } }] };
  const { container, rerender } = render(<CombatPreview view={blocked} mode="declareBlockers" preview={combatPreview(blocked)} />);
  const details = container.querySelector('details')!;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain('they trade');
  rerender(<CombatPreview view={view} mode="priority" preview={null} />);
  expect(screen.queryByRole('region')).toBeNull();
});
