import { existsSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { createRequire } from 'node:module'
import {
  archetypesFor,
  canonicalArchetype,
  deckListSignature,
  publicCompositionName,
  publicListArchetype,
  tournamentArchetype,
  isCreaturePracticeMain,
  basicLandNames,
} from './deck-performance-identity.mjs'

const letters = [...'WUBRG']
const palettes = {
  azorius: 'WU',
  dimir: 'UB',
  rakdos: 'BR',
  gruul: 'RG',
  selesnya: 'WG',
  orzhov: 'WB',
  izzet: 'UR',
  golgari: 'BG',
  boros: 'WR',
  simic: 'UG',
  esper: 'WUB',
  grixis: 'UBR',
  jund: 'BRG',
  naya: 'WRG',
  bant: 'WUG',
  abzan: 'WBG',
  jeskai: 'WUR',
  mardu: 'WBR',
  sultai: 'UBG',
  temur: 'URG',
  white: 'W',
  blue: 'U',
  black: 'B',
  red: 'R',
  green: 'G',
  colorless: '',
}
const basics = new Map(
  ['plains', 'island', 'swamp', 'mountain', 'forest'].flatMap((name, i) => [
    [name, 1 << i],
    ['snow-covered ' + name, 1 << i],
  ])
)
basics.set('wastes', 0)
const key = (name) =>
  String(name ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
export const statisticsFormat = (format) =>
  String(format || 'Unknown')
    .replace(/^(?:Constructed|Variant Magic) - /i, '')
    .trim()
let catalog

// The cards table carries front-face colors. Only printings whose second face
// could add another color need a public CardView lookup.
export function loadCatalogColors(db) {
  const result = new Map()
  const merge = (name, mask) => result.set(name, !result.has(name) || result.get(name) === mask ? mask : null)
  for (const row of db
    .prepare(
      `SELECT DISTINCT name,colors FROM cards
    WHERE NOT (double_faced OR modal_double_faced) OR identity=colors`
    )
    .iterate()) {
    merge(key(row.name), row.colors)
  }
  const dictionary = db.prepare("SELECT value FROM meta WHERE key='viewDictionary'").get()?.value
  for (const row of db
    .prepare(
      `SELECT c.name,c.colors,p.view FROM cards c LEFT JOIN printings p ON p.id=c.printing
    WHERE (c.double_faced OR c.modal_double_faced) AND c.identity<>c.colors`
    )
    .iterate()) {
    let mask = null
    let backName
    if (dictionary && row.view) {
      try {
        const view = JSON.parse(inflateRawSync(row.view, { dictionary, maxOutputLength: 1024 * 1024 }))
        const back = view.secondCardFace
        if (key(view.name) === key(row.name) && key(back?.name) && faceMask(view.color) === row.colors) {
          backName = key(back.name)
          const backMask = faceMask(back.color)
          if (backMask !== null) mask = row.colors | backMask
        }
      } catch {
        // An unreadable printing does not establish the reverse face's color.
      }
    }
    merge(key(row.name), mask)
    if (backName) merge(key(row.name) + ' // ' + backName, mask)
  }
  return result
}

function faceMask(color) {
  const names = ['white', 'blue', 'black', 'red', 'green']
  if (!color || !names.every((name) => typeof color[name] === 'boolean')) return null
  return names.reduce((mask, name, i) => (color[name] ? mask | (1 << i) : mask), 0)
}

function catalogMask(name) {
  if (!catalog) {
    const file = '/opt/xmage/cards-prebuilt/catalog.sqlite'
    if (existsSync(file)) {
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        catalog = loadCatalogColors(db)
      } finally {
        db.close()
      }
    } else catalog = new Map()
  }
  return catalog.get(name) ?? null
}

export function mainColors(cards, lookup = catalogMask) {
  if (!cards?.length) return null
  let mask = 0
  for (const card of cards) {
    const name = key(typeof card === 'string' ? card : (card?.cardName ?? card?.name))
    const faces = name.split(/\s+\/\/\s+/)
    let color = basics.get(name) ?? lookup(name)
    if (faces.length > 1) {
      const values = faces.map((face) => basics.get(face) ?? lookup(face))
      if (values.every((v) => Number.isInteger(v))) color = values.reduce((a, b) => a | b, 0)
    }
    if (!Number.isInteger(color) || color < 0 || color > 31) return null
    mask |= color
  }
  return letters.filter((_, i) => mask & (1 << i))
}

// MTGTop8 names that do not start with a guild, shard or mono color.
const namedPalettes = {
  'ur aggro': 'UR', 'uw control': 'WU', 'weenie white': 'W', 'devotion to green': 'G', 'green ramp': 'G',
  'the rock (golgari control)': 'BG', 'arclight phoenix': 'UR', 'red deck wins': 'R', '5c legends aggro': 'WUBRG',
  'niv-mizzet reborn': 'WUBRG', 'lotus field': 'G', 'greasefang parhelion': 'WB',
}

export function archetypeColors(archetype) {
  const named = namedPalettes[String(archetype || '').toLowerCase()]
  if (named) return letters.filter((color) => named.includes(color))
  const prefix = String(archetype || '')
    .toLowerCase()
    .match(/^(?:mono[- ](white|blue|black|red|green)|([a-z]+))\b/)
  const palette = prefix && palettes[prefix[1] || prefix[2]]
  return typeof palette === 'string' ? letters.filter((color) => palette.includes(color)) : null
}
export function normalizedDeckColors(colors) {
  if (colors && !Array.isArray(colors) && typeof colors === 'object') {
    const keys = ['white', 'blue', 'black', 'red', 'green']
    if (!keys.every((name) => typeof colors[name] === 'boolean')) return null
    const selected = letters.filter((_, i) => colors[keys[i]])
    // Older editors saved all false when card metadata had not loaded.
    return selected.length ? selected : null
  }
  if (!Array.isArray(colors) || !colors.every((c) => typeof c === 'string' && letters.includes(c.toUpperCase())))
    return null
  return letters.filter((c) => colors.some((v) => v.toUpperCase() === c))
}

export function resolveHistoricalDeck(
  { format, snapshot, registeredArchetypes = [], openingArchetypes = [], registeredSignature, declaredColors },
  lookup = catalogMask
) {
  const family = statisticsFormat(format)
  const signature = snapshot?.cards?.length
    ? deckListSignature(snapshot)
    : /^[a-f0-9]{64}$/.test(registeredSignature ?? '')
      ? registeredSignature
      : null
  const cards = signature && snapshot?.cards?.length ? snapshot.cards : []
  const allowed = new Set(archetypesFor(family))
  const claimed = (labels) => [
    ...new Set(labels.map((label) => canonicalArchetype(family, label)).filter((label) => label && label !== 'Other' && allowed.has(label))),
  ]
  const explicit = claimed(registeredArchetypes)
  const opening = claimed(openingArchetypes)
  const size = cards.reduce((total, c) => total + (c?.amount ?? c?.quantity ?? c?.count ?? 1), 0)
  let archetype = null
  if (explicit.length) archetype = explicit.length === 1 ? explicit[0] : null
  else if (opening.length) archetype = opening.length === 1 ? opening[0] : null
  else if (size >= (family === 'Limited' ? 40 : 60)) {
    const verified =
      publicListArchetype(family, signature) ??
      publicListArchetype(family, deckListSignature({ cards })) ??
      tournamentArchetype(family, cards)
    if (allowed.has(verified) && verified !== 'Other') archetype = verified
    else if (cards.every((c) => basicLandNames.includes(key(typeof c === 'string' ? c : (c.cardName ?? c.name)))))
      archetype = 'Basic Lands Practice'
    else if (isCreaturePracticeMain(cards)) archetype = 'Creature Practice'
  }
  const registered = normalizedDeckColors(declaredColors),
    main = registered === null ? mainColors(cards, lookup) : null,
    fallback = archetypeColors(archetype)
  return {
    format: family,
    signature,
    archetype,
    publicName: signature ? publicCompositionName(family, signature) : null,
    colors: registered ?? main ?? fallback,
  }
}
