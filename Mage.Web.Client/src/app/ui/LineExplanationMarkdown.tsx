import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { CardPreviewName } from './CardMarkdown';
import { cardTarget } from './cardPreviewTarget';
import { markdownBlocks } from './markdownBlocks';
import styles from './LineExplanationMarkdown.module.css';

const markup = /(?<escaped>\\[\\\x60*_[\]()#!])|(?<image>!?)\[(?<label>[^[\]\n]+)\]\((?<url>[^()\n]*)\)|(?<strong>\*\*|__)(?<bold>\S[^\n]*?)\k<strong>|(?<emphasis>\*|_)(?<italic>[^*_\s][^\n]*?)\k<emphasis>|\x60(?<code>[^\x60\n]+)\x60/g;

function plainText(children: ReactNode): string {
  return Children.toArray(children).map((child) => {
    if (typeof child === 'string') return child;
    return isValidElement<{ children?: ReactNode }>(child) ? plainText(child.props.children) : '';
  }).join('');
}

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(markup)) {
    const key = match.index;
    const { escaped, image, label, url, bold, italic, code } = match.groups ?? {};
    parts.push(text.slice(offset, key));
    if (escaped !== undefined) {
      parts.push(escaped.slice(1));
    } else if (label !== undefined) {
      const target = image ? undefined : cardTarget(url);
      const content = inline(label);
      parts.push(target
        ? <CardPreviewName key={key} card={target} label={plainText(content)} face={target.face}>{content}</CardPreviewName>
        : <Fragment key={key}>{content}</Fragment>);
    } else if (bold !== undefined) {
      parts.push(<strong key={key}>{inline(bold)}</strong>);
    } else if (italic !== undefined) {
      parts.push(<em key={key}>{inline(italic)}</em>);
    } else if (code !== undefined) {
      parts.push(<code key={key}>{code}</code>);
    }
    offset = key + match[0].length;
  }
  parts.push(text.slice(offset));
  return parts;
}

/** Render tactical commentary as Markdown text with the app's own card previews. */
export function LineExplanationMarkdown({ text }: { text: string }) {
  return (
    <div className={styles.commentary}>
      {markdownBlocks(text, true).map(({ kind: Block, lines, start }, index) => {
        if (Block === 'ol' || Block === 'ul') {
          return <Block key={index} start={start}>{lines.map((line, item) => <li key={item}>{inline(line)}</li>)}</Block>;
        }
        return <Block key={index}>{inline(lines.join('\n'))}</Block>;
      })}
    </div>
  );
}
