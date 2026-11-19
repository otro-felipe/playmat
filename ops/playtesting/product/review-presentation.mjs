import { isUuid } from './decks.mjs'

const stackActions = new Set(['cast', 'activate'])
const cardActions = new Set(['cast', 'land', 'activate', 'discard'])
const choicePattern = /\s+(?:targeting|choosing)\s+/i
const objectTag = /<font\b([^>]*)>([^<>]*)<\/font>/gi
const objectIdAttribute = /\bobject_id\s*=\s*['"]([^'"]+)['"]/i
const shortId = /\s+\[([0-9a-f]{3})\]/i
const targetedDiscardChoosers = new Set(['Thoughtseize', 'Duress', 'Inquisition of Kozilek', 'Thought Erasure', 'Despise', 'Dread Fugue'])

function cardRef(id, card) {
  const shown = card?.sourceCard ?? card
  const name = shown?.name
  if (typeof name !== 'string' || !name || card.faceDown || card.hideInfo || shown.faceDown || shown.hideInfo) return null
  return { id, name,
    ...(shown.expansionSetCode ? { setCode: shown.expansionSetCode } : {}),
    ...(shown.cardNumber ? { cardNumber: shown.cardNumber } : {}),
  }
}

function visibleCards(view) {
  const cards = new Map()
  const groups = [view?.stack, ...(view?.exiles ?? []), ...(view?.revealed ?? []).map(group => group.cards)]
  for (const player of view?.players ?? []) groups.push(player.battlefield, player.graveyard, player.exile)
  for (const group of groups) {
    for (const [id, card] of Object.entries(group ?? {})) {
      if (!isUuid(id)) continue
      const ref = cardRef(id, card)
      if (ref) cards.set(id, ref)
    }
  }
  return cards
}

export function publicSourceCard(view, id) {
  if (!isUuid(id)) return undefined
  const exact = visibleCards(view).get(id)
  if (exact) return exact
  const stackEntry = Object.values(view?.stack ?? {}).find(item => item.cardId === id || item.sourceCard?.id === id)
  return stackEntry ? cardRef(id, stackEntry) : undefined
}

function linkedCards(text) {
  return [...text.matchAll(objectTag)].flatMap(([, attributes, name]) => {
    const id = objectIdAttribute.exec(attributes)?.[1]
    return isUuid(id) && name ? [{ id, name: name.replace(/&amp;/g, '&') }] : []
  })
}

function matchVisibleCard(ref, cards) {
  if (!ref) return undefined
  if (ref.id) return cards.get(ref.id)
  const candidates = [...cards.values()].filter(card => card.name === ref.name
    && (!ref.shortId || card.id.startsWith(ref.shortId.toLowerCase())))
  return candidates.length === 1 ? candidates[0] : undefined
}

function legacySource(kind, headline, cards) {
  if (!cardActions.has(kind)) return null
  const links = linkedCards(headline)
  if (links.length) {
    const ref = kind === 'activate' ? links.at(-1) : links[0]
    return { ...cards.get(ref.id), ...ref }
  }
  if (kind !== 'cast' && kind !== 'land') return null
  const body = headline.replace(/^\S+\s+/, '').replace(/^a copied\s+/i, '')
  const marker = shortId.exec(body)
  if (!marker) return null
  const ref = { name: body.slice(0, marker.index).trim(), shortId: marker[1] }
  return matchVisibleCard(ref, cards) ?? ref
}

export function publicDiscardLinks(message) {
  const [discard, source] = (message ?? '').split(/\(source:\s*/i, 2)
  return { card: linkedCards(discard)[0], source: source ? linkedCards(source)[0] : undefined }
}

function loggedTargets(choice, cards, players) {
  const links = linkedCards(choice)
  const plain = choice.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/\s+from [\w -]+$/i, '')
  const subjects = links.map(ref => ({ ...cards.get(ref.id), ...ref, kind: 'card' }))
  let start = 0
  for (const marker of plain.matchAll(/\s+\[([0-9a-f]{3})\]/gi)) {
    let name = plain.slice(start, marker.index).replace(/^\s*(?:\([^)]*\))?\s*,?\s*/, '')
    start = marker.index + marker[0].length
    // Match an exact visible card if possible. Keep a logged name displayable
    // even when the old archive has no snapshot of that object.
    const player = players.find(({ name: candidate }) => name.startsWith(candidate + ', '))
    if (player) name = name.slice(player.name.length + 2)
    if (!name || subjects.some(ref => ref.name === name && ref.id?.startsWith(marker[1]))) continue
    const visible = matchVisibleCard({ name, shortId: marker[1] }, cards)
    subjects.push({ ...(visible ?? { name }), kind: 'card' })
  }
  const playerNames = plain.split(/,\s*/).map(part => part.replace(/\s+\(.*\)$/, '').trim())
  for (const player of players) if (playerNames.includes(player.name)) subjects.push(player)
  return subjects
}

