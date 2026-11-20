import { useState } from 'react';
import { NO_REVEALED_HANDS, rememberRevealedHands, type RevealedHands } from '../../core/game/revealedHand';
import type { GameView } from '../../protocol/generated/views';

/**
 * Cards revealed from each player's hand that are still there (revealedHand.ts), remembered across the views the
 * match shows. Kept here rather than in the game session so it loads with the match screen, not the first page. A
 * replay jumps between moments, so it remembers nothing there.
 */
export function useRevealedHands(view: GameView | null, timeline: string | null): RevealedHands {
  const [memory, setMemory] = useState<{ timeline: string | null; view: GameView | null; hands: RevealedHands }>({
    timeline: null, view: null, hands: NO_REVEALED_HANDS,
  });
  if (timeline === null) return NO_REVEALED_HANDS;
  // each new view once, in order (React's "state from the previous render" pattern: no extra render pass)
  if (view && (memory.view !== view || memory.timeline !== timeline)) {
    const next = { timeline, view, hands: rememberRevealedHands(memory.timeline === timeline ? memory.hands : NO_REVEALED_HANDS, view) };
    setMemory(next);
    return next.hands;
  }
  return memory.timeline === timeline ? memory.hands : NO_REVEALED_HANDS;
}
