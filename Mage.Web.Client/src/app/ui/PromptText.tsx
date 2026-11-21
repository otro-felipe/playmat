import { formatEngineText } from './playerIdentity';
import { usePlayerNames } from './usePlayerIdentity';
import { Fragment } from 'react';
import { manaClass } from './mana';
import { cleanText } from './text';

/**
 * Server text with its mana symbols drawn ("Pay {G}{1}") and internal object ids ("[32a]") removed.
 * Expects text already stripped of markup.
 */
export function PromptText({ text }: { text: string }) {
  const format = usePlayerNames();
  const clean = cleanText(formatEngineText(text, format));
  const parts = clean.split(/(\{[^}]+\})/g).filter(Boolean);
  return (
    <>
      {parts.map((part, index) => {
        const symbol = /^\{([^}]+)\}$/.exec(part)?.[1];
        if (!symbol) return <Fragment key={index}>{part}</Fragment>;
        return <i key={index} className={`ms ms-cost ms-${manaClass(symbol)}`} role="img" aria-label={symbol} style={{ fontSize: '0.85em', margin: '0 0.08em' }} />;
      })}
    </>
  );
}
