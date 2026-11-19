const nodeId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value)
const indecisive = () => ({ lower: 0, upper: 1, forced: false, line: [] })
const probability = value => Math.min(1, Math.max(0, value))

function validatedNodes(nodes, rootId) {
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) throw new Error('Supply a finite node map')
  const map = new Map(Object.entries(nodes))
  if (!map.size || map.size > 3000 || !map.has(rootId)) throw new Error('A tactical tree needs its root and at most 3000 nodes')
  for (const [id, node] of map) {
    if (!nodeId(id) || !node || typeof node !== 'object') throw new Error('Invalid tactical node')
    if (node.kind === 'terminal' && typeof node.scored === 'boolean' || node.kind === 'unknown') continue
    if (!['max', 'min', 'chance'].includes(node.kind) || typeof node.complete !== 'boolean'
      || !Array.isArray(node.edges) || !node.edges.length || node.edges.length > 80
      || node.edges.some(edge => !edge || !nodeId(edge.to) || !map.has(edge.to)
        || typeof edge.action !== 'string' || !edge.action.trim() || edge.action.length > 180)) {
      throw new Error('A decision node needs declared coverage and edges to known nodes')
    }
    if (new Set(node.edges.map(edge => edge.action)).size !== node.edges.length) throw new Error('Distinguish alternative action labels')
    if (node.kind === 'chance') {
      if (node.edges.some(edge => typeof edge.weight !== 'number' || !Number.isFinite(edge.weight) || edge.weight < 0 || edge.weight > 1)) {
        throw new Error('Chance edges require probabilities in the unit interval')
      }
      const sum = node.edges.reduce((total, edge) => total + edge.weight, 0)
      if (node.complete ? Math.abs(sum - 1) > 1e-9 : sum > 1 + 1e-9) {
        throw new Error('Exhaustive chance probabilities must sum to one')
      }
    }
  }
  return map
}

export function searchTacticalTree({ objective, rootId, nodes, maxDepth, budget }) {
  if (objective !== 'lethal_this_turn' || !nodeId(rootId) || !Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 16
    || !Number.isInteger(budget) || budget < 1 || budget > 10000) throw new Error('Supply a lethal objective and bounded search')
  const declared = validatedNodes(nodes, rootId)
  const coverage = { visited: 0, terminals: 0, rivalResponses: 0, chanceOutcomes: 0, incompleteNodes: 0,
    unknownLeaves: 0, depthReached: 0, budgetExhausted: false, horizonExhausted: false }
  const branches = []
  function visit(id, depth) {
    if (coverage.visited === budget) {
      coverage.budgetExhausted = true
      return indecisive()
    }
    const node = declared.get(id)
    coverage.visited++
    coverage.depthReached = Math.max(coverage.depthReached, depth)
    if (node.kind === 'terminal') {
      coverage.terminals++
      const value = Number(node.scored)
      return { lower: value, upper: value, forced: node.scored, line: [] }
    }
    if (node.kind === 'unknown') {
      coverage.unknownLeaves++
      return indecisive()
    }
    if (depth >= maxDepth) {
      coverage.horizonExhausted = true
      return indecisive()
    }
    if (!node.complete) coverage.incompleteNodes++
    const candidates = []
    for (const edge of node.edges) {
      if (node.kind === 'chance' && !edge.weight) continue
      const before = coverage.visited
      const result = visit(edge.to, depth + 1)
      const studied = coverage.visited > before
      if (studied && node.kind === 'min') coverage.rivalResponses++
      if (studied && node.kind === 'chance') coverage.chanceOutcomes++
      if (branches.length < 100 && node.kind !== 'max') {
        branches.push({ nodeId: id, action: edge.action, kind: node.kind, studied,
          lower: result.lower, upper: result.upper })
      }
      candidates.push({ edge, result })
    }
    let lower, upper, forced, principal
    if (node.kind === 'chance') {
      const weight = candidates.reduce((total, { edge }) => total + edge.weight, 0)
      lower = candidates.reduce((total, { edge, result }) => total + edge.weight * result.lower, 0)
      upper = candidates.reduce((total, { edge, result }) => total + edge.weight * result.upper, Math.max(0, 1 - weight))
      forced = node.complete && candidates.length > 0 && candidates.every(({ result }) => result.forced)
      principal = candidates.reduce((best, item) => !best || item.edge.weight > best.edge.weight ? item : best, undefined)
    } else {
      const maximize = node.kind === 'max'
      const order = maximize ? (a, b) => Number(b.result.forced) - Number(a.result.forced)
        || b.result.lower - a.result.lower || b.result.upper - a.result.upper
        : (a, b) => a.result.upper - b.result.upper || a.result.lower - b.result.lower
      principal = [...candidates].sort(order)[0]
      lower = maximize ? Math.max(...candidates.map(item => item.result.lower))
        : node.complete ? Math.min(...candidates.map(item => item.result.lower)) : 0
      upper = maximize ? node.complete ? Math.max(...candidates.map(item => item.result.upper)) : 1
        : Math.min(...candidates.map(item => item.result.upper))
      forced = maximize ? candidates.some(item => item.result.forced)
        : node.complete && candidates.every(item => item.result.forced)
    }
    const move = principal ? { action: principal.edge.action, kind: node.kind, nodeId: id,
      ...(node.kind === 'chance' ? { probability: principal.edge.weight } : {}) } : null
    return { lower: probability(lower), upper: probability(upper), forced,
      line: move ? [move, ...principal.result.line] : [] }
  }
  const result = visit(rootId, 0)
  const { lower, upper, forced, line } = result
  const classification = forced ? 'forced_within_input_model' : lower !== upper ? 'inconclusive'
    : upper === 0 ? 'no_lethal_within_input_model' : 'probabilistic_within_input_model'
  return { objective, verification: 'input_model', classification, forcedInModel: forced, lower, upper, line,
    coverage: { ...coverage, maxDepth, budget, declaredNodes: declared.size, branches },
    limits: ['Uses submitted legal-action and coverage assumptions', 'The submitted tree is not an XMage replay receipt'] }
}
