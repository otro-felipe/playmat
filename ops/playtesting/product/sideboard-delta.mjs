function cardCounts(cards) {
  const counted = new Map()
  for (const card of cards) {
    const name = card?.cardName ?? card?.name
    const amount = card?.amount ?? card?.quantity ?? 1
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || !Number.isSafeInteger(amount) || amount < 1) return null
    const key = name.trim().toLowerCase()
    const previous = counted.get(key)
    const total = (previous?.amount ?? 0) + amount
    if (!Number.isSafeInteger(total)) return null
    counted.set(key, { name: previous?.name ?? name.trim(), amount: total })
  }
  return counted
}

function deckCounts(deck) {
  if (!Array.isArray(deck?.cards) || !deck.cards.length || !Array.isArray(deck.sideboard)) return null
  const main = cardCounts(deck.cards)
  const pool = cardCounts([...deck.cards, ...deck.sideboard])
  return main && pool ? { main, pool } : null
}

function additions(before, after) {
  return [...after].map(([key, card]) => ({ name: card.name, amount: card.amount - (before.get(key)?.amount ?? 0) }))
    .filter(card => card.amount > 0).sort((left, right) => left.name.localeCompare(right.name, 'en'))
}

export function mainDeckChanges(previousDeck, currentDeck) {
  const before = deckCounts(previousDeck)
  const after = deckCounts(currentDeck)
  if (!before || !after || before.pool.size !== after.pool.size
    || [...before.pool].some(([key, card]) => after.pool.get(key)?.amount !== card.amount)) {
    return { status: 'unavailable' }
  }
  return {
    status: 'available',
    broughtIn: additions(before.main, after.main), tookOut: additions(after.main, before.main),
  }
}

export function submittedSideboardDelta(pair) {
  const changes = mainDeckChanges(pair?.previousDeck, pair?.currentDeck)
  return changes.status === 'available'
    ? { ...changes, fromGameNumber: pair.fromGameNumber, toGameNumber: pair.toGameNumber }
    : changes
}
