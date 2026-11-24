import { isDeepStrictEqual } from 'node:util';

// The compact view is presentation only: the executor always validates against
// the full engine snapshot. It keeps every ID, legal choice, public number and
// prompt field needed to plan, and drops text the seat already received.

export const RULES_OMITTED = 'Rules of cards already sent in this game are omitted. get_game_state sends every rule again.';

/** Per-seat memory of what compact responses have already delivered in one game. */
export function createViewMemory() {
  return { gameId: null, rules: new Set(), warning: null };
}

export function resetViewMemory(memory) {
  if (!memory) return;
  memory.gameId = null;
  memory.rules.clear();
  memory.warning = null;
}

function prepareMemory(memory, gameId) {
  if (!memory) return null;
  if (memory.gameId !== gameId) {
    resetViewMemory(memory);
    memory.gameId = gameId;
  }
  return memory;
}

const blank = (value) => value === undefined || value === null || value === '' || value === '0';

// zoneChangeCounter and enteringSpellId identify an incarnation for the executor only.
function compactCard({ hints, setCode, cardNumber, zoneChangeCounter, enteringSpellId, ...card }, context = {}) {
  const { ownerId, memory, keepRules, omitted } = context;
  if (card.cardId === card.id) delete card.cardId;
  if (ownerId && card.controllerId === ownerId) delete card.controllerId;
  if (!card.types?.includes('CREATURE') && blank(card.power) && blank(card.toughness)) {
    delete card.power;
    delete card.toughness;
  }
  if (card.damage === 0) delete card.damage;
  if (card.tapped === false) delete card.tapped;
  for (const field of ['manaCost', 'counters', 'targets']) {
    if (Array.isArray(card[field]) && card[field].length === 0) delete card[field];
  }
  if (memory && !keepRules && Array.isArray(card.rules) && !card.faceDown) {
    const key = `${card.name}\n${card.rules.join('\n')}`;
    if (memory.rules.has(key)) {
      delete card.rules;
      if (omitted) omitted.count++;
    } else memory.rules.add(key);
  }
  return hints?.length ? { ...card, hints } : card;
}

const compactCards = (cards, context) => cards?.map((card) => compactCard(card, context));
const compactGroups = (groups, context) => groups?.map((group) => ({ ...group, cards: compactCards(group.cards, context) }));

function compactEvidence(evidence) {
  if (!evidence) return evidence;
  // Resolution, action and combat ledgers are executor evidence; the receipt reports their outcome.
  const { epoch, resolutionRevision, combatRevision, informationRevision, ownImpulseExile } = evidence;
  return { epoch, resolutionRevision, combatRevision, informationRevision, ...(ownImpulseExile ? { ownImpulseExile } : {}) };
}

function compactTiming(timing, memory) {
  if (!timing?.warning || !memory) return timing;
  if (memory.warning === timing.warning) {
    const { warning, ...rest } = timing;
    return { ...rest, warningRepeated: true };
  }
  memory.warning = timing.warning;
  return timing;
}

export function compactGameState(state, memory) {
  const seen = prepareMemory(memory, state.gameId ?? null);
  const omitted = { count: 0 };
  const zone = (cards, ownerId) => compactCards(cards, { ownerId, memory: seen, omitted });
  const compact = {
    ...state,
    ownHand: zone(state.ownHand, state.players?.find((player) => player.yourSeat)?.id),
    stack: compactCards(state.stack, { keepRules: true }),
    revealed: compactGroups(state.revealed, { memory: seen, omitted }),
    lookedAt: compactGroups(state.lookedAt, { memory: seen, omitted }),
    players: state.players?.map((player) => ({
      ...player,
      topCard: player.topCard && compactCard(player.topCard, { ownerId: player.id, memory: seen, omitted }),
      battlefield: zone(player.battlefield, player.id),
      graveyard: zone(player.graveyard, player.id),
      exile: zone(player.exile, player.id),
    })),
    combat: state.combat?.map((group) => ({ ...group,
      attackers: zone(group.attackers), blockers: zone(group.blockers),
    })),
    ...(state.sequenceEvidence ? { sequenceEvidence: compactEvidence(state.sequenceEvidence) } : {}),
    ...(state.timing ? { timing: compactTiming(state.timing, seen) } : {}),
  };
  if (state.decision?.choices?.length) {
    const visibleCards = indexVisibleCards(state);
    const { decision } = state;
    compact.decision = { ...decision, choices: decision.choices.map((choice) => compactChoice(choice, visibleCards, !!seen)) };
    if (state.priority === 'self' && decision.kind === 'priority'
        && decision.choices.length === 1 && decision.choices[0].type === 'pass') {
      compact.decision.onlyPass = true;
    }
  }
  if (omitted.count) compact.rulesOmitted = RULES_OMITTED;
  return compact;
}

function indexVisibleCards(state) {
  const cards = [
    ...(state.ownHand ?? []), ...(state.stack ?? []),
    ...(state.revealed ?? []).flatMap(({ cards }) => cards ?? []),
    ...(state.lookedAt ?? []).flatMap(({ cards }) => cards ?? []),
    ...(state.players ?? []).flatMap(({ topCard, battlefield, graveyard, exile }) =>
      [...(topCard ? [topCard] : []), ...(battlefield ?? []), ...(graveyard ?? []), ...(exile ?? [])]),
    ...(state.combat ?? []).flatMap(({ attackers, blockers }) => [...(attackers ?? []), ...(blockers ?? [])]),
  ];
  const byId = new Map();
  for (const card of cards) {
    if (!card.id) continue;
    if (!byId.has(card.id)) byId.set(card.id, card);
    else if (!isDeepStrictEqual(byId.get(card.id), card)) byId.set(card.id, null);
  }
  return byId;
}

// A single-colour plain source pays with its object ID; its option list adds nothing.
function derivablePayment(choice) {
  return choice.plainMana === true && choice.payWithOptions?.length === 1
    && choice.payWithOptions[0].sourceId === choice.objectId;
}

function inlineCard({ hints, setCode, cardNumber, ...card }) {
  return hints?.length ? { ...card, hints } : card;
}

function compactChoice({ card: fullCard, cards, ...choice }, visibleCards, withMemory) {
  if (fullCard) {
    const visible = fullCard.id && visibleCards.get(fullCard.id);
    // A prompt can carry a different representation or the only visible record of an
    // object. Compare normalized copies so default-valued fields do not force an inline card.
    if (visible && isDeepStrictEqual(compactCard({ ...visible }), compactCard({ ...fullCard }))) choice.cardRef = fullCard.id;
    else choice.card = inlineCard(fullCard);
  }
  if (cards) choice.cards = cards.map(inlineCard);
  if (withMemory && derivablePayment(choice)) {
    delete choice.payWithOptions;
    if (choice.manaAbilities?.length === 1) {
      choice.manaColors ??= choice.manaAbilities[0].manaColors;
      delete choice.manaAbilities;
    }
  }
  return choice;
}

export function formatGameReceipt(receipt, view, memory) {
  if (view !== 'compact' || !receipt.state) return receipt;
  const result = { ...receipt, state: compactGameState(receipt.state, memory) };
  if (result.event === 'timeout' && result.cursor === result.state.cursor) delete result.cursor;
  return result;
}
