// Only the public projection supplies names. Never forward event labels, private zones or pilot comments.
export function tournamentBoardFacts(raw, board, roster) {
  const names = new Map(roster.filter(p => p.playerId && p.name).map(p => [p.playerId, p.displayName || p.name]))
  const remember = zone => {
    for (const card of Object.values(zone ?? {})) {
      if (card?.id && card.name && !card.faceDown) names.set(card.id, card.name)
    }
  }
  for (const p of board.players) {
    for (const zone of [p.battlefield,p.exile,p.graveyard]) remember(zone)
  }
  for (const zone of board.exiles) remember(zone)
  remember(board.stack)
  for (const group of board.combat) {
    remember(group.attackers)
    remember(group.blockers)
  }
  const facts = []
  for (const [id, spell] of Object.entries(raw.stack ?? {})) {
    const visible = board.stack[spell?.id ?? id]
    if (!visible?.name || visible.faceDown) continue
    const source = visible.isAbility ? names.get(spell.sourceCard?.id) : visible.name
    if (!source || !Array.isArray(spell.chosenTargetIds)) continue
    for (const id of new Set(spell.chosenTargetIds)) {
      if (names.has(id)) facts.push({kind:'target',source,target:names.get(id),...(visible.isAbility && {ability:true})})
    }
  }
  for (const p of Array.isArray(raw.players) ? raw.players : []) {
    for (const card of Object.values(p?.battlefield ?? {})) {
      if (card && names.has(card.id) && names.has(card.attachedTo)) {
        facts.push({kind:'attached',source:names.get(card.id),target:names.get(card.attachedTo)})
      }
    }
  }
  for (const group of board.combat) {
    for (const attacker of Object.values(group.attackers)) {
      if (attacker.name && !attacker.faceDown && names.has(group.defenderId)) {
        facts.push({kind:'attacker',source:attacker.name,target:names.get(group.defenderId),
          ...(attacker.power && {power:attacker.power})})
      }
    }
  }
  const seen = new Set()
  for (const e of Array.isArray(raw.events) ? raw.events : []) {
    const target = names.get(e?.targetId)
    if (!target || !Number.isSafeInteger(e.seq) || e.seq <= 0 || seen.has(e.seq)) continue
    seen.add(e.seq)
    if (e.kind === 'DAMAGE' && Number.isSafeInteger(e.amount) && e.amount > 0 && names.has(e.sourceId)) {
      facts.push({kind:'damage',source:names.get(e.sourceId),target,amount:e.amount})
    } else if (e.kind === 'ZONE' && e.fromZone === 'BATTLEFIELD' && e.toZone === 'EXILED') {
      facts.push({kind:'exiled',target})
    }
  }
  return facts
}
