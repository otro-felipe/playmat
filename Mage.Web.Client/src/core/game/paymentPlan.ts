import { handNeeds, landsPartOf, manaAmount, manaOf, manaTier, nextTap, orderReadings, parseCostOptions, type ManaColor, type ManaReach, type ManaSource, type ManaTap } from './autoPay';
import { parsePayment, POOL_MANA, poolId } from './payment';
import type { PlayManaPrompt } from './prompt';
import type { PlayerView } from '../../protocol/generated/views';

export interface PaymentOptions extends ManaReach {
  hybrid?: boolean;
  afterX?: boolean;
}

export interface PaymentPlan {
  next: ManaTap | null;
  reason: 'manual' | 'insufficient' | null;
}

/** A conservative next payment, including floating mana when server-side pool automation is off. */
export function planPayment(prompt: PlayManaPrompt, player: PlayerView, clickable: ReadonlyMap<string, unknown>, handCosts: string[], options: PaymentOptions): PaymentPlan {
  const readings = !prompt.isX && parseCostOptions(prompt.text, options.hybrid);
  if (!readings) return { next: null, reason: 'manual' };
  const permanents = Object.values(player.battlefield ?? {});
  const untapped = (type: string) => permanents.filter((card) => !card.tapped && (card.cardTypes ?? []).includes(type as never)).length;
  const payers = { graveyard: Object.keys(player.graveyard ?? {}).length, creatures: untapped('CREATURE'), artifacts: untapped('ARTIFACT') };
  const costs = readings.map((cost) => prompt.specialLabel ? landsPartOf(cost, prompt.specialLabel, payers) : cost);
  if (costs.some((cost) => !cost)) return { next: null, reason: 'manual' };
  const payingFor = parsePayment(prompt).sourceId;
  const sources: ManaSource[] = [];
  for (const card of permanents) {
    if (!card.id || !clickable.has(card.id) || card.tapped || card.id === payingFor) continue;
    const colors = manaOf(card, options);
    if (colors === undefined) continue;
    sources.push({ id: card.id, colors, isLand: (card.cardTypes ?? []).includes('LAND'), tier: manaTier(card), amount: manaAmount(card) });
  }
  // Each pool click spends one unit. Separate units let the planner reserve a needed color for later.
  const floating: ManaSource[] = POOL_MANA.flatMap(({ key, manaType, symbol }) => {
    const id = poolId(manaType);
    return clickable.has(id) ? Array.from({ length: player.manaPool?.[key] ?? 0 }, () => ({ id, colors: [symbol.toUpperCase() as ManaColor], isLand: false, tier: -1 })) : [];
  });
  const all = floating.concat(sources);
  const tiers = [...new Set(all.map((source) => source.tier ?? 0))].sort((a, b) => a - b);
  for (const tier of tiers) {
    const pool = all.filter((source) => (source.tier ?? 0) <= tier);
    for (const cost of orderReadings(costs.filter((cost) => cost !== null), pool)) {
      const owed = cost.generic + Object.values(cost.colored).reduce((sum, value) => sum + (value ?? 0), 0);
      const next = nextTap(cost, pool, handNeeds(handCosts, pool.length - owed));
      if (next) return { next, reason: null };
    }
  }
  // Unknown sources or special payments may still be usable manually; never claim the spell itself is illegal.
  return { next: null, reason: sources.some((source) => source.colors === null) || prompt.specialLabel ? 'manual' : 'insufficient' };
}
