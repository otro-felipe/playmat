// A projected option describes a legal click now. It is never a reservation of
// the source, a suggested payment order, or proof of what it can pay later.
export function paymentOptions(choice, kind, ownObjects) {
  const sourceId = choice.objectId ?? choice.card?.id;
  if (!ownObjects.has(sourceId) || !['object', 'manaAbility'].includes(choice.type)) return;
  const abilities = choice.manaAbilities ?? [];
  if (kind !== 'payMana' && choice.type !== 'manaAbility' && !abilities.length) return;
  if (!abilities.length) return [{ sourceId }];
  return abilities.flatMap(({ abilityId, manaColors }) => manaColors?.length
    ? manaColors.map(color => ({ sourceId, abilityId, color }))
    : [{ sourceId, abilityId }]);
}

export function absentPaymentIndex(state, payWith) {
  if (!payWith?.length || state.priority !== 'self' || state.decision?.kind !== 'priority'
    || !state.players?.some(player => player.yourSeat) || !state.players.every(player => Array.isArray(player.battlefield))) return -1;
  // Only rule out an unobserved object before its own immediately legal
  // announcement. Availability, tapped status and reuse depend on the engine.
  const visible = [
    ...(state.ownHand ?? []), ...(state.stack ?? []),
    ...state.players.flatMap(p => [...p.battlefield, ...(p.graveyard ?? []), ...(p.exile ?? [])]),
    ...(state.revealed ?? []).flatMap(g => g.cards ?? []), ...(state.lookedAt ?? []).flatMap(g => g.cards ?? []),
  ];
  const ids = new Set([...visible.map(card => card.id), ...state.decision.choices.map(c => c.objectId ?? c.card?.id)]);
  return payWith.findIndex(payment => !ids.has(typeof payment === 'string' ? payment : payment.sourceId));
}
