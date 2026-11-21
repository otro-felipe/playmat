import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'

// The Docker product service carries the same catalog the offline web builder uses.
const packaged = new URL('./archetypes/library.mjs', import.meta.url)
const source = new URL('../../../Mage.Web.Client/src/core/decks/archetypes/library.mjs', import.meta.url)
export const { archetypesFor, classifyArchetype } = await import(existsSync(packaged) ? packaged : source)

export function deckListSignature(deck) {
  if (!Array.isArray(deck?.cards) || (deck.sideboard != null && !Array.isArray(deck.sideboard))) return null
  const zones = []
  for (const entries of [deck.cards, deck.sideboard ?? []]) {
    const counts = new Map()
    for (const card of entries) {
      const rawName = typeof card === 'string' ? card : card?.cardName ?? card?.name
      const name = typeof rawName === 'string' && rawName.normalize('NFKC').trim().toLowerCase()
      const amount = card?.amount ?? card?.quantity ?? card?.count ?? 1
      if (!name || !Number.isSafeInteger(amount) || amount < 1) return null
      counts.set(name, (counts.get(name) ?? 0) + amount)
    }
    zones.push([...counts.keys()].sort().map(name => [name, counts.get(name)]))
  }
  return createHash('sha256').update(JSON.stringify(zones)).digest('hex')
}
