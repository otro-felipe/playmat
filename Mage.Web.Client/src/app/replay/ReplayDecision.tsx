import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Check, Star } from 'lucide-react';
import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { frameIndexAt, type ReplayTimeline } from '../../core/replay/timeline';
import { useT } from '../i18n';
import { CardFace } from '../ui/CardFace';
import { cleanDecisionText, decisionFrame, decisionPresentation } from './decisionPresentation';
import type { ReviewCategory, ReviewMoment, ReviewReference } from './reviewData';
import styles from './ReplayDecision.module.css';

export function ReviewRating({ category, label = false }: { category: ReviewCategory; label?: boolean }) {
  const t = useT();
  const rating = t(`replay.rating.${category}`);
  let icon;
  switch (category) {
    case 'brilliant': icon = '!!'; break;
    case 'best': icon = <Star size={14} fill="currentColor" />; break;
    case 'good':
    case 'acceptable':
    case 'equivalent': icon = <Check size={15} strokeWidth={3} />; break;
    case 'inaccuracy': icon = '?'; break;
    case 'blunder': icon = '??'; break;
    default: icon = '–';
  }
  return (
    <span className={styles.rating} data-rating={category}>
      <span className={styles.icon} role={label ? undefined : 'img'} aria-label={label ? undefined : rating}
        aria-hidden={label || undefined} title={label ? undefined : rating}>{icon}</span>
      {label && <span>{rating}</span>}
    </span>
  );
}

export function DecisionTitle({ moment }: { moment: ReviewMoment }) {
  const t = useT();
  const { fullTitle, cards } = decisionPresentation(moment, t);
  if (!cards.length) return fullTitle;
  const byName = new Map(cards.map((card) => [card.name, card]));
  const alternatives = [...byName.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!alternatives.length) return fullTitle;
  const pattern = new RegExp(`(${alternatives.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
  return (
    <Tooltip.Provider delayDuration={160} disableHoverableContent>
      {fullTitle.split(pattern).map((text, index) => {
        const card = byName.get(text);
        return <Fragment key={index}>{card ? <PreviewName card={card} /> : text}</Fragment>;
      })}
    </Tooltip.Provider>
  );
}

function PreviewName({ card }: { card: ReviewReference }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <Tooltip.Root open={open} onOpenChange={setOpen}>
      <Tooltip.Trigger asChild>
        <button type="button" className={styles.cardName} aria-label={t('replay.showCard', { name: card.name })}
          aria-expanded={open}
          onClick={(event) => { event.preventDefault(); setOpen(true); }}>{card.name}</button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className={styles.preview} side="left" align="center" sideOffset={8}
          collisionPadding={12} onEscapeKeyDown={(event) => { event.preventDefault(); setOpen(false); }}
          onPointerDownOutside={() => setOpen(false)}>
          <CardFace card={{ name: card.name, expansionSetCode: card.setCode, cardNumber: card.cardNumber }} size="normal" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function RecordedDecision({ moment }: { moment: ReviewMoment }) {
  const t = useT();
  const { shortTitle, targets } = decisionPresentation(moment, t);
  const modes = [moment.actual?.castMode, ...(moment.actual?.modes ?? [])].flatMap((value) => value ? [cleanDecisionText(value, t)] : []);
  const mana = Object.entries(moment.actual?.paidMana ?? {}).map(([symbol, amount]) => `${amount} ${symbol}`).join(' + ');
  return (
    <section className={styles.decision} aria-label={t('replay.decision')}>
      <div className={styles.title}>
        {moment.category && <ReviewRating category={moment.category} />}
        <strong>{shortTitle}</strong>
      </div>
      {(targets.length > 0 || modes.length > 0 || mana) && (
        <dl>
          {targets.length > 0 && <div><dt>{t('replay.targets')}</dt><dd>{targets.map(({ name }) => name).join(', ')}</dd></div>}
          {modes.length > 0 && <div><dt>{t('replay.choices')}</dt><dd>{modes.join(', ')}</dd></div>}
          {mana && <div><dt>{t('replay.manaPaid')}</dt><dd>{mana}</dd></div>}
        </dl>
      )}
    </section>
  );
}


type RatedMoment = ReviewMoment & { category: ReviewCategory };

export function ReplayDecisionMarkers({ moments, timeline, current, onMoment }: {
  moments: readonly ReviewMoment[];
  timeline: ReplayTimeline;
  current?: number;
  onMoment: (moment: ReviewMoment) => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const last = timeline.frames.length - 1;
  const lastCursor = timeline.frames[last]?.cursor ?? -1;
  const groups: { index: number; items: RatedMoment[] }[] = [];
  const rated = moments.flatMap((moment) => {
    const frame = decisionFrame(moment);
    return moment.category && frame <= lastCursor
      ? [{ moment: { ...moment, category: moment.category }, index: frameIndexAt(timeline, frame) }] : [];
  }).sort((a, b) => a.index - b.index);
  for (const { moment, index } of rated) {
    const prior = groups.at(-1);
    // A cluster opens a menu so exact or nearby frames never leave an inaccessible marker under another.
    if (prior && (prior.index === index || (width > 0 && (index - prior.index) * width / Math.max(last, 1) < 26))) {
      prior.items.push(moment);
    } else {
      groups.push({ index, items: [moment] });
    }
  }

  return <div ref={ref} role="group" className={styles.markers} aria-label={t('replay.decisionMarkers')} data-empty={groups.length === 0 || undefined}>
    {groups.map(({ index, items }) => (
      <DecisionMarker key={index} items={items} fraction={index / Math.max(last, 1)} current={current} onMoment={onMoment} />
    ))}
  </div>;
}

function DecisionMarker({ items, fraction, current, onMoment }: {
  items: RatedMoment[];
  fraction: number;
  current?: number;
  onMoment: (moment: ReviewMoment) => void;
}) {
  const t = useT();
  const [first] = items;
  const markerName = (moment: RatedMoment) => t('replay.decisionMarker', {
    rating: t(`replay.rating.${moment.category}`),
    play: decisionPresentation(moment, t).fullTitle,
  });
  const style = { '--decision-position': `${fraction * 100}%` } as CSSProperties;
  if (items.length === 1) {
    const name = markerName(first);
    return <button type="button" className={styles.marker} style={style}
      title={name} aria-label={name} aria-current={first.cursor === current ? 'step' : undefined} onClick={() => onMoment(first)}>
      <ReviewRating category={first.category} />
    </button>;
  }
  const label = t('replay.decisionCluster', { count: items.length });
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger type="button" className={styles.marker} style={style} title={label}
      aria-label={label} aria-current={items.some((item) => item.cursor === current) ? 'step' : undefined}>
      <span className={styles.cluster} aria-hidden="true">
        {items.slice(0, 3).map((item) => <ReviewRating key={item.cursor} category={item.category} />)}
      </span>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className={styles.markerMenu} side="top" sideOffset={6} collisionPadding={12}>
        {items.map((item) => (
          <DropdownMenu.Item key={item.cursor} className={styles.markerMenuItem}
            aria-current={item.cursor === current ? 'step' : undefined} onSelect={() => onMoment(item)}>
            <ReviewRating category={item.category} />
            <span>{decisionPresentation(item, t).fullTitle}</span>
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
