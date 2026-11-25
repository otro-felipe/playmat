import { usePlayerNames } from '../ui/usePlayerIdentity';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, Star } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { frameIndexAt, type ReplayTimeline } from '../../core/replay/timeline';
import { useT, type MessageKey } from '../i18n';
import { CardMarkdown, CardPreviewName } from '../ui/CardMarkdown';
import { cleanDecisionText, decisionFrame, decisionPresentation, replayName } from './decisionPresentation';
import type { ReviewCategory, ReviewDecisionContext, ReviewMoment } from './reviewData';
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
  const formatName = usePlayerNames();
  const { fullTitle, cards } = decisionPresentation(moment, t, formatName);
  return <CardMarkdown text={fullTitle} cards={cards} />;
}

/** What a decision committed besides its title: targets, choices and the mana paid. */
export function RecordedDecision({ moment }: { moment: ReviewMoment }) {
  const t = useT();
  const formatName = usePlayerNames();
  const { targets } = decisionPresentation(moment, t, formatName);
  const modes = [moment.actual?.castMode, ...(moment.actual?.modes ?? [])].flatMap((value) => value ? [cleanDecisionText(value, t, formatName)] : []);
  const mana = Object.entries(moment.actual?.paidMana ?? {}).map(([symbol, amount]) => `${amount} ${symbol}`).join(' + ');
  if (!targets.length && !modes.length && !mana) return null;
  return (
    <dl className={styles.decision} aria-label={t('replay.decision')}>
      {targets.length > 0 && <div><dt>{t('replay.targets')}</dt><dd><CardMarkdown text={targets.map(({ name }) => name).join(', ')} cards={targets.filter((target) => target.kind !== 'player')} /></dd></div>}
      {modes.length > 0 && <div><dt>{t('replay.choices')}</dt><dd>{modes.join(', ')}</dd></div>}
      {mana && <div><dt>{t('replay.manaPaid')}</dt><dd>{mana}</dd></div>}
    </dl>
  );
}


const choiceHeadings: Partial<Record<string, MessageKey>> = {
  target: 'replay.targets',
  mode: 'replay.context.modes',
  use: 'replay.context.confirmation',
  amount: 'replay.context.amount',
  pile: 'replay.context.piles',
  ability: 'replay.context.abilities',
  replacement: 'replay.context.replacements',
  discard: 'replay.context.discard',
  bottom: 'replay.context.bottom',
};

export function DecisionContext({ context, handDecision }: {
  context: ReviewDecisionContext;
  handDecision: boolean;
}) {
  const t = useT();
  const formatName = usePlayerNames();
  const choiceLabel = (value: string) => {
    const label = cleanDecisionText(value, t, formatName);
    if (context.choiceKind !== 'use') return label;
    if (/^yes$/i.test(label)) return t('replay.context.answerYes');
    if (/^no$/i.test(label)) return t('replay.context.answerNo');
    return label;
  };
  const selected = new Set(context.selectedIds ?? (context.selectedId ? [context.selectedId] : []));
  const selectedOptions = new Set(context.selectedOptionIds ?? []);
  const options = (context.optionDetails ?? []).flatMap((option) => {
    const label = choiceLabel(option.label ?? '');
    const card = option.playerId ? undefined : option.card;
    const chosen = selectedOptions.has(option.id) || selected.has(option.id) || (!!card?.id && selected.has(card.id));
    return card || label ? [{ id: option.id, label, card, chosen }] : [];
  });
  const optionCardIds = new Set(options.flatMap((option) => [option.id, option.card?.id]));
  const cards = (context.cards ?? []).filter((card) => !card.id || !optionCardIds.has(card.id));
  const labels = options.length === 0 ? (context.options ?? []).map(choiceLabel).filter(Boolean) : [];
  const prompt = context.prompt && cleanDecisionText(context.prompt, t, formatName);
  const selectedText = context.selectedText && choiceLabel(context.selectedText);
  const pass = context.passKind ? [
    t(`replay.context.pass.${context.passKind}`),
    ...(context.endsTurn ? [t('replay.context.endStep')] : []),
    ...(context.stackSize === undefined ? [] : [t('replay.context.stackSize', { count: context.stackSize })]),
    ...(context.playableCount === undefined ? [] : [t('replay.context.playableCount', { count: context.playableCount })]),
  ].join(' · ') : null;
  const chosenInList = options.some(({ chosen }) => chosen) || cards.some((card) => card.id && selected.has(card.id));
  const outcome = chosenInList ? null : context.declined ? t('replay.context.declined')
    : selectedText ? t('replay.context.selection', { choice: selectedText }) : null;
  const shownOptions = options.length + cards.length + labels.length;
  const partialOptions = context.optionCount !== undefined && context.optionCount > shownOptions
    ? t('replay.context.optionCoverage', { shown: shownOptions, count: context.optionCount }) : null;
  if (!shownOptions && !prompt && !pass && !outcome && !context.sourceCard && !partialOptions) return null;
  const heading = context.handKind === 'kept_hand' ? 'replay.context.keptHand'
    : choiceHeadings[context.choiceKind ?? ''] ?? (handDecision ? 'replay.context.openingHand' : 'replay.context.options');
  const title = t(heading);

  return (
    <section aria-label={title}>
      <h4>{title}</h4>
      {prompt && <p>{prompt}</p>}
      {pass && <p>{pass}</p>}
      {outcome && <p>{outcome}</p>}
      {context.sourceCard && <p>
        {t('replay.context.source')} <CardPreviewName card={context.sourceCard} />
      </p>}
      {shownOptions > 0 && (
        <ul className={styles.contextCards}>
          {options.map(({ id, card, label, chosen }) => (
            <ChoiceItem key={id} chosen={chosen}>
              {card && <CardPreviewName card={card} />}
              {card && label && label !== card.name && ' · '}
              {label && label !== card?.name && label}
            </ChoiceItem>
          ))}
          {cards.map((card, index) => (
            <ChoiceItem key={card.id ?? index} chosen={!!card.id && selected.has(card.id)}>
              {card.kind === 'player' ? replayName(card.name, t, formatName) : <CardPreviewName card={card} />}
            </ChoiceItem>
          ))}
          {labels.map((label, index) => <li key={`label-${index}`}>{label}</li>)}
        </ul>
      )}
      {partialOptions && <p>{partialOptions}</p>}
    </section>
  );
}

function ChoiceItem({ children, chosen }: { children: ReactNode; chosen: boolean }) {
  const t = useT();
  return <li data-selected={chosen || undefined}>
    {children}
    {chosen && <span className={styles.chosen}> · {t('replay.context.selected')}</span>}
  </li>;
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
  const formatName = usePlayerNames();
  const [first] = items;
  const markerName = (moment: RatedMoment) => t('replay.decisionMarker', {
    rating: t(`replay.rating.${moment.category}`),
    play: decisionPresentation(moment, t, formatName).fullTitle,
  });
  const style = { '--decision-position': `${fraction * 100}%` } as CSSProperties;
  if (items.length === 1) {
    const name = markerName(first);
    return <button type="button" data-replay-step-focus className={styles.marker} style={style}
      title={name} aria-label={name} aria-current={first.cursor === current ? 'step' : undefined} onClick={() => onMoment(first)}>
      <ReviewRating category={first.category} />
    </button>;
  }
  const label = t('replay.decisionCluster', { count: items.length });
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger type="button" data-replay-step-focus className={styles.marker} style={style} title={label}
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
            <span>{decisionPresentation(item, t, formatName).fullTitle}</span>
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
