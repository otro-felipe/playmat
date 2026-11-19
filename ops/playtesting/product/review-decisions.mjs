import { isUuid } from './decks.mjs'

export const genericChoiceKinds = new Set(['target', 'cards', 'search', 'mode', 'choice', 'use', 'amount', 'pile', 'ability', 'replacement'])

function opaqueId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,96}$/.test(value)
}

export function structuredChoice(row, plainText, cardReference) {
  const { event, cursor } = row
  const { choiceKind, optionDetails, selectedOptionIds, selectedText, declined, optionCount } = event.decision
  if (!genericChoiceKinds.has(choiceKind)) return {}
  return {
    id: opaqueId(event.decisionId) ? event.decisionId : `decision-${cursor}`,
    choiceKind,
    ...(isUuid(event.sourceId) ? { sourceId: event.sourceId } : {}),
    ...(isUuid(event.affectedPlayerId) ? { affectedPlayerId: event.affectedPlayerId } : {}),
    ...(isUuid(event.decisionPlayerId) ? { chooserPlayerId: event.decisionPlayerId } : {}),
    ...(Array.isArray(optionDetails) ? { optionDetails: optionDetails.slice(0, 64).flatMap(option => {
      if (!opaqueId(option?.id)) return []
      const card = cardReference(option.card)
      return [{ id: option.id, ...(typeof option.label === 'string' ? { label: plainText(option.label).slice(0, 240) } : {}),
        ...(card ? { card } : {}), ...(isUuid(option.playerId) ? { playerId: option.playerId } : {}) }]
    }) } : {}),
    ...(Array.isArray(selectedOptionIds) ? { selectedOptionIds: selectedOptionIds.filter(opaqueId).slice(0, 64) } : {}),
    ...(typeof selectedText === 'string' ? { selectedText: plainText(selectedText).slice(0, 400) } : {}),
    ...(typeof declined === 'boolean' ? { declined } : {}),
    ...(Number.isSafeInteger(optionCount) && optionCount >= 0 ? { optionCount } : {}),
  }
}

/** An announcement prompt belongs to its witnessed cast or activation. */
export function indexCommittedDecisions(rows, typed) {
  const nested = new Set()
  const byParent = new Map()
  if (!typed) return { nested, byParent }
  const committed = new Map()
  for (const row of rows) {
    const { event } = row
    if (event.kind === 'action' && ['cast', 'activate'].includes(event.action) && isUuid(event.objectId)) {
      committed.set(event.objectId, committed.has(event.objectId) ? null : row)
    }
  }
  for (const row of rows) {
    const { event, cursor } = row
    if (event.kind !== 'action' || event.action !== 'select' || !isUuid(event.parentActionId)) continue
    nested.add(cursor)
    const parent = committed.get(event.parentActionId)
    if (!parent || cursor >= parent.cursor || row.turn !== parent.turn
      || ![event.actorPlayerId, event.decisionPlayerId].includes(parent.event.actorPlayerId)) continue
    const children = byParent.get(parent.cursor) ?? []
    children.push(row)
    byParent.set(parent.cursor, children)
  }
  return { nested, byParent }
}
