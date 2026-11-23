import { useRef, useState } from 'react';
import type { CardView } from '../../protocol/generated/views';
import { useT } from '../i18n';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

export interface KnownCards {
  lookedAt?: { cards: Record<string, CardView> }[];
  revealed?: { cards: Record<string, CardView> }[];
  topCard?: CardView;
}

export function SeatKnowledge({ players, knowledge }: {
  players: {playerId: string; name: string; displayName?: string}[];
  knowledge: Record<string, KnownCards>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const sections = players.flatMap(player => {
    const view = knowledge[player.playerId];
    if (!view) return [];
    const groups = [
      { key: 'watch.lookedAt', cards: (view.lookedAt ?? []).flatMap(g => Object.values(g.cards)) },
      { key: 'watch.revealed', cards: (view.revealed ?? []).flatMap(g => Object.values(g.cards)) },
      { key: 'watch.topCard', cards: view.topCard ? [view.topCard] : [] },
    ] as const;
    const visible = groups.map(g => ({ ...g, cards: g.cards.filter(c => !c.faceDown && !c.hideInfo && (c.displayName || c.name)) })).filter(g => g.cards.length);
    return visible.length ? [{player, groups:visible}] : [];
  });
  if (!sections.length) return null;
  return <>
    <Button size="sm" variant="quiet" ref={opener} onClick={() => setOpen(true)}>{t('watch.knowledge')}</Button>
    <Dialog open={open} onOpenChange={setOpen} returnFocusRef={opener} title={t('watch.knowledge')}>
      {sections.map(({player, groups}) => <section key={player.playerId}>
        <h3>{player.displayName || player.name}</h3>
        <dl>{groups.map(({key,cards}) => <div key={key}><dt>{t(key)}</dt>
          <dd>{cards.map(c => c.displayName || c.name).join(', ')}</dd></div>)}</dl>
      </section>)}
    </Dialog>
  </>;
}