function witnessedStackObject(view, actual, ref) {
  const ids = [actual.objectId, actual.sourceId, ref?.id].filter(Boolean)
  const entries = Object.entries(view?.stack ?? {})
  const found = entries.find(([id, item]) => ids.includes(id) || ids.includes(item.cardId) || ids.includes(item.sourceCard?.id))
  if (found) return found
  // A legacy action can identify a card by its printed name and short log ID.
  if (!ref?.shortId) return undefined
  const matches = entries.filter(([id, item]) => [id, item.cardId].some(value => value?.startsWith(ref.shortId))
    && cardRef(id, item)?.name === ref.name)
  return matches.length === 1 ? matches[0] : undefined
}

function loggedCastMode(headline) {
  const plain = headline.replace(/<[^>]*>/g, '')
  const marker = shortId.exec(plain)
  if (!marker) return null
  const options = plain.slice(marker.index + marker[0].length).trim()
  return /^(?:with|using)\s+(.+?)(?=\s+\(mode \d+\)|\s+from\s|$)/i.exec(options)?.[1]?.slice(0, 240)
}

function loggedActivation(headline, cards) {
  const activation = /^activates:\s+(.+)\s+from\s+(.+)$/i.exec(headline)
  if (!activation) return {}
  const [, effect, source] = activation
  return {
    card: legacySource('cast', `casts ${source}`, cards),
    description: effect.replace(/<[^>]*>/g, '').replace(/\s+\[[0-9a-f]{3}\]/gi, '').replace(/&amp;/g, '&').trim().slice(0, 400),
  }
}

function isWitnessed(before, after, actual, ref) {
  if (!after || before?.view?.turn !== after.view.turn) return false
  if (stackActions.has(actual.kind)) {
    const item = witnessedStackObject(after.view, actual, ref)
    return !!item && !Object.hasOwn(before?.view?.stack ?? {}, item[0])
  }
  if (actual.kind === 'land') {
    return (after.view.players ?? []).some(player => {
      const found = matchVisibleCard(ref, visibleCards({ players: [{ battlefield: player.battlefield }] }))
      return !!found && !(before?.view?.players ?? []).some(old => Object.hasOwn(old.battlefield ?? {}, found.id))
    })
  }
  return false
}

