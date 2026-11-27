import { cardViewDictionary, catalogCardView, openPrebuiltCardCatalog } from './public-card-catalog.mjs'

// Verified compatibility forms for old engine wording. Legacy archives have no
// declaration ID, so the exact primary rule is the witness and never the output.
const compatibility = new Map([
  ['Formidable Speaker', [
    { kind:'triggered', rule:'When {this} enters, you may discard a card. If you do, search your library for a creature card, reveal it, put it into your hand, then shuffle.', subject:'this creature' },
    { kind:'activated', rule:'{1}, {T}: Untap another target permanent.' },
  ]],
  ['Emberheart Challenger', [
    { kind:'triggered', rule:'Prowess (Whenever you cast a noncreature spell, this creature gets +1/+1 until end of turn.)' },
    { kind:'triggered', rule:'Valiant — Whenever {this} becomes the target of a spell or ability you control for the first time each turn, exile the top card of your library. Until end of turn, you may play that card.' },
  ]],
])

function publicRule(value) {
  if (typeof value !== 'string' || value.length > 1800 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return undefined
  const text = value.replaceAll(/<\/?(?:b|em|i|strong)>/gi,'').replaceAll(/<br\s*\/?>/gi,' ')
    .replaceAll('&mdash;','—').replaceAll(/ +/g,' ').trim()
  return text && !/[<>]/u.test(text) ? text : undefined
}

function validSource(source) {
  return source?.kind === 'card' && typeof source.name === 'string' && source.name.length > 0 && source.name.length <= 200
    && !/[<>\u0000-\u001f\u007f-\u009f]/u.test(source.name)
    && typeof source.expansionSetCode === 'string' && /^[A-Z0-9]{1,8}$/i.test(source.expansionSetCode)
    && typeof source.cardNumber === 'string' && /^[A-Z0-9★-]{1,14}$/iu.test(source.cardNumber)
}

function samePrinting(face,source) {
  return face?.expansionSetCode === source.expansionSetCode && face?.cardNumber === source.cardNumber
}

export function createCatalogStackLookup(db) {
  const dictionary = cardViewDictionary(db)
  const exact = db.prepare(`SELECT p.name,p.view FROM exact e JOIN printings p ON p.id=e.printing
    WHERE e.set_code=? AND e.card_number=?`)
  const cache = new Map()
  return source => {
    if (!dictionary || !validSource(source)) return []
    const id = JSON.stringify([source.expansionSetCode,source.cardNumber,source.name])
    if (cache.has(id)) return cache.get(id)
    let rules = []
    try {
      const row = exact.get(source.expansionSetCode.toLowerCase(),source.cardNumber.toLowerCase())
      if (row) {
        const view = catalogCardView(row.view,dictionary)
        if (view?.name === row.name && samePrinting(view,source)) {
          const faces = [view,view.secondCardFace].filter(face => face?.name === source.name && samePrinting(face,source))
          if (faces.length === 1 && Array.isArray(faces[0].rules)) rules = faces[0].rules.map(publicRule).filter(Boolean)
        }
      }
    } catch {
      // An unreadable printing supplies no public declaration.
    }
    if (cache.size >= 512) cache.delete(cache.keys().next().value)
    cache.set(id,rules)
    return rules
  }
}

let readCatalog
function catalogRules(source) {
  if (readCatalog === undefined) {
    let db
    try {
      db = openPrebuiltCardCatalog()
      readCatalog = db ? createCatalogStackLookup(db) : null
    } catch {
      db?.close()
      readCatalog = null
    }
  }
  return readCatalog?.(source) ?? []
}

function publicRuleKind(rule) {
  const ability = rule.replace(/^[^():.!?]{1,60} — /u,'')
  if (/^(?:When(?:ever)?|At) /u.test(ability) || / \((?:When(?:ever)?|At) /u.test(ability)) return 'triggered'
  if (/(?:^|\()[^.!?():]{1,200}: \S/u.test(ability)) return 'activated'
  return undefined
}

export function legacyStackEffect(card, source, kind, lookup = catalogRules) {
  if (!validSource(source) || card.sourceCard?.name !== source.name || !['triggered','activated'].includes(kind)) return undefined
  const archivedSource = card.sourceCard
  if (['faceDown','hideInfo','cloaked','disguised','manifested','morphed'].some(flag => Object.hasOwn(archivedSource,flag) && archivedSource[flag] !== false)
      || ['HAND','LIBRARY','SIDEBOARD'].includes(archivedSource.zone)) return undefined
  const observed = Array.isArray(card.rules) ? publicRule(card.rules[0]) : undefined
  if (observed === undefined) return undefined
  const catalogMatches = lookup(source).filter(rule => publicRuleKind(rule) === kind && (
    observed === rule || observed === rule.replaceAll('{this}',source.name)
  ))
  if (catalogMatches.length > 1) return undefined
  const matches = (compatibility.get(source.name) ?? []).filter(({ kind: type, rule, subject }) => type === kind && (
    observed === rule || observed === rule.replaceAll('{this}',source.name)
    || (subject !== undefined && observed === rule.replaceAll('{this}',subject))
  ))
  if (matches.length > 1) return undefined
  const { rule, subject } = matches[0] ?? { rule:catalogMatches[0] }
  return rule?.replaceAll('{this}',subject ?? source.name)
}
