// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { StackZone } from './StackZone';
import type { GameView, StackAbilityView } from '../../protocol/generated/views';

describe('[READ-AC-001] stack target announcements', () => {
  test('keeps public targets visible for every waiting spell and ability, with no hover or resolution', () => {
    const bolt = { id: 'bolt', name: 'Lightning Bolt', targets: ['rival', 'morph'] };
    const trigger: StackAbilityView = { id: 'trigger', name: 'Triggered ability', mageObjectType: 'ABILITY_STACK_FROM_CARD', sourceCard: { name: 'Grave Titan' }, targets: ['bear'] };
    const view: GameView = {
      stack: { bolt, trigger },
      players: [{ playerId: 'rival', name: 'Bob', battlefield: { bear: { name: 'Runeclaw Bear' }, morph: { name: 'Private identity', faceDown: true } } }],
    };
    const props = { clickable: new Set<string>(), selected: new Set<string>(), sleeveOf: () => '', onClick: () => undefined, originOf: () => undefined };
    const { rerender } = render(<StackZone {...props} items={[bolt, trigger]} view={view} />);
    expect(screen.getByText('Targets: Bob · Face-down card')).toBeTruthy();
    expect(screen.getByText('Targets: Runeclaw Bear')).toBeTruthy();
    expect(screen.getByRole('listitem', { name: /Lightning Bolt, resolves next, targets: Bob, Face-down card/ })).toBeTruthy();
    expect(screen.queryByText(/Private identity/)).toBeNull();
    rerender(<StackZone {...props} items={[{ ...bolt, targets: ['bear'] }]} view={view} />);
    expect(screen.queryByText('Targets: Bob · Face-down card')).toBeNull();
    expect(screen.getByText('Targets: Runeclaw Bear')).toBeTruthy();
  });
});
