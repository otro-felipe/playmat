import { isDeepStrictEqual } from 'node:util';

const damageSteps = new Set(['DECLARE_BLOCKERS', 'FIRST_COMBAT_DAMAGE', 'COMBAT_DAMAGE', 'END_COMBAT']);
const afterCombatSteps = new Set(['POSTCOMBAT_MAIN', 'END_TURN', 'CLEANUP']);

export function observedBlocks(state, ownId) {
  const ownIds = new Set(state.players?.find((player) => player.id === ownId)?.battlefield?.map(({ id }) => id));
  return (state.combat ?? []).flatMap(({ attackers = [], blockers = [] }) => attackers.flatMap(({ id: attackerId }) =>
    blockers.filter(({ id, controllerId }) => controllerId === ownId || ownIds.has(id))
      .map(({ id: blockerId }) => ({ blockerId, attackerId }))));
}

export function observedAttacks(state, ownId) {
  const ownIds = new Set(state.players?.find((player) => player.id === ownId)?.battlefield?.map(({ id }) => id));
  return (state.combat ?? []).flatMap(({ defenderId, attackers = [] }) => attackers
    .filter(({ id, controllerId }) => controllerId === ownId || ownIds.has(id))
    .map(({ id: attackerId }) => ({ attackerId, defenderId })));
}

function attackedDefender({ combat, activePlayerId }, hit, ownId, declaredAttackers) {
  return activePlayerId === ownId && hit.controllerId === ownId && declaredAttackers.has(hit.sourceId)
    && combat?.some(({ defenderId, isBlocked, attackers, blockers = [] }) =>
      defenderId === hit.targetId && isBlocked === false && blockers.length === 0
      && attackers?.some(({ id, controllerId }) => id === hit.sourceId && controllerId === ownId));
}

function counterCount(card, name) {
  const counter = (card.counters ?? []).filter((entry) => entry.name === name);
  return counter.length > 1 ? NaN : counter[0]?.count ?? 0;
}

function withoutCounter({ counters, hints: _derivedHints, ...card }, name) {
  return { ...card, counters: (counters ?? []).filter((entry) => entry.name !== name)
    .sort((a, b) => a.name.localeCompare(b.name)) };
}

function combatPartners({ combat, activePlayerId }, hit, ownId, declaredAttackers) {
  return combat?.some(({ attackers, blockers }) => attackers?.some((attacker) =>
    attacker.controllerId === activePlayerId && blockers?.some((blocker) => {
      const ownParticipant = activePlayerId === ownId ? declaredAttackers.has(attacker.id) : blocker.controllerId === ownId;
      return ownParticipant && blocker.controllerId && blocker.controllerId !== activePlayerId && (
        hit.controllerId === attacker.controllerId && hit.sourceId === attacker.id && hit.targetId === blocker.id
        || hit.controllerId === blocker.controllerId && hit.sourceId === blocker.id && hit.targetId === attacker.id
      );
    })));
}

function graveyardEntry(players, cardId) {
  if (!cardId) return null;
  const matches = players.flatMap(({ graveyard = [] }) => graveyard).filter((card) =>
    !card.faceDown && (card.id === cardId || card.cardId === cardId));
  return matches.length === 1 ? matches[0] : null;
}

/** Only exact combat effects among already observed and declared combatants. */
export class PlannedPermanentCombat {
  #hits = new Map();
  #turn;

