import { usePlayerNames } from '../ui/usePlayerIdentity';
import { useMemo, useRef, type CSSProperties } from 'react';
import type { CardView, GameView } from '../../protocol/generated/views';
import { publicCardName, publicTargetLabels } from '../../core/game/publicTargets';
import { isStackAbility } from '../../core/game/cards';
import { stackSourceId } from '../../core/game/promptSource';
import { roomCastDoor } from '../../core/game/rooms';
import { useT } from '../i18n';
import { AbilityCard } from '../ui/AbilityCard';
import { CardFace } from '../ui/CardFace';
import { zoneKeys } from './boardModel';
import { useFlip } from './flip';
import { useMatchUi } from './matchUi';
import { seatAlias, type SeatDisplayNames } from './seatDisplayNames';
import { useStage } from './stageContext';
import styles from './StackZone.module.css';

export interface StackZoneProps {
  /** top of the stack first */
  items: CardView[];
  view?: GameView | null;
  presentation?: 'table' | 'broadcast';
  seatDisplayNames?: SeatDisplayNames;
  clickable: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  sleeveOf(card: CardView): string;
  onClick(id: string): void;
  /** opponents' spells fly in from their hidden hand */
  originOf(card: CardView): string | undefined;
}

/** Spells and abilities waiting to resolve, stacked at the right of the table; the top one resolves first. */
export function StackZone({ items, view = null, presentation = 'table', seatDisplayNames, clickable, selected, sleeveOf, onClick, originOf }: StackZoneProps) {
  // a spell keeps its card's identity (abilities have no card of their own): it is the card that left the hand
  const keys = useMemo(() => zoneKeys(items.map((item) => (isStackAbility(item) ? { id: item.id } : item))), [items]);
  const formatName = usePlayerNames();
  const { scale } = useStage();
  const compact = presentation === 'broadcast' && items.some(isStackAbility);
  const textScale = compact ? { '--stack-readable-text': `${Math.max(18, Math.ceil(13 / scale))}px` } as CSSProperties : undefined;
  const targets = useMemo(() => items.map((item) => publicTargetLabels(item, view).map((label) => formatName(label, seatAlias(label, seatDisplayNames)))), [items, view, seatDisplayNames, formatName]);
  if (items.length === 0) return null;
  return (
    <section className={[styles.zone, compact ? styles.broadcast : ''].join(' ')} style={textScale}
      aria-label={`Stack, ${items.length} ${items.length === 1 ? 'object' : 'objects'}`}>
      <h2 className={styles.label}>Stack</h2>
      <ol className={styles.list}>
        {items.map((item, index) => (
          <StackItem
            key={keys[index]}
            item={item}
            index={index}
            total={items.length}
            clickable={clickable.has(item.id!)}
            selected={selected.has(item.id!)}
            sleeve={sleeveOf(item)}
            compact={compact}
            onClick={onClick}
            origin={originOf(item)}
            targets={targets[index]}
          />
        ))}
      </ol>
    </section>
  );
}

function StackItem({ item, index, total, clickable, selected, sleeve, compact, onClick, origin, targets }: {
  item: CardView;
  index: number;
  total: number;
  clickable: boolean;
  selected: boolean;
  sleeve: string;
  compact: boolean;
  onClick(id: string): void;
  origin: string | undefined;
  targets: string[];
}) {
  const t = useT();
  const ref = useRef<HTMLLIElement>(null);
  const setZoom = useMatchUi((state) => state.setZoom);
  const setSourceHover = useMatchUi((state) => state.setSourceHover);
  const setStackFocus = useMatchUi((state) => state.setStackFocus);
  const focused = useMatchUi((state) => state.stackFocus === item.id);
  const ability = isStackAbility(item) ? item : null;
  const face = ability?.sourceCard ?? item;
  const door = roomCastDoor(item);
  const castLabel = door ? t('match.room.casting', { name: door }) : null;
  const next = index === 0 && <span className={styles.next}>Resolving next</span>;
  const effect = item.faceDown || item.hideInfo ? undefined : item.stackAbility?.effect
    ?? (compact && ability ? t('ui.ability.effectUnavailable') : undefined);
  useFlip(ability ? item.id : (item.cardId ?? item.id), ref, { fallbackOrigin: origin });

  return (
    <li
      ref={ref}
      className={[styles.item, index === 0 ? styles.top : '', clickable ? styles.clickable : '', selected ? styles.selected : '', focused ? styles.focused : ''].join(' ')}
      style={{ zIndex: total - index, ['--i' as string]: index }}
      onPointerEnter={(event) => {
        setZoom({ card: item, x: event.clientX, y: event.clientY, sleeve });
        // an ability marks the permanent it comes from: which of two Guiding Hydras it belongs to (#227)
        setSourceHover(stackSourceId(item));
        setStackFocus(item.id ?? null);
      }}
      onPointerLeave={() => {
        setZoom(null);
        setSourceHover(null);
        if (!ref.current?.contains(document.activeElement)) setStackFocus(null);
      }}
      tabIndex={0}
      onFocus={() => setStackFocus(item.id ?? null)}
      onBlur={() => setStackFocus(null)}
      onClick={() => clickable && onClick(item.id!)}
      data-object-id={item.id}
      aria-label={`${castLabel ?? publicCardName(item)}${effect ? `: ${effect}` : ''}${index === 0 ? ', resolves next' : ''}${targets.length ? `, targets: ${targets.join(', ')}` : ''}`}
    >
      {compact && next}
      {ability ? <AbilityCard ability={item} sleeve={sleeve} presentation={compact ? 'broadcast' : 'card'} />
        : compact ? <div className={styles.broadcastSpell}>{castLabel ?? publicCardName(item)}</div>
          : <CardFace card={face} sleeve={sleeve} size="normal" />}
      {!compact && (castLabel ? <div className={styles.roomStatus}><span>{castLabel}</span>{next}</div> : next)}
      <span className={styles.arrowOrigin} data-stack-arrow-origin={item.id} aria-hidden="true" />
    </li>
  );
}
