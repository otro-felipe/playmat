// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { StackZone } from './StackZone';
import type { GameView, StackAbilityView } from '../../protocol/generated/views';
import { useMatchUi } from './matchUi';

describe('[READ-AC-001] stack target announcements', () => {
  test.each([
    { id: 'hidden', name: 'Private identity', faceDown: true },
    { id: 'hidden-trigger', name: 'Triggered ability', mageObjectType: 'ABILITY_STACK_FROM_CARD', sourceCard: { name: 'Private identity', hideInfo: true } },
  ] as StackAbilityView[])('keeps hidden stack identities out of accessible labels for $id', (item) => {
    render(<StackZone items={[item]} clickable={new Set()} selected={new Set()} sleeveOf={() => ''} onClick={() => undefined} originOf={() => undefined} />);
    expect(screen.getByRole('listitem', { name: /Face-down card, resolves next/ })).toBeTruthy();
    expect(screen.queryByRole('listitem', { name: /Private identity/ })).toBeNull();
  });

  test('keeps public target names accessible for every waiting spell and ability without a visible panel', () => {
    const bolt = { id: 'bolt', name: 'Lightning Bolt', targets: ['rival', 'morph'] };
    const trigger: StackAbilityView = { id: 'trigger', name: 'Triggered ability', mageObjectType: 'ABILITY_STACK_FROM_CARD', sourceCard: { name: 'Grave Titan' }, targets: ['bear'] };
    const view: GameView = {
      stack: { bolt, trigger },
      players: [{ playerId: 'rival', name: 'Bob', battlefield: { bear: { name: 'Runeclaw Bear' }, morph: { name: 'Private identity', faceDown: true } } }],
    };
    const props = { clickable: new Set<string>(), selected: new Set<string>(), sleeveOf: () => '', onClick: () => undefined, originOf: () => undefined };
    const { rerender } = render(<StackZone {...props} items={[bolt, trigger]} view={view} />);
    expect(screen.queryByRole('list', { name: 'Stack targets' })).toBeNull();
    expect(screen.getByRole('listitem', { name: /Lightning Bolt, resolves next, targets: Bob, Face-down card/ })).toBeTruthy();
    expect(screen.queryByText(/Private identity/)).toBeNull();
    rerender(<StackZone {...props} items={[{ ...bolt, targets: ['bear'] }]} view={view} />);
    expect(screen.getByRole('listitem', { name: /Lightning Bolt, resolves next, targets: Runeclaw Bear/ })).toBeTruthy();
    expect(screen.queryByText(/Targets:/)).toBeNull();
  });

  test('[READ-AC-004] keyboard focus emphasizes a lower spell without dispatching a game action', () => {
    const below = { id: 'burst', name: 'Burst Lightning', targets: ['doge'] };
    render(<StackZone items={[{ id: 'top', name: 'Counterspell' }, below]} view={{ players: [{ playerId: 'doge', name: 'Doge' }] }} clickable={new Set()} selected={new Set()} sleeveOf={() => ''} onClick={() => { throw new Error('Unexpected game action'); }} originOf={() => undefined} />);
    const item = screen.getByRole('listitem', { name: 'Burst Lightning, targets: Doge' });
    expect(item.getAttribute('tabindex')).toBe('0');
    fireEvent.focus(item);
    expect(useMatchUi.getState().stackFocus).toBe('burst');
    fireEvent.blur(item);
    expect(useMatchUi.getState().stackFocus).toBeNull();
  });
});