  get active() { return this.#hits.size > 0; }
  get pending() { return [...this.#hits.values()].some((hit) => !hit.settled); }

  record(previous, state, hit, ownId, declaredAttackers) {
    if (previous.turn !== state.turn || !ownId || state.activePlayerId !== previous.activePlayerId
      || !damageSteps.has(previous.step)) return false;
    const target = previous.players?.flatMap((player) => player.battlefield ?? []).find((card) => card.id === hit.targetId);
    if (target?.faceDown || !target?.types) return false;
    const walker = target.types.includes('PLANESWALKER');
    const battle = target.types.includes('BATTLE');
    const creature = target.types.includes('CREATURE');
    // Animated planeswalkers or battles can change both damage and counters.
    if (Number(walker) + Number(battle) + Number(creature) !== 1) return false;
    const counter = walker ? 'loyalty' : battle ? 'defense' : null;
    const observed = counter ? attackedDefender(previous, hit, ownId, declaredAttackers)
      : combatPartners(previous, hit, ownId, declaredAttackers);
    if (!observed) return false;
    const before = counter ? counterCount(target, counter) : target.damage;
    if (!Number.isSafeInteger(before) || before < (counter ? 1 : 0)) return false;
    const prior = this.#hits.get(target.id);
    if (prior && (prior.dead || prior.counter !== counter)) return false;
    const from = prior?.after ?? before;
    const after = counter ? Math.max(0, from - hit.amount) : from + hit.amount;
    if (!Number.isSafeInteger(after)) return false;
    this.#turn = state.turn;
    this.#hits.set(target.id, { target, counter, before, after, settled: false, dead: false });
    return true;
  }

  reconcile(previous, state, expected, actual) {
    if (state.turn !== this.#turn || !damageSteps.has(state.step) && !afterCombatSteps.has(state.step)) return false;
    const actualCards = state.players?.flatMap((player) => player.battlefield ?? []) ?? [];
    for (const effect of this.#hits.values()) {
      const { target, counter, before, after } = effect;
      const card = actualCards.find(({ id }) => id === target.id);
      if (card) {
        if (effect.dead || card.controllerId !== target.controllerId || card.faceDown) return false;
        if (counter && !isDeepStrictEqual(withoutCounter(target, counter), withoutCounter(card, counter))) return false;
        const value = counter ? counterCount(card, counter) : card.damage;
        if (value === after) effect.settled = true;
        else if (effect.settled || value !== before) return false;
        const opponent = expected.players.find(({ id }) => id === target.controllerId);
        const expectedCard = opponent?.battlefield?.find(({ id }) => id === target.id);
        if (expectedCard) {
          if (counter) expectedCard.counters = card.counters;
          else expectedCard.damage = card.damage;
        }
      } else if (!effect.dead) {
        const toughness = Number(target.toughness);
        const lethal = counter ? after === 0 : Number.isSafeInteger(toughness) && toughness > before && after >= toughness;
        const grave = graveyardEntry(state.players ?? [], target.cardId);
        if (!lethal || !grave || graveyardEntry(previous.players ?? [], target.cardId)) return false;
        effect.settled = true;
        effect.dead = true;
        const opponent = expected.players.find(({ id }) => id === target.controllerId);
        if (opponent) {
          const owner = actual.players.find((player) => player.graveyard?.some(({ id }) => id === grave.id));
          // Changes of controller or an unusual destination require a new plan.
          if (owner?.id !== opponent.id || !opponent.battlefield?.some(({ id }) => id === target.id)) return false;
          const graveIndex = owner.graveyard.findIndex(({ id }) => id === grave.id);
          opponent.battlefield = opponent.battlefield.filter(({ id }) => id !== target.id);
          opponent.graveyard ??= [];
          opponent.graveyard.splice(graveIndex, 0, owner.graveyard[graveIndex]);
        }
      }
    }
    if (afterCombatSteps.has(state.step) && state.combat?.length === 0) {
      expected.combat = [];
      return true;
    }
    for (const group of expected.combat) {
      const opposing = actual.combat.find(({ index }) => index === group.index);
      group.attackerIds = group.attackerIds.filter((id) => !this.#hits.get(id)?.dead);
      for (const kind of ['attackers', 'blockers']) {
        group[kind] = group[kind].filter(({ id }) => !this.#hits.get(id)?.dead);
        for (const card of group[kind]) {
          const effect = this.#hits.get(card.id);
          const observed = opposing?.[kind].find(({ id }) => id === card.id);
          if (effect && !effect.counter && observed?.damage === effect.after) card.damage = effect.after;
        }
      }
    }
    expected.combat = expected.combat.filter((group) => group.attackers.length || group.blockers.length);
    return true;
  }

  finish(state) {
    if (afterCombatSteps.has(state.step) && state.combat?.length === 0 && !this.pending) this.#hits.clear();
  }
}

function defenderCounters(player) {
  return JSON.stringify((player.counters ?? []).map(({ name, count }) => [name, count])
    .sort(([a], [b]) => String(a).localeCompare(String(b))));
}

/** Account only for witnessed player damage from an observed, unblocked rival attacker. */
export class PlannedDefenderCombat {
  #turn;
  #life;
  #counters;
  #lifeAfterHits = [];
  #combatFinished = false;

  get active() { return this.#turn !== undefined && !this.#combatFinished; }
  get pending() { return this.#lifeAfterHits.length > 0; }

  record(previous, state, hit, ownId) {
    const defender = previous.players?.find(({ id }) => id === ownId);
    if (!defender || !Number.isSafeInteger(defender.life) || previous.turn !== state.turn
      || !damageSteps.has(previous.step) || previous.activePlayerId !== hit.controllerId
      || previous.activePlayerId !== state.activePlayerId || hit.controllerId === ownId || hit.targetId !== ownId
      || !previous.combat?.some(({ defenderId, isBlocked, attackers = [], blockers = [] }) =>
        defenderId === ownId && isBlocked === false && blockers.length === 0
        && attackers.some(({ id, controllerId }) => id === hit.sourceId && controllerId === hit.controllerId))) return false;

    if (this.#turn !== state.turn) {
      if (this.pending) return false;
      this.#turn = state.turn;
      this.#life = defender.life;
      this.#counters = defenderCounters(defender);
      this.#combatFinished = false;
    } else if (!this.active) return false;

    const afterDamage = (this.#lifeAfterHits.at(-1) ?? this.#life) - hit.amount;
    if (!Number.isSafeInteger(afterDamage)) return false;
    this.#lifeAfterHits.push(afterDamage);
    return true;
  }

  reconcile(state, ownId) {
    if (this.#turn === undefined || state.turn !== this.#turn) return !this.active;
    const defender = state.players?.find(({ id }) => id === ownId);
    if (!defender || defenderCounters(defender) !== this.#counters) return false;
    // Once combat has settled, continue watching counters for delayed poison.
    if (this.#combatFinished) return true;
    if (!damageSteps.has(state.step) && !afterCombatSteps.has(state.step)) return false;
    if (defender.life === this.#life) return true;
    const count = this.#lifeAfterHits.indexOf(defender.life) + 1;
    if (!count) return false;
    this.#lifeAfterHits.splice(0, count);
    this.#life = defender.life;
    return true;
  }

  canClearGroups(state) {
    return this.active && this.#turn === state.turn && afterCombatSteps.has(state.step) && state.combat?.length === 0;
  }

  finish(state) {
    if (!this.pending && this.canClearGroups(state)) this.#combatFinished = true;
  }
}
