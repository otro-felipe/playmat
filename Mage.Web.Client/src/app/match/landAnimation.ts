import type { GameView, PermanentView } from '../../protocol/generated/views';
import type { Prompt } from '../../core/game/prompt';

export type LandNotice = 'recent' | 'needsHaste' | 'noRestriction' | 'grantsHaste' | 'unknown';

export function recentlyControlledLand(card: PermanentView) {
  return card.summoningSickness === true && card.cardTypes?.includes('LAND') && !card.cardTypes.includes('CREATURE');
}

/** Only the target role tagged by XMage describes the animation; other roles of the same spell can differ. */
export function animationTargets(prompt: Prompt | null, view: GameView | null, legal: ReadonlySet<string>) {
  const intent = prompt?.kind === 'target' ? prompt.options.targetAnimation : undefined;
  if (intent !== 'becomesCreature' && intent !== 'grantsHaste') return null;
  const lands: PermanentView[] = [];
  const notices = new Map<string, LandNotice>();
  for (const player of view?.players ?? []) {
    for (const card of Object.values(player.battlefield ?? {})) {
      if (!card.id || !legal.has(card.id) || !card.cardTypes?.includes('LAND')) continue;
      lands.push(card);
      const notice = intent === 'grantsHaste' ? 'grantsHaste' : card.summoningSickness === true
        ? 'needsHaste' : card.summoningSickness === false ? 'noRestriction' : 'unknown';
      notices.set(card.id, notice);
    }
  }
  if (!lands.length) return null;
  // For mixed targeting, keep the ordinary board picker and every other legal target available.
  return { notices, lands: lands.length === legal.size ? lands : null };
}
