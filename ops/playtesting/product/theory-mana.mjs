export const manaColors = 'WUBRGC'

export function validManaCost(cost) {
  return Number.isInteger(cost?.generic) && cost.generic >= 0 && cost.generic <= 20
    && Array.isArray(cost.pips) && cost.pips.length <= 16
    && cost.pips.every(pip => typeof pip === 'string' && pip.length === 1 && manaColors.includes(pip))
}

/** Match every required symbol to a distinct available one-mana source. */
export function assignMana(sources, cost) {
  const usable = sources.flatMap((source, index) => source.tapped ? [] : [index])
  if (usable.length < cost.pips.length + cost.generic) return null
  const assigned = new Map()
  function match(slot, visited) {
    for (const index of usable) {
      if (visited.has(index) || !sources[index].colors.includes(cost.pips[slot])) continue
      visited.add(index)
      const previous = assigned.get(index)
      if (previous === undefined || match(previous, visited)) {
        assigned.set(index, slot)
        return true
      }
    }
    return false
  }
  for (const slot of cost.pips.keys()) {
    if (!match(slot, new Set())) return null
  }
  const generic = usable.filter(index => !assigned.has(index)).slice(0, cost.generic)
  return [...assigned.keys(), ...generic]
}
