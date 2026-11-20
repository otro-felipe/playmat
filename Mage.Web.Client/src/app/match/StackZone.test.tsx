// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { StackZone } from './StackZone';
import type { CardView, GameView, StackAbilityView } from '../../protocol/generated/views';
import './matchMessages';
import { useMatchUi } from './matchUi';

vi.mock('../../core/images/useCardImage', () => ({
  useCardImage: (card: CardView | null) => card?.subTypes?.includes('ROOM') ? '/combined-room-art.png' : undefined,
}));

describe('Room spells on the live stack', () => {
  const props = { clickable: new Set<string>(), selected: new Set<string>(), sleeveOf: () => '', onClick: () => undefined, originOf: () => undefined };

  test.each(['Unholy Annex', 'Ritual Chamber'])('[READ-AC-008] names the cast door %s over the combined artwork', (door) => {
    const spell: CardView = { id: 'room', name: door, mageObjectType: 'SPELL', subTypes: ['ROOM'] };
    render(<StackZone {...props} items={[spell]} />);
    expect(screen.getByRole('img', { name: door }).getAttribute('src')).toBe('/combined-room-art.png');
    expect(screen.getByText(`Casting ${door}`)).toBeTruthy();
    expect(screen.getByRole('listitem', { name: `Casting ${door}, resolves next` })).toBeTruthy();
    expect(screen.getByText('Resolving next')).toBeTruthy();
  });

  test.each([
    { name: 'Unholy Annex // Ritual Chamber', subTypes: ['ROOM'] },
    { name: 'Unholy Annex', subTypes: ['ROOM'], faceDown: true },
    { name: 'Lightning Bolt' },
  ] as CardView[])('[READ-AC-008] shows no door when the stack view does not identify a public Room half', (spell) => {
    render(<StackZone {...props} items={[{ ...spell, id: 'spell', mageObjectType: 'SPELL' }]} />);
    expect(screen.queryByText(/^Casting/)).toBeNull();
    expect(screen.getByText('Resolving next')).toBeTruthy();
  });
});

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
