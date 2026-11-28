import * as Tooltip from '@radix-ui/react-tooltip';
import { Star } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../i18n';
import { archetypeIdentity, archetypeStyle } from './archetypeIdentity';
import styles from './Archetype.module.css';

type Size = 'sm' | 'md' | 'lg' | 'xl';

/** An archetype's emblem: its guild, clan or mana symbol on a disc in its own colors. */
export function ArchetypeMark({ name, colors, size = 'md', label }: {
  name?: string | null;
  colors?: readonly string[] | null;
  size?: Size;
  /** announces the colors (role img) where they add to the name beside it; otherwise the mark is decorative */
  label?: (colors: ReturnType<typeof archetypeIdentity>['colors']) => string;
}) {
  const identity = archetypeIdentity(name, colors);
  const text = label?.(identity.colors);
  return (
    <span className={styles.mark} data-size={size} data-unknown={identity.colors ? undefined : ''} style={archetypeStyle(identity.colors)}
      {...(text ? { role: 'img', 'aria-label': text, title: text } : { 'aria-hidden': true })}>
      <i className={`ms ${identity.icon}`} />
    </span>
  );
}

/** An archetype's emblem and name, with an optional line above it (a player's name). */
export function ArchetypeLabel({ name, colors, size = 'md', title, fallback, align = 'start' }: {
  name?: string | null;
  colors?: readonly string[] | null;
  size?: Size;
  /** a stronger line above the archetype, usually who played it */
  title?: ReactNode;
  /** shown when there is no archetype */
  fallback?: string;
  align?: 'start' | 'end';
}) {
  const label = name || fallback;
  return (
    <span className={styles.label} data-size={size} data-align={align}>
      <ArchetypeMark name={name} colors={colors} size={size} />
      <span className={styles.text}>
        {title && <span className={styles.title}>{title}</span>}
        {label && <span className={title ? styles.sub : styles.name}>{label}</span>}
      </span>
    </span>
  );
}

/** The judge's verdict on one game: a filled star for good quality, an empty one otherwise, its reason on hover. */
export function QualityMark({ good, reason, pending }: { good: boolean; reason?: string | null; pending?: boolean }) {
  const t = useT();
  const verdict = pending ? t('quality.pending') : t(good ? 'quality.good' : 'quality.poor');
  return (
    <Tooltip.Provider delayDuration={120}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button type="button" className={styles.quality} data-good={good || undefined} data-pending={pending || undefined}
            aria-label={reason ? `${verdict}. ${reason}` : verdict}>
            <Star size={16} aria-hidden="true" fill={good ? 'currentColor' : 'none'} />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className={styles.tip} side="top" sideOffset={6} collisionPadding={12}>
            <strong>{verdict}</strong>
            {reason ? <span>{reason}</span> : !pending && !good && <span>{t('quality.poorHint')}</span>}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
