import catalog from './catalog.json' with { type: 'json' }

const generic = ['Empty deck', 'Basic Lands Practice', 'Creature Practice', 'Aggro', 'Combo', 'Control', 'Midrange', 'Ramp', 'Tempo']
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
    const labels = new Set([...(family === 'Freeform' ? Object.values(catalog.formats).flat() : catalog.formats[family] ?? []), ...generic])
    cache.set(family, [...labels].sort((a, b) => a.localeCompare(b, 'en')).concat('Other'))
  }
  return cache.get(family)
}

// Main-deck packages from the Pioneer MTGO Challenges documented in catalog.sources.
// Requiring several signature cards keeps a shared staple or sideboard splash from choosing a label.
const tournamentPackages = [
  ['Temur Lessons', 'Gran-Gran', 'Tablet of Discovery', 'Firebending Lesson', 'Questing Druid'],
  ['Four-Color Lessons', 'Gran-Gran', 'Tablet of Discovery', 'Firebending Lesson', 'Questing Druid', 'Jeskai Revelation'],
  ['Rakdos Midrange', 'Bloodtithe Harvester', 'Fable of the Mirror-Breaker', 'Thoughtseize', 'Sheoldred, the Apocalypse'],
  ['Sultai Beanstalk', 'Up the Beanstalk', 'Overlord of the Balemurk', 'Wistfulness', 'Deceit'],
  ['Rakdos Leyline Aggro', 'Leyline of Resonance', 'Callous Sell-Sword', 'Cacophony Scamp'],
  ['Izzet Prowess', "Stormchaser's Talent", 'Academic Dispute', 'Pompous Battlemage', 'Spirebluff Canal'],
  ['Retraction Helix', 'Retraction Helix', 'Mox Amber', 'Rona, Herald of Invasion'],
  ['Mono-Green Creature Toolbox', 'Fiend Artisan', 'Enduring Vitality', "Nature's Rhythm", 'Craterhoof Behemoth'],
  ['Dimir Control', 'Anthropological Mission', 'Drown in the Loch', 'Fatal Push', 'Spell Snare', 'Thoughtseize'],
  ['Dimir Control', 'Drown in the Loch', 'Fatal Push', 'Spell Snare', 'Jace Beleren', 'Thoughtseize'],
  ['Mono-Red Prowess', 'Mountain', 'Monastery Swiftspear', 'Soul-Scar Mage', 'Slickshot Show-Off', 'Monstrous Rage', 'Play with Fire'],
  ['Mono-Red Aggro', 'Kumano Faces Kakkazan', 'Soul-Scar Mage', 'Sunspine Lynx', 'Screaming Nemesis'],
  ['Orzhov Ketramose', 'Ketramose, the New Dawn', 'Rest in Peace', 'Eldrazi Displacer', 'Wasteland Strangler'],
  ['Dimir Ninjas', 'Kaito, Bane of Nightmares', 'Moon-Circuit Hacker', 'Faerie Miscreant'],
  ['Golgari Midrange', 'Badgermole Cub', 'Graveyard Trespasser', 'Sheoldred, the Apocalypse', 'Overgrown Tomb'],
  ['Izzet Prowess', "Stormchaser's Talent", 'Monastery Swiftspear', 'Reckless Rage', 'Spirebluff Canal'],
  ['Izzet Cauldron', 'Vivi Ornitier', "Agatha's Soul Cauldron", "Proft's Eidetic Memory"],
  ['Izzet Elementals', 'Hearth Elemental', 'Eddymurk Crab', 'Prismari Charm'],
  ['Izzet Lessons', 'Gran-Gran', 'Tablet of Discovery', 'Firebending Lesson'],
  ['Jund Sacrifice', 'Biotech Specialist', 'Shambling Ghast', 'The Sackville-Bagginses'],
  ['Hammer Time', 'Cloud, Midgar Mercenary', 'Colossus Hammer', "Sigarda's Aid"],
  ["Lumra's Scapeshift", 'Lumra, Bellow of the Woods', 'Scapeshift', 'Spelunking'],
  ['Selesnya Company', 'Collected Company', 'Aven Interrupter', 'Skyclave Apparition', 'Llanowar Elves'],
  ['Azorius Nine Lives', 'Nine Lives', 'Coveted Falcon', 'Cleansing Nova'],
  ['Mono-Green Devotion', 'Nykthos, Shrine to Nyx', 'Kiora, Behemoth Beckoner', 'Old-Growth Troll'],
  ['Azorius Control', 'Supreme Verdict', 'Teferi, Hero of Dominaria', "Dovin's Veto"],
]

