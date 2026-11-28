import * as Tooltip from '@radix-ui/react-tooltip';
import { Fragment, useState, type ReactNode } from 'react';
import type { CardFace as Face } from '../../core/images/imageLinks';
import { useT } from '../i18n';
import { CardFace } from './CardFace';
import { cardTarget } from './cardPreviewTarget';
import styles from './CardMarkdown.module.css';

export interface PreviewCard {
  name: string;
  setCode?: string;
  cardNumber?: string;
}

export function CardPreviewName({ card, label = card.name, face = 'front', children }: {
  card: PreviewCard; label?: string; face?: Face; children?: ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return <Tooltip.Provider delayDuration={160}>
    <Tooltip.Root open={open} onOpenChange={setOpen}>
      <Tooltip.Trigger asChild>
        <button type="button" className={styles.cardName} aria-label={t('ui.showCard', { name: label })}
          aria-expanded={open} onClick={(event) => { event.preventDefault(); setOpen(true); }}>{children ?? label}</button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className={styles.preview} side="left" align="center" sideOffset={8} collisionPadding={12}
          aria-label={card.name} onEscapeKeyDown={() => setOpen(false)} onPointerDownOutside={() => setOpen(false)}>
          <CardFace card={{ name: card.name, expansionSetCode: card.setCode, cardNumber: card.cardNumber }} printed face={face} />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  </Tooltip.Provider>;
}

/** Render the app's inline card links and identifiable names in older prose as accessible previews. */
export function CardMarkdown({ text, cards = [] }: { text: string; cards?: readonly PreviewCard[] }) {
  const byName = new Map(cards.filter(({ name }) => name).map((card) => [card.name.toLowerCase(), card]));
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const known = names.length ? new RegExp(`(?<![\\p{L}\\p{N}_])(${names.join('|')})(?![\\p{L}\\p{N}_])`, 'giu') : null;

  function prose(value: string) {
    if (!known) return value;
    return value.split(known).map((part, i) => {
      const card = i % 2 ? byName.get(part.toLowerCase()) : undefined;
      return card ? <CardPreviewName key={i} card={card} label={part} /> : part;
    });
  }

  const parts: ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(/\[([^[\]\n]+)\]\(([^()\n]*)\)/g)) {
    const [raw, label, address] = match;
    const target = cardTarget(address);
    parts.push(<Fragment key={`before-${match.index}`}>{prose(text.slice(offset, match.index))}</Fragment>);
    parts.push(target
      ? <CardPreviewName key={match.index} card={byName.get(target.name.toLowerCase()) ?? target} label={label} face={target.face} />
      : raw);
    offset = match.index + raw.length;
  }
  return <>{parts}{prose(text.slice(offset))}</>;
}
