export function plainReplayText(value) {
  return typeof value === 'string'
    ? value
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .trim()
    : ''
}

export function canonicalRows(raw) {
  const rows = []
  let turn = null
  let frameCursor = null
  for (const [cursor, event] of raw.entries()) {
    if (event.kind === 'rollback' && Number.isSafeInteger(event.turn)) {
      while (rows.length && rows.at(-1).turn >= event.turn) rows.pop()
      turn = event.turn
      frameCursor = rows.at(-1)?.frameCursor ?? null
    }
    if (event.view && Number.isSafeInteger(event.view.turn)) {
      turn = event.view.turn
      frameCursor = cursor
    }
    rows.push({ cursor, frameCursor, turn: Number.isSafeInteger(event.turn) ? event.turn : turn, event })
  }
  return rows
}

export function legacyKeptHand(rows, index, actor, getHand) {
  for (const { event } of rows.slice(index + 1, index + 65)) {
    if (event.view?.turn >= 1) {
      if (event.view.turn !== 1 || !['UNTAP', 'UPKEEP'].includes(event.view.step)) return undefined
      return getHand(event)
    }
    if (event.kind === 'draw' && event.actorPlayerId === actor.playerId) return undefined
    if (event.kind === 'action' && !['mulligan', 'keep'].includes(event.action)) return undefined
    if (event.log?.messageType === 'GAME') {
      const message = plainReplayText(event.log.message)
      const sameActor = message.toLowerCase().startsWith(actor.name.toLowerCase() + ' ')
      if (sameActor && /^\s*(?:draws|discards|casts|plays|activates|puts)\b/i.test(message.slice(actor.name.length)))
        return undefined
    }
  }
}
