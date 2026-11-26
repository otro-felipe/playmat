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

// XMage gives a granted mana ability (Urborg's {B} on every land, for example)
// a new ability ID each time continuous effects are applied. Remember every
// projected mana ability so a recently observed ID still names the same
// source and colors. A renewed ID resolves only when exactly one current
// ability of that source is new since the observation and makes the same colors.
export class ManaAbilityMemory {
  #seen = new Map();

  constructor(limit = 4000) { this.limit = limit; }

  observe(state) {
    for (const choice of state?.decision?.choices ?? []) {
      const sourceId = choice.objectId ?? choice.card?.id;
      const abilities = choice.manaAbilities;
      if (!sourceId || !Array.isArray(abilities) || !abilities.length) continue;
      const siblings = new Set(abilities.map(({ abilityId }) => abilityId));
      for (const { abilityId, manaColors } of abilities) {
        if (!abilityId) continue;
        this.#seen.delete(abilityId);
        this.#seen.set(abilityId, { sourceId, colors: colorKey(manaColors), siblings });
      }
    }
    while (this.#seen.size > this.limit) this.#seen.delete(this.#seen.keys().next().value);
  }

  // Returns the current ability ID for a declared one, or undefined when it cannot be proven.
  resolve(sourceId, abilityId, color, abilities) {
    if (!abilityId || !Array.isArray(abilities)) return abilityId;
    if (abilities.some((ability) => ability.abilityId === abilityId)) return abilityId;
    const memory = this.#seen.get(abilityId);
    if (!memory || memory.sourceId !== sourceId || (color && !memory.colors.split('').includes(color))) return undefined;
    const renewed = abilities.filter((ability) => ability.abilityId && !memory.siblings.has(ability.abilityId)
      && colorKey(ability.manaColors) === memory.colors);
    return renewed.length === 1 ? renewed[0].abilityId : undefined;
  }
}

function colorKey(colors) {
  return [...(colors ?? [])].sort().join('');
}

// Compare optional plays without the per-application IDs of mana abilities.
export function stableOption(choice) {
  if (!Array.isArray(choice?.manaAbilities)) return choice;
  return { ...choice, manaAbilities: choice.manaAbilities.map(({ manaColors }) => colorKey(manaColors)).sort() };
}
