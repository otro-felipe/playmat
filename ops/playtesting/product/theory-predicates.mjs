import { manaColors } from './theory-mana.mjs'

const openingOperators = new Set(['has_card', 'has_any_tag', 'has_all_tags', 'count_tag', 'land_count',
  'source_count', 'has_source', 'has_untapped_source', 'has_land_tag', 'only_tapped_lands'])
const turnOperators = new Set(['can_cast_by_turn', 'present_not_castable', 'draws_contain_card',
  'draws_contain_tag', 'line_executable'])

export function compileTheoryPredicate(expression, cards, horizon, options = {}) {
  const knownTags = new Set([...cards.values()].flatMap(card => card.tags))
  let nodes = 0
  function compile(node, depth) {
    if (++nodes > 60 || depth > 6 || !node || typeof node !== 'object' || Array.isArray(node) || Object.keys(node).length !== 1) {
      throw new Error('Use a bounded expression with one operator per node')
    }
    const [[operator, value]] = Object.entries(node)
    if (operator === 'all' || operator === 'any') {
      if (!Array.isArray(value) || !value.length || value.length > 12) throw new Error('Boolean helpers require 1–12 conditions')
      const children = value.map(child => compile(child, depth + 1))
      return result => operator === 'all' ? children.every(check => check(result)) : children.some(check => check(result))
    }
    if (operator === 'not') {
      const child = compile(value, depth + 1)
      return result => !child(result)
    }
    if (options.opening && !openingOperators.has(operator)) throw new Error('A keep rule can use only the current opening hand')
    if (!openingOperators.has(operator) && !turnOperators.has(operator)) throw new Error('Unknown theory predicate')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provide predicate parameters as an object')
    const { id, tag, tags, turn, color, min = 1, max = 250 } = value
    if (options.opening && turn !== undefined) throw new Error('A keep rule cannot name a turn beyond the opening hand')
    if (turn !== undefined && (!Number.isInteger(turn) || turn < 1 || turn > horizon)) throw new Error('Predicate turn is outside the horizon')
    if (id !== undefined && !cards.has(id)) throw new Error('Predicate references an undeclared card')
    if (tag !== undefined && !knownTags.has(tag)) throw new Error('Predicate references an undeclared tag')
    if (tags !== undefined && (!Array.isArray(tags) || !tags.length || tags.some(item => !knownTags.has(item)))) throw new Error('Unknown predicate tag list')
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min || max > 250) throw new Error('Invalid count range')
    if (color !== undefined && (typeof color !== 'string' || color.length !== 1 || !manaColors.includes(color))) throw new Error('Invalid source color')
    const hasTag = (cardId, wanted) => cards.get(cardId).tags.includes(wanted)
    const matchesCard = cardId => id !== undefined ? cardId === id : hasTag(cardId, tag)
    const inRange = count => count >= min && count <= max
    const requireCard = () => {
      if ((id === undefined) === (tag === undefined)) throw new Error('Select one card or one tag')
    }
    if (['has_card', 'draws_contain_card'].includes(operator) && id === undefined) throw new Error('Card ID required')
    if (['count_tag', 'draws_contain_tag', 'has_land_tag'].includes(operator) && tag === undefined) throw new Error('Card tag required')
    if (['has_any_tag', 'has_all_tags'].includes(operator) && !tags) throw new Error('Card tag list required')
    if (['source_count', 'has_source', 'has_untapped_source'].includes(operator) && color === undefined) throw new Error('Source color required')
    if (['can_cast_by_turn', 'present_not_castable'].includes(operator)) requireCard()
    if (turnOperators.has(operator) && turn === undefined) throw new Error('A turn is required for this predicate')
    return result => {
      const frames = result.frames.filter(frame => frame.turn <= turn)
      const hand = turn === undefined ? result.opening : frames.at(-1)?.hand ?? []
      const lands = hand.filter(cardId => cards.get(cardId).land)
      const sources = turn === undefined ? lands.map(cardId => {
        const land = cards.get(cardId).land
        return { colors: land.colors, tapped: land.entersTapped }
      }) : frames.at(-1)?.sources ?? []
      switch (operator) {
        case 'has_card': return hand.includes(id)
        case 'has_any_tag': return tags.some(wanted => hand.some(cardId => hasTag(cardId, wanted)))
        case 'has_all_tags': return tags.every(wanted => hand.some(cardId => hasTag(cardId, wanted)))
        case 'count_tag': return inRange(hand.filter(cardId => hasTag(cardId, tag)).length)
        case 'land_count': return inRange(lands.length)
        case 'has_land_tag': return lands.some(cardId => hasTag(cardId, tag))
        case 'only_tapped_lands': return lands.length > 0 && lands.every(cardId => cards.get(cardId).land.entersTapped)
        case 'source_count': return inRange(sources.filter(source => source.colors.includes(color)).length)
        case 'has_source': return sources.some(source => source.colors.includes(color))
        case 'has_untapped_source': return sources.some(source => !source.tapped && source.colors.includes(color))
        case 'can_cast_by_turn': return frames.some(frame => frame.castable.some(matchesCard))
        case 'present_not_castable': return frames.some(frame => frame.hand.some(matchesCard))
          && !frames.some(frame => frame.castable.some(matchesCard))
        case 'draws_contain_card': return frames.some(frame => frame.drawn === id)
        case 'draws_contain_tag': return frames.some(frame => frame.drawn !== undefined && hasTag(frame.drawn, tag))
        case 'line_executable': return frames.at(-1)?.lineExecutable === true
        default: return false
      }
    }
  }
  return compile(expression, 0)
}
