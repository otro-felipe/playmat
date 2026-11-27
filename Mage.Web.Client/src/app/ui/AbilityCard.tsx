import type { CSSProperties } from 'react';
import { useCardImage } from '../../core/images/useCardImage';
import { showsBackFace } from '../../core/images/imageLinks';
import { stripMarkup } from '../../core/game/prompt';
import { splitRules } from '../../core/game/glossary';
import type { CardView, StackAbilityView } from '../../protocol/generated/views';
import { useT, type MessageKey } from '../i18n';
import { PromptText } from './PromptText';
import styles from './AbilityCard.module.css';

function kindOf(card: CardView): MessageKey {
  if (card.stackAbility?.kind === 'triggered') return 'ui.ability.triggered';
  if (card.stackAbility?.kind === 'activated') return 'ui.ability.activated';
  const type = card.abilityType ?? '';
  if (type.startsWith('TRIGGERED')) return 'ui.ability.triggered';
  if (type.startsWith('ACTIVATED')) return 'ui.ability.activated';
  return 'ui.ability';
}

/**
 * An ability on the stack, printed as its own card: the source's art and name, what kind of ability it is, and its
 * text. It never depends on a full card picture, so it reads even when the source has none.
 */
export function AbilityCard({ ability, sleeve, style, className, presentation = 'card' }: {
  ability: CardView;
  sleeve?: string;
  style?: CSSProperties;
  className?: string;
  presentation?: 'card' | 'broadcast';
}) {
  const t = useT();
  const compact = presentation === 'broadcast';
  const source: CardView | undefined = compact || ability.stackAbility ? ability.stackAbility?.source : (ability as StackAbilityView).sourceCard;
  const art = useCardImage(!compact && source?.expansionSetCode ? source : null, source && showsBackFace(source) ? 'back' : 'front', 'art_crop');
  const name = source?.displayName ?? source?.name ?? t('ui.ability');
  // the server's live hints follow the rules with an icon name in front ("ICON_GOOD..."): print them as plain lines (#173)
  const { rules, hints } = splitRules(ability);
  const text = compact ? [ability.stackAbility?.effect ?? t('ui.ability.effectUnavailable')]
    : ability.stackAbility ? [ability.stackAbility.effect].filter((line): line is string => !!line)
    : [...rules.map(stripMarkup), ...hints.map((hint) => hint.text)].filter(Boolean);
  return (
    <div className={[styles.sleeve, compact ? styles.broadcast : '', className ?? ''].join(' ')} style={{ ...(sleeve ? { '--sleeve': sleeve } : {}), ...style } as CSSProperties}>
      <div className={styles.card}>
        <div className={styles.title}>{name}</div>
        {!compact && <div className={styles.art} style={typeof art === 'string' ? { backgroundImage: `url("${art}")` } : undefined} />}
        <div className={styles.kind}>{t(kindOf(ability))}</div>
        <div className={styles.text}>
          {text.slice(0, 4).map((line, index) => <p key={index}><PromptText text={line} /></p>)}
        </div>
      </div>
    </div>
  );
}
