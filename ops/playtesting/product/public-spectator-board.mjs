import { publicLineExplanations } from './line-explanations.mjs'
import { tournamentBoardFacts } from './tournament-board-facts.mjs'
import { legacyStackEffect } from './legacy-stack-effect.mjs'
import { createHmac, randomBytes } from 'node:crypto'
import { isUuid } from './decks.mjs'

const maskKey = randomBytes(32)
const phases = new Set(['BEGINNING','PRECOMBAT_MAIN','COMBAT','POSTCOMBAT_MAIN','END'])
const steps = new Set(['UNTAP','UPKEEP','DRAW','PRECOMBAT_MAIN','BEGIN_COMBAT','DECLARE_ATTACKERS','DECLARE_BLOCKERS',
  'FIRST_COMBAT_DAMAGE','COMBAT_DAMAGE','END_COMBAT','POSTCOMBAT_MAIN','END_TURN','CLEANUP'])
const cardTypes = new Set(['ARTIFACT','BATTLE','CONSPIRACY','CREATURE','DUNGEON','ENCHANTMENT','INSTANT','LAND',
  'PHENOMENON','PLANE','PLANESWALKER','SCHEME','SORCERY','KINDRED','VANGUARD'])
const concealedFlags = ['faceDown','hideInfo','cloaked','disguised','manifested','morphed']
export const concealedCardFace = card => concealedFlags.some(flag => Object.hasOwn(card,flag) && card[flag] !== false)
const privateZones = new Set(['HAND','LIBRARY','SIDEBOARD'])
const counterNames = new Set(['+1/+1','-1/-1','poison','loyalty','defense','shield','energy','experience','rad','stun',
  'charge','time','lore','oil','finality','flying','first strike','double strike','deathtouch','haste','hexproof',
  'indestructible','lifelink','menace','reach','trample','vigilance'])
const counters = c => Array.isArray(c.counters) ? {counters:c.counters.filter(v => record(v) && Number.isSafeInteger(v.count))
  .map(v => ({name:counterNames.has(v.name) ? v.name : 'Counter',count:v.count}))} : {}
const statuses = new Set(['waiting','playing','between_games','finished'])
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const list = v => Array.isArray(v) ? v : []
const label = v => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(v)
const pick = (value, keys, valid) => Object.fromEntries(keys.filter(k => valid(value[k])).map(k => [k,value[k]]))
const bools = (value, keys) => pick(value,keys,v => typeof v === 'boolean')
const numbers = (value, keys) => pick(value,keys,Number.isSafeInteger)
const cardEntries = zone => record(zone) ? Object.entries(zone).filter(([,v]) => record(v)) : []
const stackKind = new Set(['triggered','activated'])
const sourceKind = new Set(['card','token','command'])
const effectText = value => typeof value === 'string' && value.length > 0 && value.length <= 1800 && !/[<>\u0000-\u001f\u007f]/u.test(value)
const stackTypes = new Set(['ABILITY_STACK_FROM_CARD','ABILITY_STACK_FROM_TOKEN'])
const abilityCard = card => card.isAbility === true || record(card.sourceCard) || record(card.stackAbility) || stackTypes.has(card.mageObjectType)
const printing = card => ({
  ...pick(card,['expansionSetCode'],v => typeof v==='string' && /^[A-Za-z0-9]{1,8}$/.test(v)),
  ...pick(card,['cardNumber'],v => typeof v==='string' && /^[A-Za-z0-9★-]{1,14}$/u.test(v)),
})

// Only traverse zones shared by both seats. Attached ability/card copies can repeat the same object
// with different visibility flags, including in combat and accumulated archive views.
function publicObjects(view) {
  const entries = []
  const add = zone => entries.push(...cardEntries(zone))
  for (const player of list(view.players).filter(record)) {
    for (const zone of [player.battlefield,player.exile,player.graveyard]) add(zone)
    for (const card of list(player.commandList).filter(record)) entries.push([card.id,card])
  }
  add(view.stack)
  for (const zone of list(view.exiles)) add(zone)
  for (const group of [...list(view.companion),...list(view.revealed)].filter(record)) add(group.cards)
  for (const group of list(view.combat).filter(record)) { add(group.attackers); add(group.blockers) }
  return entries
}

