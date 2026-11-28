import type { ReactNode } from 'react';
import { useT } from '../i18n';
import { CardPreviewName } from './CardMarkdown';
import { cardGroup, cardGroups, manaSymbols, useCardFacts, type CardFacts, type CardGroup } from './cardFacts';
import styles from './DeckListView.module.css';

export interface DeckListCard {
  name: string;
  /** copies in the list; for an archetype, the average copies */
  amount: number | string;
  /** a figure printed at the end of the row, such as how many lists play it */
  note?: ReactNode;
}

const sum = (cards: readonly DeckListCard[]) =>
  cards.reduce((total, card) => total + (typeof card.amount === 'number' ? card.amount : 0), 0);

function ManaCost({ cost }: { cost: string }) {
  if (!cost) return null;
  return (
    <span className={styles.cost} aria-label={cost}>
      {manaSymbols(cost).map((symbol, i) => <i key={i} aria-hidden="true" className={`ms ms-cost ${symbol}`} />)}
    </span>
  );
}

function Group({ group, cards, facts, counted }: {
  group: CardGroup | 'sideboard' | 'all';
  cards: DeckListCard[];
  facts: ReadonlyMap<string, CardFacts>;
  counted: boolean;
}) {
  const t = useT();
  const icon = group === 'sideboard' ? 'ms-planeswalker' : group === 'all' || group === 'other' ? null : 'ms-' + group;
  return (
    <div className={styles.group} role="group" aria-label={t(`decklist.group.${group}`)}>
      <h4>
        {icon && group !== 'sideboard' && <i aria-hidden="true" className={`ms ${icon}`} />}
        <span>{t(`decklist.group.${group}`)}</span>
        {counted && <b>{sum(cards)}</b>}
      </h4>
      <ul>
        {cards.map((card) => (
          <li key={card.name}>
            <span className={styles.amount}>{card.amount}</span>
            <CardPreviewName card={{ name: card.name }}>
              <span className={styles.name}>{card.name}</span>
            </CardPreviewName>
            <ManaCost cost={facts.get(card.name)?.manaCost ?? ''} />
            {card.note != null && <span className={styles.note}>{card.note}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A decklist the way players read one: spells grouped by type and sorted by mana value with their costs, lands and
 * the sideboard beside them. Every name shows the card on hover or focus.
 */
export function DeckListView({ main, sideboard = [], counted = true, label }: {
  main: readonly DeckListCard[];
  sideboard?: readonly DeckListCard[];
  /** totals in each heading (off for an archetype's averaged copies) */
  counted?: boolean;
  label?: string;
}) {
  const t = useT();
  const facts = useCardFacts([...main, ...sideboard].map((card) => card.name));
  const byCost = (a: DeckListCard, b: DeckListCard) =>
    (facts.get(a.name)?.manaValue ?? 99) - (facts.get(b.name)?.manaValue ?? 99) || a.name.localeCompare(b.name);
  const ready = facts.size > 0;
  const groups = new Map<CardGroup, DeckListCard[]>();
  for (const card of main) {
    const group = ready ? cardGroup(facts.get(card.name)) : 'other';
    groups.set(group, [...(groups.get(group) ?? []), card]);
  }
  const spells = cardGroups.filter((g) => g !== 'land' && groups.has(g));
  const total = sum(main);
  const lands = groups.get('land') ?? [];
  return (
    <div className={styles.list} aria-label={label}>
      {counted && (
        <p className={styles.summary}>
          <strong>{total}</strong> {t('decklist.cards')}
          {ready && lands.length > 0 && <> · <strong>{sum(lands)}</strong> {t('decklist.lands')}</>}
          {sideboard.length > 0 && <> · <strong>{sum(sideboard)}</strong> {t('decklist.sideboardShort')}</>}
        </p>
      )}
      <div className={styles.columns}>
        <div className={styles.column}>
          {ready
            ? spells.map((group) => <Group key={group} group={group} cards={groups.get(group)!.sort(byCost)} facts={facts} counted={counted} />)
            : <Group group="all" cards={[...main]} facts={facts} counted={counted} />}
        </div>
        <div className={styles.column}>
          {ready && lands.length > 0 && <Group group="land" cards={lands.sort((a, b) => a.name.localeCompare(b.name))} facts={facts} counted={counted} />}
          {sideboard.length > 0 && <Group group="sideboard" cards={[...sideboard].sort(byCost)} facts={facts} counted={counted} />}
        </div>
      </div>
    </div>
  );
}
