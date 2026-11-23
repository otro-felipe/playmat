import { publicLineExplanations } from './line-explanations.mjs'
import { createHmac, randomBytes } from 'node:crypto'
import { isUuid } from './decks.mjs'

const maskKey = randomBytes(32)
const phases = new Set(['BEGINNING','PRECOMBAT_MAIN','COMBAT','POSTCOMBAT_MAIN','END'])
const steps = new Set(['UNTAP','UPKEEP','DRAW','PRECOMBAT_MAIN','BEGIN_COMBAT','DECLARE_ATTACKERS','DECLARE_BLOCKERS',
  'FIRST_COMBAT_DAMAGE','COMBAT_DAMAGE','END_COMBAT','POSTCOMBAT_MAIN','END_TURN','CLEANUP'])
const cardTypes = new Set(['ARTIFACT','BATTLE','CONSPIRACY','CREATURE','DUNGEON','ENCHANTMENT','INSTANT','LAND',
  'PHENOMENON','PLANE','PLANESWALKER','SCHEME','SORCERY','KINDRED','VANGUARD'])
const concealedFlags = ['faceDown','hideInfo','cloaked','disguised','manifested','morphed']
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
    if (concealedFlags.some(flag => Object.hasOwn(c,flag) && c[flag] !== false) || privateZones.has(c.zone)) concealed.add(c)
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

function publicView(view, roster, gameId) {
  if (!record(view)) return null
  const objects = publicObjects(view)
  const {concealed,markedIds} = concealedObjects(objects)
  const publicIds = new Set(objects.flatMap(([key,c]) => [key,c.id]).filter(isUuid))
  function opaque(key) {
    return 'object-' + createHmac('sha256',maskKey).update(JSON.stringify([gameId,key ?? null])).digest('hex').slice(0,24)
  }
  function card(key,c) {
    if (!record(c) || privateZones.has(c.zone)) return null
    if (concealed.has(c)) return {id:opaque(label(c.id) ? c.id : key),faceDown:true,...bools(c,['tapped','phasedIn']),...counters(c)}
    const id = isUuid(c.id) ? c.id : isUuid(key) ? key : opaque(key)
    const state = {id,...bools(c,['tapped','phasedIn','summoningSickness','isToken']),...numbers(c,['damage']),...counters(c),
      ...pick(c,['ownerId','controllerId'],v => roster.has(v))}
    if (c.isAbility === true || record(c.sourceCard) || ['ABILITY_STACK_FROM_CARD','ABILITY_STACK_FROM_TOKEN'].includes(c.mageObjectType)) {
      return {...state,isAbility:true,name:'Ability'}
    }
    return {...state,...pick(c,['name'],label),
      ...pick(c,['expansionSetCode'],v => typeof v==='string' && /^[A-Za-z0-9]{1,8}$/.test(v)),
      ...pick(c,['cardNumber'],v => typeof v==='string' && /^[A-Za-z0-9★-]{1,14}$/u.test(v)),
      ...pick(c,['power','toughness','loyalty','defense'],v => typeof v==='string' && /^[-+\d*/X]{1,8}$/.test(v)),
      ...(Array.isArray(c.cardTypes) && {cardTypes:c.cardTypes.filter(t => cardTypes.has(t))})}
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
  return {...numbers(view,['turn']),...pick(view,['phase'],v => phases.has(v)),...pick(view,['step'],v => steps.has(v)),
    ...pick(view,['activePlayerId'],v => roster.has(v)),
    ...pick(view,['activePlayerName','priorityPlayerName'],v => playerNames.has(v)),
    players:list(view.players).filter(record).map(boardPlayer),stack:zone(view.stack),exiles:list(view.exiles).map(zone),
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
  return {role:'spectator',visibility:'public-board',...pick(snapshot,['tableId'],isUuid),
    gameId,status:statuses.has(snapshot.status) ? snapshot.status : 'waiting',
    ...numbers(snapshot,['revision','spectators']),players,view:gameId ? publicView(snapshot.view,roster,gameId) : null,
    hands:{},lines:gameId ? publicLineExplanations(snapshot.lines,roster,gameId) : [],chat:[]}
}