// Collect identifiers inside public card representations before emitting any of their mirrors. For
// example a combat copy can omit faceDown while a stack ability still marks its source as hidden.
function concealedObjects(objects) {
  const byId = new Map(), related = new Map(), visited = new Set(), concealed = new Set()
  const pending = [...objects]
  while (pending.length) {
    const [key,c] = pending.pop()
    for (const id of [key,c.id,c.cardId].filter(label)) {
      if (!byId.has(id)) byId.set(id,new Set())
      byId.get(id).add(c)
    }
    if (visited.has(c)) continue
    visited.add(c)
    if (concealedCardFace(c) || privateZones.has(c.zone)) concealed.add(c)
    for (const child of [c.original,c.sourceCard,c.ability,c.secondCardFace,...cardEntries(c.mutateView).map(([,part]) => part)]) {
      if (!record(child)) continue
      if (!related.has(child)) related.set(child,new Set())
      if (!related.has(c)) related.set(c,new Set())
      related.get(child).add(c)
      related.get(c).add(child)
      pending.push([child.id,child])
    }
  }
  // Expand to matching object IDs and to ability wrappers, never to every card in the zone.
  const aliases = new Map()
  for (const [id,cards] of byId) for (const c of cards) {
    if (!aliases.has(c)) aliases.set(c,[])
    aliases.get(c).push(id)
  }
  const markedIds = new Set()
  for (const c of concealed) {
    for (const copy of related.get(c) ?? []) concealed.add(copy)
    for (const id of aliases.get(c) ?? []) {
      if (markedIds.has(id)) continue
      markedIds.add(id)
      for (const mirror of byId.get(id)) concealed.add(mirror)
    }
  }
  return {concealed,markedIds}
}

function publicExilePresentation(entries, players, roster) {
  const visibleIds = zone => Object.values(zone).filter(card => !card.faceDown && isUuid(card.id)).map(card => card.id)
  const exiled = new Set(players.flatMap(player => visibleIds(player.exile)))
  const sources = new Set(players.flatMap(player => visibleIds(player.battlefield)))
  const projected = list(entries).filter(entry => record(entry) && exiled.has(entry.cardId)).flatMap(entry => {
    const sourceId = sources.has(entry.sourceId) ? entry.sourceId : null
    const playableBy = [...new Set(list(entry.playableBy).filter(playerId => roster.has(playerId)))]
    return sourceId || playableBy.length ? [{cardId:entry.cardId, ...(sourceId && {sourceId}), ...(playableBy.length > 0 && {playableBy})}] : []
  })
  return projected.length ? {exilePresentation:projected} : {}
}

