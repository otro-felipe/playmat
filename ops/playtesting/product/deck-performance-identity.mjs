import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import starters from './starter-archetypes.json' with { type: 'json' }

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

export const basicLandNames = ['plains', 'island', 'swamp', 'mountain', 'forest', 'wastes'].flatMap(name => [name, 'snow-covered ' + name])

const familyOf = format => String(format || 'Freeform').replace(/^(?:Constructed|Variant Magic) - /, '')

// Build the exact-composition index once from the shipped public examples. It is
// entirely local and cannot turn a partial or ambiguous match into a classification.
let publicLists
function loadPublicLists() {
  const examples = new Map()
  const roots = [new URL('../../../Mage.Web.Client/public/', import.meta.url), new URL('file:///srv/playmat/')]
  for (const shelf of ['meta-decks', 'starter-decks']) {
    const root = roots.map(base => new URL(shelf + '/', base)).find(dir => existsSync(new URL('index.json', dir)))
    if (!root) continue
    const index = JSON.parse(readFileSync(new URL('index.json', root), 'utf8'))
    for (const item of index.decks ?? index) {
      const format = familyOf(item.format)
      const label = starters[item.name]?.[1] ?? classifyArchetype(format, item.name)
      if (label === 'Other' || !archetypesFor(format).includes(label)) continue
      const deck = { cards: [], sideboard: [] }
      const lines = readFileSync(new URL(item.file, root), 'utf8').trim().split(/\r?\n/).filter(line => line && !line.startsWith('NAME:'))
      for (const line of lines) {
        const entry = line.match(/^(SB:\s*)?(\d+)\s+\[[^\]]+\]\s+(.+)$/)
        if (!entry) { deck.cards = []; break }
        deck[entry[1] ? 'sideboard' : 'cards'].push({ name: entry[3], quantity: Number(entry[2]) })
      }
      if (!deck.cards.length) continue
      const key = format + '/' + deckListSignature(deck)
      examples.set(key, examples.has(key) && examples.get(key) !== label ? null : label)
    }
  }
  return examples
}

export function publicListArchetype(format, signature) {
  publicLists ??= loadPublicLists()
  return publicLists.get(familyOf(format) + '/' + signature) ?? null
}

/** A full main deck plus independent evidence. Titles by themselves cannot refine an old default. */
export function verifiedListArchetype(format, name, cards, sideboard = []) {
  const size = cards.reduce((sum, card) => sum + (card.amount ?? card.quantity ?? card.count ?? 1), 0)
  if (size < (format === 'Limited' ? 40 : 60)) return null
  const registered = [...cards, ...sideboard].map(card => (typeof card === 'string' ? card : card.cardName ?? card.name).trim().toLowerCase())
  const family = familyOf(format)
  const title = String(name ?? '').trim().toLowerCase()
  const starter = Object.entries(starters).find(([label, [wantedFormat, , face]]) =>
    label.toLowerCase() === title && wantedFormat === family && registered.includes(face.toLowerCase()))
  if (starter) return starter[1][1]
  if (!/momir|commander|brawl|oathbreaker|tiny leaders/i.test(family) && registered.every(name => basicLandNames.includes(name))) {
    return 'Basic Lands Practice'
  }
  return null
}
