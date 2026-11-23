import { useLayoutEffect, useState } from 'react';
import type { GameSession, GameSessionState } from '../../core/game/gameSession';
import { NO_REVEALED_HANDS, rememberRevealedHands, type RevealedHands } from '../../core/game/revealedHand';
import { NO_REVEALS, rememberReveals, revealGroups } from '../../core/game/reveals';
import type { GameView } from '../../protocol/generated/views';

interface Memory {
  view: GameView | null;
  revision: number;
  hands: RevealedHands;
  reveals: typeof NO_REVEALS;
}

const empty: Memory = { view: null, revision: 0, hands: NO_REVEALED_HANDS, reveals: NO_REVEALS };

function observe(before: Memory, { view, rollbackRevision: revision, resyncing, mode }: GameSessionState): Memory {
  // Resync may clear its flag before replacing the old view. Never ingest that frame again.
  if (resyncing) return { ...empty, view, revision };
  // GAME_ROLLBACK withdraws the previous frame until the restored one arrives.
  if (!view) return before;
  if (view === before.view && revision === before.revision) return before;
  const turn = view.turn;
  const priorTurn = before.view?.turn;
  const rewound = revision !== before.revision || (turn !== undefined && priorTurn !== undefined && turn < priorTurn);
  // A watcher's reveal gives the original zone, not the current one (e.g. Vendilion Clique).
  // The turn strip recalls that public event without marking an unverified current hand.
  return {
    view, revision,
    hands: mode === 'watch' ? NO_REVEALED_HANDS : rememberRevealedHands(rewound ? NO_REVEALED_HANDS : before.hands, view),
    reveals: rememberReveals(rewound ? NO_REVEALS : before.reveals, view),
  };
}

/** Observe each seat-projected frame, including two callbacks delivered in the same React render interval. */
export function useReveals(session: GameSession, state: GameSessionState) {
  const live = state.mode !== 'replay';
  const [memory, setMemory] = useState(() => live ? observe(empty, state) : empty);
  useLayoutEffect(() => {
    if (live) return session.store.subscribe((next) => setMemory(previous => observe(previous, next)));
  }, [session, live]);
  if (!live) return { hands: NO_REVEALED_HANDS, groups: revealGroups(state.view) };
  if (!state.view || state.resyncing || memory.revision !== state.rollbackRevision) return { hands: NO_REVEALED_HANDS, groups: NO_REVEALS.groups };
  return { hands: memory.hands, groups: memory.reveals.groups };
}
