import catalog from './catalog.json' with { type: 'json' }

const generic = ['Basic Lands Practice', 'Aggro', 'Combo', 'Control', 'Midrange', 'Ramp', 'Tempo']
const cache = new Map()
const nameIndex = new Map()
const key = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

function catalogFormat(format) {
  const label = String(format || 'Freeform').replace(/^(?:(?:Block )?Constructed(?: Custom)?|Variant Magic) - /i, '')
  if (Object.hasOwn(catalog.formats, label)) return label
  if (/commander|oathbreaker|tiny leaders|brawl/i.test(label)) return 'Commander'
  if (/highlander/i.test(label)) return 'Highlander'
  return Object.keys(catalog.formats).find(name => key(name) === key(label)) ?? ''
}

export function archetypesFor(format) {
  const family = catalogFormat(format)
  if (!cache.has(family)) {
    const labels = new Set([...(catalog.formats[family] ?? []), ...generic])
    cache.set(family, [...labels].sort((a, b) => a.localeCompare(b, 'en')).concat('Other'))
  }
  return cache.get(family)
}

// Older clients and imported decks may supply only a display name. Prefer complete
// word sequences to partial text ("Land" is not a match for "Landfall").
export function classifyArchetype(format, name, cards = []) {
  const labels = archetypesFor(format)
  const title = ' ' + key(name) + ' '
  if (!nameIndex.has(labels)) {
    // Tournament indexes use nicknames and color codes. Keep aliases only when
    // their destination is an available archetype in this format.
    const aliases = Object.entries(catalog.aliases).filter(([, label]) => labels.includes(label))
    const index = [...labels.map(label => [label, label]), ...aliases]
      .map(([name, label]) => ({ pattern: ' ' + key(name) + ' ', label }))
      .sort((a, b) => b.pattern.length - a.pattern.length)
    nameIndex.set(labels, index)
  }
  const named = nameIndex.get(labels).find(entry => title.includes(entry.pattern))
  if (named) return named.label
  const names = new Set(cards.map(card => key(typeof card === 'string' ? card : card.cardName ?? card.name)))
  const signatures = [
    ['Izzet Phoenix', 'Arclight Phoenix', 'Treasure Cruise'],
    ['Mono-Green Devotion', 'Nykthos, Shrine to Nyx', 'Kiora, Behemoth Beckoner'],
    ['Lotus Field Combo', 'Lotus Field', "Thespian's Stage"],
    ['Abzan Greasefang', 'Greasefang, Okiba Boss', 'Grisly Salvage'],
    ['Amulet Titan', 'Amulet of Vigor', 'Primeval Titan'],
    ['Ruby Storm', 'Ruby Medallion', 'Ral, Monsoon Mage'],
    ['Azorius Control', 'Supreme Verdict', 'Teferi, Hero of Dominaria'],
    ['Boros Energy', 'Guide of Souls', 'Phlage, Titan of Fire\'s Fury'],
  ]
  const matches = signatures.filter(([label, ...cards]) => labels.includes(label) && cards.every(card => names.has(key(card))))
  return matches.length === 1 ? matches[0][0] : 'Other'
}
