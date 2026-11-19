// Use only visible rules for preflight. The executor also verifies actual
// audience-scoped information events and newly presented decisions.
export function needsEffectReevaluation(text) {
  return /\b(?:scry|surveil|cascade|discover|mill|learn)\b|\bdraw(?:s)?\b[^.]*\bcards?\b|\b(?:look at|reveal|reveals)\b|\bexile\b[^.]*\btop\b|\bsearch\b[^.]*\blibrar(?:y|ies)\b|\bat random\b|\bflip\b[^.]*\bcoins?\b|\broll\b[^.]*\b(?:die|dice|d\d+)\b|\b(?:opponent|target player|each player|that player)\b[^.]*\b(?:choose|chooses|sacrifice|sacrifices|discard|discards)\b/i.test(text);
}

function spellRules(card) {
  if (!card?.types?.some((type) => type === 'INSTANT' || type === 'SORCERY')) return [];
  return card.selectedModeRules?.length ? card.selectedModeRules : card.rules ?? [];
}

export function triggeredEffect(text) {
  return text.replace(/^(?:Whenever|When|At)\b[^,.]*,\s*/i, '');
}

export function needsSpellReevaluation(card) {
  return spellRules(card).some(needsEffectReevaluation);
}

function stackRules(card) {
  if (card?.selectedModeRules?.length) return card.selectedModeRules;
  if (!card?.abilityType) return spellRules(card);
  const rule = card.abilityText ?? '';
  return [card.abilityType.startsWith('TRIGGERED') ? triggeredEffect(rule) : rule];
}

export function needsStackReevaluation(card, ownId) {
  return stackRules(card).some((text) => needsEffectReevaluation(
    ownId && card.controllerId && card.controllerId !== ownId
      // The controller's direct draw is private. Preserve other clauses,
      // including public reveals, effects directed at other players and random results.
      ? text.replace(/(^|\.\s+)(?:you )?draw (?:a|one|two|three|four|five|\d+) cards?\b/gi, '$1')
      : text,
  ));
}

export function canCallCoin(card) {
  return stackRules(card).some((text) => /\bflip\b[^.]*\bcoins?\b/i.test(text));
}

const normalize = (text) => text?.trim().replace(/\s+/g, ' ').toLowerCase();

export function optionalInformationEffect(card) {
  const rules = stackRules(card);
  if (rules.length !== 1) return;
  // DoIfCostPaid's default prompt joins these two clauses. Match only a single
  // optional effect with no further sentence or independent downside.
  const branch = /^you may ([^.]+)\. if you do, ([^.]+)\.$/i.exec(rules[0].trim());
  if (!branch || /;|\b(?:if you don['’]t|if you do not|if you decline|otherwise|unless)\b/i.test(rules[0]) || !needsEffectReevaluation(branch[2])) return;
  return {
    question: normalize(`${branch[1]} and ${branch[2]}?`),
    oneHandDiscard: /^discard (?:a|one) (?:[^\s]+ )*card$/i.test(branch[1].trim()),
  };
}

export function guardsEffectQuestion(action, card, decision) {
  const question = optionalInformationEffect(card)?.question;
  if (!question || !['choose', 'answer'].includes(action?.kind)) return false;
  if (action.decisionId) return action.decisionId === decision?.id && decision?.kind === 'question'
    && normalize(decision.instruction) === question;
  if (action.guard?.kind !== 'question') return false;
  if (action.guard.instruction !== undefined) return normalize(action.guard.instruction) === question;
  const sourceId = action.guard.sourceObjectId;
  return !!sourceId && [card.sourceId, card.cardId, card.id].includes(sourceId) && typeof action.select?.answer === 'boolean'
    && (decision?.kind !== 'question' || (decision.sourceObjectId === sourceId && normalize(decision.instruction) === question));
}

export function plansInformationBranch(card, action, tail, decision) {
  if (!card || action.reevaluateAfter) return false;
  return !!((action.modeId || action.mode) && card.rules?.some((rule) => /^choose (?:one|two|three)\b/i.test(rule)))
    || tail.some((next) => guardsEffectQuestion(next, card, decision));
}