// Every card in these registered mono-red lists is known. Leave unrecognized splashes unresolved.
const monoRedProwessCards = new Set([
  'Mountain', 'Den of the Bugbear', 'Monastery Swiftspear', 'Soul-Scar Mage', 'Slickshot Show-Off', 'Monstrous Rage',
  'Play with Fire', 'Lightning Strike', 'Emberheart Challenger', 'Light Up the Stage', "Wizard's Lightning",
  'Burst Lightning', 'Rending Volley', 'Unlicensed Hearse', 'Abrade', 'Reckless Impulse', 'Roiling Vortex', 'Skewer the Critics',
].map(key))

const creaturePracticeLists = [
  { forest: 44, 'elvish mystic': 4, 'elvish reclaimer': 4, 'gilded goose': 4, 'llanowar elves': 4 },
  { mountain: 56, 'monastery swiftspear': 4 },
]

export function isCreaturePracticeMain(cards) {
  const counts = new Map()
  for (const card of cards) {
    const name = key(typeof card === 'string' ? card : card.cardName ?? card.name)
    const amount = card.amount ?? card.quantity ?? card.count ?? 1
    if (!Number.isSafeInteger(amount) || amount < 1) return false
    counts.set(name, (counts.get(name) ?? 0) + amount)
  }
  return creaturePracticeLists.some(list => Object.keys(list).length === counts.size
    && Object.entries(list).every(([name, amount]) => counts.get(name) === amount))
}

export function tournamentArchetype(format, cards) {
  const family = catalogFormat(format)
  const legacyPackages = [
    ['Beanstalk Control', 'Up the Beanstalk', 'Force of Will', 'Leyline Binding', 'Brainstorm'],
    ['Eldrazi Stompy', 'Eldrazi Temple', 'Eye of Ugin', 'Thought-Knot Seer', 'Reality Smasher'],
    ['Rakdos Reanimator', 'Reanimate', 'Animate Dead', 'Griselbrand', 'Faithless Looting'],
  ]
  const packages = !format || family === 'Freeform' ? [...tournamentPackages, ...legacyPackages]
    : family === 'Pioneer' ? tournamentPackages : family === 'Legacy' ? legacyPackages : []
  const names = new Set(cards.map(card => key(String(typeof card === 'string' ? card : card.cardName ?? card.name).split(/\s+\/\/?\s+/)[0])))
  const matches = packages.filter(([label, ...signature]) => signature.every(name => names.has(key(name)))
    && (label !== 'Mono-Red Prowess' || [...names].every(name => monoRedProwessCards.has(name))))
  // A narrow splash can contain the entire core of its parent archetype. Hybrid
  // packages without a subset relationship remain ambiguous.
  const specific = matches.filter(([label, ...subset]) => !matches.some(([other, ...superset]) =>
    label !== other && superset.length > subset.length && subset.every(card => superset.includes(card))))
  const labels = new Set(specific.map(([label]) => label))
  return labels.size === 1 ? specific[0][0] : null
}

// Older clients and imported decks may supply only a display name. Prefer complete
// word sequences to partial text ("Land" is not a match for "Landfall").
export function classifyArchetype(format, name, cards = []) {
  if (isCreaturePracticeMain(cards)) return 'Creature Practice'
  const labels = archetypesFor(format)
  if (/^other(?: (?:aggro|control|combo))?$/.test(key(name))) return 'Other'
  const title = ' ' + key(name) + ' '
  if (!nameIndex.has(labels)) {
    // Tournament indexes use nicknames and color codes. Keep aliases only when
    // their destination is an available archetype in this format.
    const family = catalogFormat(format)
    const namedLabels = family === 'Freeform' ? [...catalog.formats.Freeform, ...generic] : labels
    const aliases = Object.entries({ ...catalog.aliases, ...catalog.formatAliases?.[family] }).filter(([, label]) => namedLabels.includes(label))
    const index = [...namedLabels.map(label => [label, label]), ...aliases]
      .map(([name, label]) => ({ pattern: ' ' + key(name) + ' ', label }))
      .sort((a, b) => b.pattern.length - a.pattern.length)
    nameIndex.set(labels, index)
  }
  const named = nameIndex.get(labels).find(entry => title.includes(entry.pattern))
  const tournament = tournamentArchetype(format, cards)
  const full = cards.reduce((count, card) => count + (card.amount ?? card.quantity ?? card.count ?? 1), 0) >= 60
  if (full && tournament) return tournament
  if (named) return named.label
  if (tournament) return tournament
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