function decideAction(position, actor, before, after, row) {
  const { actual } = position
  const preceding = visibleCards(before?.view)
  const following = after ? visibleCards(after.event.view) : new Map()
  const players = (before?.view?.players ?? []).filter(player => isUuid(player.playerId) && typeof player.name === 'string')
    .map(player => ({ id: player.playerId, name: player.name, kind: 'player' }))
  const playerNames = new Map(players.map(player => [player.id, player]))
  const log = row?.log?.message ?? position.logMessage ?? ''
  const actorTag = /^\s*<font\b[^>]*>[^<]*<\/font>\s+/i.exec(log)
  const rest = log.slice(actorTag?.[0].length ?? (actor?.name.length ?? 0)).trimStart()
  const choiceIndex = rest.search(choicePattern)
  const headline = choiceIndex === -1 ? rest : rest.slice(0, choiceIndex)
  const choice = actual.kind === 'select' ? rest.replace(/^chooses?\s+/i, '')
    : choiceIndex === -1 ? '' : rest.slice(choiceIndex).replace(choicePattern, '')
  const activation = actual.kind === 'activate' ? loggedActivation(headline, preceding) : null
  const legacy = activation?.card ?? legacySource(actual.kind, headline, preceding)
  const typed = position.cardRef ?? preceding.get(actual.sourceId) ?? preceding.get(actual.objectId)
  const ref = typed ?? legacy
  const witnessed = isWitnessed(before, after?.event, actual, ref)
  const stackObject = witnessed && stackActions.has(actual.kind) ? witnessedStackObject(after.event.view, actual, ref) : null
  const afterRef = stackObject ? cardRef(stackObject[0], stackObject[1]) : witnessed ? matchVisibleCard(ref, following) : undefined
  const card = typed ?? (legacy && { ...afterRef, ...legacy })
  const namedTargets = loggedTargets(choice, preceding, players)
  const byTarget = new Map(namedTargets.filter(target => target.id).map(target => [target.id, target]))
  const targetIds = actual.targetIds?.length ? actual.targetIds : stackObject?.[1]?.targets
  const targets = targetIds?.length ? [...new Set(targetIds)].flatMap(id => {
    const publicCard = preceding.get(id) ?? (witnessed ? following.get(id) : null)
    const reference = playerNames.get(id) ?? (publicCard ? { ...publicCard, kind: 'card' } : byTarget.get(id))
    return reference ? [reference] : []
  }) : namedTargets
  const zone = actual.kind === 'cast' ? rest.match(/\sfrom\s+(hand|graveyard|exile|command zone|library)\s*$/i)?.[1] : undefined
  const castMode = actual.kind === 'cast' ? position.castMode || loggedCastMode(headline) : undefined
  const castOptionNumber = actual.kind === 'cast' ? headline.match(/\(mode (\d+)\)/i)?.[1] : undefined
  const loggedMode = castOptionNumber ? `Mode ${castOptionNumber}` : activation?.description
  const discardSource = actual.kind === 'discard' ? rest.split(/\(source:\s*/i)[1] : undefined
  const sourceLink = discardSource && legacySource('cast', `casts ${discardSource}`, preceding)
  const { shortId: _shortId, ...cardReference } = card ?? {}
  const { shortId: _sourceShortId, ...sourceReference } = sourceLink || {}
  const stackEntry = targetedDiscardChoosers.has(sourceReference.name)
    ? witnessedStackObject(before?.view, { kind: 'cast' }, sourceLink)?.[1] : undefined
  const decisionPlayerId = row?.decisionPlayerId ?? stackEntry?.controllerId
  return {
    ...(actor ? { actor: actor.name, actorPlayerId: actor.playerId } : {}),
    ...(decisionPlayerId ? { decisionActorPlayerId: decisionPlayerId } : {}),
    ...(witnessed ? { actionFrameCursor: after.cursor } : {}),
    actual: { ...actual,
      ...(cardReference.name ? { cardRef: cardReference } : {}),
      ...(sourceReference.name ? { sourceCardRef: sourceReference } : {}),
      ...(targets.length ? { targets } : {}),
      ...(castMode ? { castMode } : {}),
      ...(!actual.modes?.length && loggedMode ? { modes: [loggedMode] } : {}),
      ...(!actual.fromZone && zone ? { fromZone: zone.toUpperCase().replaceAll(' ', '_') } : {}),
    },
  }
}

/** The next observed frame is eligible only before another candidate action. */
export function indexReplayPresentation(rows, positions, perspectives, capture) {
  const frames = new Map()
  const actionRows = new Map(positions.map(position => [position.cursor, position]))
  const nearest = new Map()
  const actors = new Map(perspectives.map(actor => [actor.seatId, actor]))
  const byPlayer = new Map(perspectives.filter(actor => actor.playerId).map(actor => [actor.playerId, actor]))
  let next = null
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]
    if (row.event.view) {
      next = row
      frames.set(row.cursor, row.event)
    }
    if (actionRows.has(row.cursor)) {
      nearest.set(row.cursor, { after: next, event: row.event })
      next = null
    }
  }
  const exactCasters = new Map()
  const inferredChoosers = new Map()
  for (const position of positions) {
    const event = nearest.get(position.cursor).event
    const message = event.log?.message ?? capture.get(position.cursor)?.logMessage
    if (position.actual.kind === 'cast') {
      const source = linkedCards(message ?? '')[0]
      const id = source?.id ?? position.actual.sourceId
      if (id) exactCasters.set(id, position)
    } else if (position.actual.kind === 'discard' && position.evidence.basis === 'engine_log') {
      const { source } = publicDiscardLinks(message)
      const cast = source && targetedDiscardChoosers.has(source.name) ? exactCasters.get(source.id) : undefined
      if (cast && cast.evidence.turn === position.evidence.turn && position.cursor - cast.cursor <= 64) {
        inferredChoosers.set(position.cursor, actors.get(cast.seatId)?.playerId)
      }
    }
  }
  return position => {
    const { after, event } = nearest.get(position.cursor)
    const displayed = decideAction({ ...position, ...capture.get(position.cursor) }, actors.get(position.seatId),
      frames.get(position.frameCursor), after, event)
    const chooser = byPlayer.get(displayed.decisionActorPlayerId ?? inferredChoosers.get(position.cursor))
    if (!chooser) {
      delete displayed.decisionActorPlayerId
      return displayed
    }
    const affected = byPlayer.get(event.affectedPlayerId)
    return { ...displayed, decisionActorPlayerId: chooser.playerId, decisionSeatId: chooser.seatId, decisionActor: chooser.name,
      ...(affected ? { affectedPlayerId: affected.playerId, affectedActor: affected.name } : {}) }
  }
}
