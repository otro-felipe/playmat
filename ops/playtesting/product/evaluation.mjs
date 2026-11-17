import { normalize, ProductError } from './decks.mjs'

const confidenceLevels = new Set(['low', 'medium', 'high'])
const maxReviews = 40

function entries(cards) {
  return Object.entries(cards ?? {}).filter(([, card]) => card && typeof card.name === 'string')
}

function visibleCard(card) {
  if (card.faceDown || card.hideInfo) return { name: 'Face-down card' }
  return {
    name: card.displayName || card.name,
    types: card.cardTypes,
    manaCost: card.manaCostLeftStr,
    tapped: card.tapped,
    power: card.power,
    toughness: card.toughness,
    damage: card.damage,
    summoningSickness: card.summoningSickness,
  }
}

function visibleZone(cards) {
  const list = entries(cards)
  return { cards: list.slice(0, 24).map(([, card]) => visibleCard(card)), total: list.length }
}

function snapshot(event) {
  const { view, myHand } = event
  const hand = visibleZone(myHand)
  return {
    timeMs: event.t, turn: view.turn, phase: view.phase, step: view.step,
    activePlayer: view.activePlayerName, priorityPlayer: view.priorityPlayerName,
    hand: hand.cards, handCount: hand.total,
    stack: visibleZone(view.stack),
    players: (view.players ?? []).map(player => ({
      name: player.name, life: player.life, handCount: player.handCount, libraryCount: player.libraryCount,
      manaPool: player.manaPool,
      battlefield: visibleZone(player.battlefield), graveyard: visibleZone(player.graveyard),
    })),
  }
}

function observedAction(before, after, viewer) {
  if (normalize(before.view.priorityPlayerName) !== viewer) return null
  const ownBefore = before.view.players?.find(player => normalize(player.name) === viewer)
  const ownAfter = after.view.players?.find(player => normalize(player.name) === viewer)
  const remains = new Set(entries(after.myHand).map(([id]) => id))
  const moved = entries(before.myHand).filter(([id, card]) => !remains.has(id) && !card.faceDown && !card.hideInfo)
  if (moved.length !== 1) return null
  const [id] = moved[0]
  const ownMain = normalize(before.view.activePlayerName) === viewer
    && ['PRECOMBAT_MAIN', 'POSTCOMBAT_MAIN'].includes(before.view.step) && !entries(before.view.stack).length
  for (const [kind, previous, current] of [
    ['play_land', ownBefore?.battlefield, ownAfter?.battlefield],
    ['cast_spell', before.view.stack, after.view.stack],
  ]) {
    const newCard = entries(current).find(([key, next]) => !previous?.[key] && (key === id || next.cardId === id)
      && !next.faceDown && !next.hideInfo
      && (kind === 'play_land'
        ? ownMain && next.cardTypes?.includes('LAND')
        : ownBefore?.playerId && next.controllerId === ownBefore.playerId && next.paid === true
          && !next.isAbility && (!next.mageObjectType || next.mageObjectType === 'SPELL')))
    if (newCard) return { kind, card: visibleCard(newCard[1]).name }
  }
  return null
}

function loggedAction(before, followup, viewer) {
  const participants = (before.view.players ?? []).map(player => player.name)
  for (const { t, log } of followup) {
    if (log?.messageType !== 'GAME' || typeof log.message !== 'string') continue
    const message = log.message.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()
    const lower = message.toLowerCase()
    const actor = participants.find(name => lower.startsWith(normalize(name) + ' plays ') || lower.startsWith(normalize(name) + ' casts '))
    if (!actor) continue
    if (normalize(actor) !== viewer) return null
    const [, verb, description] = /^\s*(plays|casts)\s+(.+)$/i.exec(message.slice(actor.length)) ?? []
    if (!verb || (verb === 'casts' && !/ from hand$/i.test(description))) return null
    const text = description.toLowerCase()
    const card = entries(before.myHand).map(([, card]) => card)
      .filter(card => !card.faceDown && !card.hideInfo && (verb !== 'plays' || card.cardTypes?.includes('LAND')))
      .map(card => visibleCard(card).name)
      .filter(name => text === name.toLowerCase() || text.startsWith(name.toLowerCase() + ' '))
      .sort((a, b) => b.length - a.length)[0]
    return card ? { t, action: { kind: verb === 'plays' ? 'play_land' : 'cast_spell', card } } : null
  }
  return null
}

function finalFrames(events) {
  const frames = []
  for (const [index, event] of events.entries()) {
    if (event.kind === 'rollback') {
      while (frames.length && frames.at(-1).event.view.turn >= event.turn) frames.pop()
      continue
    }
    if (event.view && Number.isInteger(event.view.turn)) frames.push({ index, event })
  }
  return frames
}

export function evaluationPositions(events, viewer) {
  const frames = finalFrames(events)
  const positions = []
  for (let number = 1; number < frames.length; number += 1) {
    const { index, event: before } = frames[number - 1]
    const { index: following, event: after } = frames[number]
    if (before.view.turn !== after.view.turn) continue
    const followup = events.slice(index + 1, following)
    if (followup.some(event => event.kind === 'rollback')) continue
    const logged = loggedAction(before, followup, viewer)
    const action = logged?.action ?? observedAction(before, after, viewer)
    if (action) positions.push({
      index, action, actionTimeMs: logged?.t ?? after.t,
      evidence: logged ? 'engine_log' : 'frame_delta', before: snapshot(before),
    })
  }
  return positions
}

export function scoreEvaluation(positions, reviews) {
  if (!Array.isArray(reviews) || reviews.length > maxReviews) throw new ProductError(400, 'Provide up to 40 reviewed positions')
  const known = new Map(positions.map(position => [position.index, position]))
  const seen = new Set()
  const decisions = reviews.map(review => {
    const { index, played, best, confidence, alternative, reason } = review ?? {}
    if (!known.has(index) || seen.has(index) || !confidenceLevels.has(confidence)
      || !Number.isInteger(played) || !Number.isInteger(best) || played < 0 || best < played || best > 100
      || typeof reason !== 'string' || !reason.trim() || reason.length > 600
      || (alternative !== undefined && (typeof alternative !== 'string' || !alternative.trim() || alternative.length > 200))
      || (best > played && !alternative)) {
      throw new ProductError(400, 'Use a distinct replay position, a confidence, ordered scores and a reason')
    }
    seen.add(index)
    const { action, actionTimeMs, evidence, before } = known.get(index)
    return {
      index, turn: before.turn, timeMs: actionTimeMs, action, evidence, confidence, alternative, reason,
      loss: confidence === 'low' ? null : best - played,
    }
  })
  const scored = decisions.filter(decision => decision.loss !== null)
  const accuracy = scored.length
    ? Math.round(100 - scored.reduce((sum, decision) => sum + decision.loss, 0) / scored.length)
    : null
  return { method: 'llm_relative_quality_v1', accuracy, total: positions.length, reviewed: decisions.length, scored: scored.length, decisions }
}
