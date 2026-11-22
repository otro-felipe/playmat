// The engine supplies the legal object and ability IDs. Zones identify the visible
// object selected by play_line and never establish that an action is legal.
export function visiblePlaySource(state, objectId) {
  if (!objectId) return;
  const locate = (cards, zone) => {
    const card = cards?.find(card => card.id === objectId && !card.faceDown);
    return card && { card, zone };
  };
  const hand = locate(state.ownHand, 'hand');
  if (hand) return hand;
  for (const player of state.players ?? []) {
    const publicSource = locate(player.exile, 'exile') ?? locate(player.graveyard, 'graveyard');
    if (publicSource) return publicSource;
  }
}

// Leave unresolved alternatives separate. In particular, an ability picker
// grants no authority to choose a target, mode, payment or defender for the pilot.
export function priorityChoiceActions(choice, state, ownObjects) {
  if (choice.type !== 'object' || !choice.id || !choice.objectId || choice.card?.faceDown
    || choice.card?.id !== choice.objectId) return;
  const sourceId = choice.objectId;
  const main = !state.stack?.length && ['PRECOMBAT_MAIN', 'POSTCOMBAT_MAIN'].includes(state.step)
    && state.players?.some(p => p.yourSeat && p.id === state.activePlayerId);
  const timing = main ? {} : { when: 'priority' };

  if (ownObjects.has(sourceId)) {
    const abilities = choice.nonManaAbilities;
    if (!abilities?.length) return;
    const activate = ({ abilityId, abilityText }) => abilityId && abilityText
      && abilities.filter(entry => entry.abilityId === abilityId).length === 1
      ? { kind: 'activate', sourceId, abilityId, abilityText, ...timing } : undefined;
    if (abilities.length === 1) {
      const playLineAction = activate(abilities[0]);
      return playLineAction && { playLineAction };
    }
    return { nonManaAbilities: abilities.map(entry => {
      const playLineAction = activate(entry);
      return playLineAction ? { ...entry, playLineAction } : entry;
    }) };
  }

  const source = visiblePlaySource(state, sourceId);
  if (!source) return;
  const select = { objectId: sourceId, zone: source.zone };
  const land = main && choice.canPlayLand ? { kind: 'play', playAs: 'land', select } : undefined;
  const spells = choice.spellAbilities;
  if (!spells?.length || !source.card.cardId || !Array.isArray(source.card.types) || source.card.types.includes('LAND')) {
    return land && { playLineAction: land };
  }
  const cast = { kind: 'play', select, ...timing };
  if (!land && spells.length === 1 && spells[0].abilityId) return { playLineAction: cast };
  return { ...(land && { playLineAction: land }), spellAbilities: spells.map(entry => {
    const unique = entry.abilityId && spells.filter(ability => ability.abilityId === entry.abilityId).length === 1;
    return unique ? { ...entry, playLineAction: { ...cast, spellAbilityId: entry.abilityId } } : entry;
  }) };
}
