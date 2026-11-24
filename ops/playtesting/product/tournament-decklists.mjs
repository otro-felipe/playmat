// Entry IDs must already be authorized for the requesting audience or issued by the scheduler.
export async function registeredDecklists(db, entryIds) {
  if (!entryIds.length) return []
  const { rows } = await db.query(
    `SELECT e.id,e.deck_name,NULLIF(e.opening_archetype,'Other') AS archetype,c.zone,c.card_name,c.amount,c.set_code,c.card_number
     FROM tournament_entries e JOIN tournament_entry_cards c ON c.entry_id=e.id
     WHERE e.id=ANY($1::uuid[]) ORDER BY e.id,c.zone,c.position`,
    [entryIds],
  )
  const decks = new Map()
  for (const card of rows) {
    if (!decks.has(card.id)) decks.set(card.id, { entryId: card.id, name: card.deck_name, archetype: card.archetype, cards: [], sideboard: [] })
    const zone = decks.get(card.id)[card.zone]
    zone.push({ cardName: card.card_name, amount: card.amount, setCode: card.set_code, cardNumber: card.card_number })
  }
  return entryIds.map((id) => decks.get(id)).filter(Boolean)
}