function publicView(view, roster, gameId) {
  if (!record(view)) return null
  const objects = publicObjects(view)
  const {concealed,markedIds} = concealedObjects(objects)
  const publicIds = new Set(objects.flatMap(([key,c]) => [key,c.id]).filter(isUuid))
  const publicSources = new Map(objects.filter(([key,c]) => !concealed.has(c) && !abilityCard(c) && isUuid(key) && key === c.id && label(c.name)))
  const stackIds = new Set(cardEntries(view.stack).filter(([key,c]) => key === c.id && isUuid(key) && !concealed.has(c)).map(([key]) => key))
  function currentSource(card) {
    return {id:card.id,name:card.name,kind:card.isToken === true ? 'token' : 'card',...printing(card)}
  }
  function publicAbility(card) {
    const captured = record(card.stackAbility) ? card.stackAbility : null
    const declared = captured?.source
    const legacyType = card.abilityType === 'TRIGGERED_NONMANA' ? 'triggered'
      : card.abilityType === 'ACTIVATED_NONMANA' ? 'activated' : undefined
    const kind = stackKind.has(captured?.kind) ? captured.kind : legacyType
    const sourceId = declared?.id
    // A legacy nested source can suggest an ID but cannot attest to its visibility or supply any text.
    const corroborated = publicSources.get(captured ? sourceId : card.sourceCard?.id)
    if (markedIds.has(sourceId) || concealed.has(card.sourceCard)
        || (record(declared) && (concealedCardFace(declared) || privateZones.has(declared.zone)))) return kind ? {kind} : undefined
    const capturedSource = record(declared) && label(declared.name) && sourceKind.has(declared.kind)
      && (sourceId === undefined || isUuid(sourceId))
    const source = capturedSource ? {name:declared.name,kind:declared.kind,...printing(declared),
      ...(corroborated?.name === declared.name ? {id:sourceId,...printing(corroborated)} : {})}
      : !captured && corroborated ? currentSource(corroborated) : undefined
    const effect = captured ? (capturedSource && effectText(captured.effect) ? captured.effect : undefined)
      : legacyStackEffect(card, source, legacyType)
    return kind || source ? {...(kind && {kind}),...(source && {source}),...(effect && {effect})} : undefined
  }
  function chosenTargets(key, c) {
    if (!stackIds.has(key) || view.stack[key] !== c) return {}
    const targets = [...new Set(list(c.chosenTargetIds))].filter(id => id !== c.id && (
      publicSources.has(id) || stackIds.has(id) || roster.has(id)
    ))
    return targets.length ? {targets} : {}
  }
  function opaque(key) {
    return 'object-' + createHmac('sha256',maskKey).update(JSON.stringify([gameId,key ?? null])).digest('hex').slice(0,24)
  }
  function card(key,c) {
    if (!record(c) || privateZones.has(c.zone)) return null
    if (concealed.has(c)) return {id:opaque(label(c.id) ? c.id : key),faceDown:true,...bools(c,['tapped','phasedIn']),...counters(c)}
    const id = isUuid(c.id) ? c.id : isUuid(key) ? key : opaque(key)
    const state = {id,...bools(c,['tapped','phasedIn','summoningSickness','isToken']),...numbers(c,['damage']),...counters(c),
      ...pick(c,['ownerId','controllerId'],v => roster.has(v))}
    if (abilityCard(c)) {
      const stackAbility = publicAbility(c)
      return {...state,isAbility:true,name:'Ability',...(stackAbility && {stackAbility}),...(stackAbility?.source && chosenTargets(key,c))}
    }
    return {...state,...pick(c,['name'],label),...printing(c),
      ...pick(c,['power','toughness','loyalty','defense'],v => typeof v==='string' && /^[-+\d*/X]{1,8}$/.test(v)),
      ...(Array.isArray(c.cardTypes) && {cardTypes:c.cardTypes.filter(t => cardTypes.has(t))}),...chosenTargets(key,c)}
  }
  function zone(input) {
    return Object.fromEntries(cardEntries(input).map(([key,c]) => card(key,c)).filter(Boolean).map(c => [c.id,c]))
  }
  const playerNames = new Set([...roster.values()].map(p => p.name).filter(Boolean))
  const boardPlayer = p => ({
    ...pick(p,['playerId'],v => roster.has(v)),...pick(p,['name'],v => playerNames.has(v)),
    ...counters(p),...numbers(p,['handCount','libraryCount','life','wins','winsNeeded']),
    ...bools(p,['hasLeft','hasPriority','isActive','isHuman','initiative','monarch']),
    battlefield:zone(p.battlefield),graveyard:zone(p.graveyard),exile:zone(p.exile),
    commandList:list(p.commandList).filter(record).map(c => card(c.id,c)).filter(Boolean),
  })
  const revealed = groups => list(groups).filter(record).map(group => ({cards:zone(group.cards)}))
  const players = list(view.players).filter(record).map(boardPlayer)
  return {...numbers(view,['turn']),...pick(view,['phase'],v => phases.has(v)),...pick(view,['step'],v => steps.has(v)),
    ...pick(view,['activePlayerId'],v => roster.has(v)),
    ...pick(view,['activePlayerName','priorityPlayerName'],v => playerNames.has(v)),
    players,stack:zone(view.stack),exiles:list(view.exiles).map(zone),...publicExilePresentation(view.exilePresentation,players,roster),
    companion:revealed(view.companion),revealed:revealed(view.revealed),
    combat:list(view.combat).filter(record).map(g => ({
      attackers:zone(g.attackers),blockers:zone(g.blockers),...bools(g,['isBlocked']),
      ...((roster.has(g.defenderId) || publicIds.has(g.defenderId)) && {defenderId:markedIds.has(g.defenderId) ? opaque(g.defenderId) : g.defenderId}),
    }))}
}

export function publicSpectatorBoard(snapshot) {
  const players = list(snapshot.players).filter(record).map(p => ({
    ...pick(p,['playerId'],isUuid),...pick(p,['name','displayName'],label),
    ...pick(p,['control'],v => v==='mcp'),...pick(p,['flag'],v => typeof v==='string' && /^[A-Za-z]{2}$/.test(v)),
  }))
  const gameId = isUuid(snapshot.gameId) ? snapshot.gameId : null
  const roster = new Map(players.filter(p => p.playerId).map(p => [p.playerId,p]))
  const view = gameId ? publicView(snapshot.view,roster,gameId) : null
  const facts = view ? tournamentBoardFacts(snapshot.view,view,players) : []
  return {role:'spectator',visibility:'public-board',...pick(snapshot,['tableId'],isUuid),
    gameId,status:statuses.has(snapshot.status) ? snapshot.status : 'waiting',
    ...numbers(snapshot,['revision','spectators']),...(facts.length ? {facts} : {}),
    ...pick(snapshot,['rollbackRevision'],n=>Number.isSafeInteger(n) && n>=0),players,view,
    hands:{},lines:gameId ? publicLineExplanations(snapshot.lines,roster,gameId) : [],chat:[]}
}
