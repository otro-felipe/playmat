import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActionPresentation } from '../../core/game/actionPresentation';
import type { GameSession } from '../../core/game/gameSession';
import { seatDisplayName, type SeatDisplayNames } from './seatDisplayNames';
import styles from './RecentActions.module.css';

/** Read-only public action receipts. The actual stack, priority and buttons always show the live state. */
export function RecentActions({ session, seatDisplayNames }: { session: GameSession; seatDisplayNames?: SeatDisplayNames }) {
  const [feed] = useState(() => new ActionPresentation());
  useEffect(() => {
    feed.connect(session);
    return () => feed.dispose();
  }, [feed, session]);
  return <ActionReceipt feed={feed} seatDisplayNames={seatDisplayNames} />;
}

function ActionReceipt({ feed, seatDisplayNames }: { feed: ActionPresentation; seatDisplayNames?: SeatDisplayNames }) {
  const state = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const action = state.items[0];
  if (!action && !state.overflow) return null;
  return (
    <aside className={styles.receipt} aria-label="Recent action" aria-live="polite" aria-atomic="true">
      <small>Recent action{action?.turn ? ` · Turn ${action.turn}` : ''}</small>
      {action && <>
        <strong>{action.name}</strong>
        <span>{action.kind}</span>
        {action.targets.length > 0 && <span>Targets: {action.targets.map((name) => seatDisplayName(name, seatDisplayNames)).join(' · ')}</span>}
      </>}
      {state.items.length > 1 && <small>{state.items.length - 1} queued</small>}
      {state.overflow > 0 && <small>{state.overflow} more actions · see Log</small>}
    </aside>
  );
}
