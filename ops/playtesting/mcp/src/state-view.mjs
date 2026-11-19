import { isDeepStrictEqual } from 'node:util';

function compactCard({ hints, setCode, cardNumber, ...card }) {
  return hints?.length ? { ...card, hints } : card;
}

const compactCards = (cards) => cards?.map(compactCard);
const compactGroups = (groups) => groups?.map((group) => ({ ...group, cards: compactCards(group.cards) }));

export function compactGameState(state) {
  const compact = {
    ...state,
    ownHand: compactCards(state.ownHand),
    stack: compactCards(state.stack),
    revealed: compactGroups(state.revealed),
    lookedAt: compactGroups(state.lookedAt),
    players: state.players?.map((player) => ({
      ...player,
      topCard: player.topCard && compactCard(player.topCard),
      battlefield: compactCards(player.battlefield),
      graveyard: compactCards(player.graveyard),
      exile: compactCards(player.exile),
    })),
    combat: state.combat?.map((group) => ({ ...group,
      attackers: compactCards(group.attackers), blockers: compactCards(group.blockers),
    })),
  };
  if (state.decision?.choices?.length) {
    const visibleCards = indexVisibleCards(compact);
    compact.decision = { ...state.decision, choices: state.decision.choices.map((choice) => compactChoice(choice, visibleCards)) };
  }
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

function compactChoice({ card: fullCard, cards, ...choice }, visibleCards) {
  if (fullCard) {
    const card = compactCard(fullCard);
    // A prompt can carry a different representation or the only visible record of an object.
    if (card.id && isDeepStrictEqual(visibleCards.get(card.id), card)) choice.cardRef = card.id;
    else choice.card = card;
  }
  if (cards) choice.cards = compactCards(cards);
  return choice;
}

export function formatGameReceipt(receipt, view) {
  if (view !== 'compact' || !receipt.state) return receipt;
  const result = { ...receipt, state: compactGameState(receipt.state) };
  if (result.event === 'timeout' && result.cursor === result.state.cursor) delete result.cursor;
  return result;
}
