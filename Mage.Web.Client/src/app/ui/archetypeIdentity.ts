import type { CSSProperties } from 'react';
import { archetypeColors } from '../../core/decks/archetypes/library.mjs';

export type ManaColor = 'W' | 'U' | 'B' | 'R' | 'G';
const order: ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

const guilds: Record<string, string> = {
  WU: 'azorius', UB: 'dimir', BR: 'rakdos', RG: 'gruul', WG: 'selesnya',
  WB: 'orzhov', UR: 'izzet', BG: 'golgari', WR: 'boros', UG: 'simic',
};
const clans: Record<string, string> = { WBG: 'abzan', WUR: 'jeskai', WBR: 'mardu', UBG: 'sultai', URG: 'temur' };

export interface ArchetypeIdentity {
  /** the archetype's own colors in WUBRG order; empty when colorless, null when its name carries none */
  colors: ManaColor[] | null;
  /** mana-font class of its emblem: a guild or clan watermark, a mana symbol, or a neutral mark */
  icon: string;
}

/**
 * How an archetype is drawn: in the colors of its name (Boros, Mono-Red, Devotion to Green), never in the colors its
 * list's cards happen to carry. `fallback` is used only when the name says nothing (Humans, Copycat).
 */
export function archetypeIdentity(name?: string | null, fallback?: readonly string[] | null): ArchetypeIdentity {
  const named = archetypeColors(name);
  const raw = named ?? fallback ?? null;
  const colors = raw ? order.filter((c) => raw.includes(c)) : null;
  const key = colors?.join('') ?? '';
  const icon = !colors
    ? 'ms-multicolor'
    : colors.length === 0
      ? 'ms-c'
      : colors.length === 1
        ? 'ms-' + key.toLowerCase()
        : guilds[key]
          ? 'ms-guild-' + guilds[key]
          : clans[key]
            ? 'ms-clan-' + clans[key]
            : 'ms-multicolor';
  return { colors, icon };
}

const tone = (c: ManaColor | 'C') => `var(--arch-${c.toLowerCase()})`;

/** The colors as CSS stops: one color is flat, several blend left to right. */
export function archetypeStops(colors: readonly ManaColor[] | null): string[] {
  if (!colors) return ['var(--ink-faint)'];
  if (!colors.length) return [tone('C')];
  return colors.map(tone);
}

/** CSS custom properties for a surface tinted by one archetype (`--tint`) or two facing ones (`--rival`). */
export function archetypeStyle(a: readonly ManaColor[] | null, b?: readonly ManaColor[] | null): CSSProperties {
  const left = archetypeStops(a);
  const style: Record<string, string> = {
    '--tint': left[0],
    '--tint-end': left.at(-1)!,
    '--tint-gradient': left.length > 1 ? `linear-gradient(135deg, ${left.join(', ')})` : left[0],
  };
  if (b !== undefined) {
    const right = archetypeStops(b);
    style['--rival'] = right.at(-1)!;
    style['--rival-start'] = right[0];
    style['--rival-gradient'] = right.length > 1 ? `linear-gradient(135deg, ${right.join(', ')})` : right[0];
  }
  return style as CSSProperties;
}
