import { ToolError } from './errors.mjs';
import { sameTriggerText } from './effect-boundaries.mjs';

const ownSeat = state => state.players?.find(player => player.yourSeat);
const valiant = /\bbecomes the target of a spell or ability you control for the first time each turn, exile the top card of your library\. (?:until end of turn, you may play that card|you may play that card this turn)\.$/i;

export function planImpulseWaiver(consent, state, actions, expectedIds, forecastsOrder) {
  if (!consent) return;
  const reject = () => { throw new ToolError('reevaluation_required', 'A one-card waiver requires the exact own Valiant instance or forecast, fixed attackers and a final pass within this turn.'); };
  const own = ownSeat(state);
  const source = [...(own?.battlefield ?? []), ...(state.ownHand ?? [])].find(card => card.id === consent.sourceId);
  if (!own || own.id !== state.activePlayerId || !source || source.faceDown || !valiant.test(consent.abilityText)
    || !source.rules?.some(rule => sameTriggerText(rule, consent.abilityText))) reject();
  const onBoard = own.battlefield?.some(card => card.id === source.id);
  if (onBoard && !Number.isSafeInteger(source.zoneChangeCounter)) reject();
  let originIndex = -1;
  let tailStart = 0;
  if (consent.stackId) {
    const [top] = state.stack;
    if (!onBoard || !top || top.id !== consent.stackId || top.sourceId !== source.id || top.controllerId !== own.id
      || top.abilityType !== 'TRIGGERED_NONMANA' || !sameTriggerText(top.abilityText, consent.abilityText)
      || expectedIds && !expectedIds.includes(top.id) || state.sequenceEvidence?.resolutions?.[top.id]) reject();
  } else {
    originIndex = actions.findIndex(action => action.expectTriggers?.some(trigger =>
      trigger.sourceId === source.id && sameTriggerText(trigger.abilityText, consent.abilityText)));
    const origin = actions[originIndex], order = actions[originIndex + 1];
    if (!origin || origin.kind !== 'play' || origin.reevaluateAfter || origin.expectCast === false
      || origin.targets?.length !== 1 || origin.targets[0].select.objectId !== source.id || origin.targets[0].select.zone !== 'battlefield'
      || !forecastsOrder(origin, order) || !origin.expectTriggers.every(trigger => trigger.sourceId === source.id)
      || !origin.expectTriggers.some(trigger => /^prowess\b/i.test(trigger.abilityText))) reject();
    tailStart = originIndex + 2;
  }
  if (!onBoard && !actions.slice(0, originIndex).some(action => action.kind === 'play' && action.select.objectId === source.id && action.select.zone === 'hand')) reject();
  const tail = actions.slice(tailStart), pass = tail.at(-1);
  if (pass?.kind !== 'pass_until' || pass.destination !== 'end_step' || pass.declineFromDecisionId || tail.length > 2) reject();
  if (tail.length === 2) {
    const [attack] = tail;
    const attackers = new Set([...(own.battlefield ?? []).map(c => c.id), source.id]);
    if (attack.kind !== 'attack' || !Array.isArray(attack.attackers) || !attack.attackers.length
      || attack.expectTriggers || attack.assignments || attack.attackers.some(id => !attackers.has(id))) reject();
  }
  return { ...consent, originIndex, tailStart, initialCounter: onBoard ? source.zoneChangeCounter : undefined };
}

/** Lives only inside one execution. The permission concerns this single move, never its card's name. */
export class ImpulseWaiver {
  constructor(plan, initial) {
    this.plan = plan;
    this.turn = initial.turn;
    this.seat = ownSeat(initial).id;
    this.stackId = plan.stackId;
    this.sourceCounter = plan.initialCounter;
  }

  bind(stackObject) {
    if (this.stackId || stackObject.controllerId !== this.seat || stackObject.abilityType !== 'TRIGGERED_NONMANA'
      || stackObject.sourceId !== this.plan.sourceId || !sameTriggerText(stackObject.abilityText, this.plan.abilityText)) {
      throw new ToolError('state_changed', 'The expected impulse trigger changed identity.');
    }
    this.stackId = stackObject.id;
  }

  observe(state, initialRevision, plannedIds) {
    const evidence = state.sequenceEvidence, witness = evidence.ownImpulseExile;
    if (state.turn !== this.turn || state.activePlayerId !== this.seat) throw new ToolError('turn_changed', 'The one-turn waiver expired.');
    const source = ownSeat(state)?.battlefield?.find(card => card.id === this.plan.sourceId && !card.faceDown);
    if (this.sourceCounter != null && source?.zoneChangeCounter !== this.sourceCounter) {
      throw new ToolError('state_changed', 'The specified trigger source changed incarnation or controller.');
    }
    if (source && this.sourceCounter == null) {
      if (!Number.isSafeInteger(source.zoneChangeCounter)) throw new ToolError('evidence_unavailable', 'The source incarnation is unavailable.');
      this.sourceCounter = source.zoneChangeCounter;
    }
    if (this.cardId && (!witness || witness.stackId !== this.stackId || witness.sourceId !== this.plan.sourceId
      || witness.cardId !== this.cardId || witness.informationRevision !== this.revision)) {
      throw new ToolError('state_changed', 'The waived exile or its source changed incarnation.');
    }
    if (this.cardId || !this.stackId || !plannedIds.has(this.stackId) || !evidence.resolutions[this.stackId]
      || !witness || witness.stackId !== this.stackId || witness.sourceId !== this.plan.sourceId
      || witness.informationRevision !== initialRevision + 1 || evidence.informationRevision !== witness.informationRevision) return;
    const own = ownSeat(state);
    const exiled = own.exile?.filter(card => card.id === witness.cardId && !card.faceDown && card.name);
    if (exiled?.length !== 1 || !own.battlefield?.some(card => card.id === witness.sourceId && !card.faceDown)) return;
    this.cardId = witness.cardId;
    this.revision = witness.informationRevision;
  }

  guardSubmission(state, actionIndex) {
    if (actionIndex < this.plan.tailStart) return;
    if (!this.cardId && (state.sequenceEvidence?.resolutions?.[this.stackId] || !state.stack?.length || state.decision?.kind !== 'priority')) {
      throw new ToolError('new_information', 'The expected resolution has no verified single face-up library exile.');
    }
  }

  declines(choice) {
    return !!this.cardId && choice.type === 'object' && choice.objectId === this.cardId
      && (!choice.card || choice.card.id === this.cardId);
  }
}
