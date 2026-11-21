import catalog from './catalog.json' with { type: 'json' }

const generic = ['Aggro', 'Combo', 'Control', 'Midrange', 'Ramp', 'Tempo']
const cache = new Map()
const key = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

function catalogFormat(format) {
  const label = String(format ?? '').replace(/^(?:(?:Block )?Constructed(?: Custom)?|Variant Magic) - /i, '')
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
  const named = labels.filter(label => title.includes(' ' + key(label) + ' '))
  if (named.length) return named.sort((a, b) => b.length - a.length)[0]
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
