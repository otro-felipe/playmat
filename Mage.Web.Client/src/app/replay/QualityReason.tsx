import { useId } from 'react';
import { useT } from '../i18n';
import styles from './ReplayReviewPanel.module.css';

type Block = { kind: 'p' | 'ul' | 'ol'; lines: string[]; start?: number };

function markdownBlocks(reason: string) {
  const blocks: Block[] = [];
  let current: Block | undefined;
  for (const raw of reason.split('\n')) {
    const line = raw.trim();
    if (!line) {
      current = undefined;
      continue;
    }
    const item = /^(?:[-+*]|(\d{1,9})[.)])\s+(.+)$/.exec(line);
    const kind = item ? item[1] ? 'ol' : 'ul' : 'p';
    if (current?.kind !== kind) {
      current = { kind, lines: [], ...(item?.[1] ? { start: Number(item[1]) } : {}) };
      blocks.push(current);
    }
    current.lines.push(item?.[2] ?? line);
  }
  return blocks;
}

export function QualityReason({ good, reason }: { good: boolean; reason: string }) {
  const t = useT();
  const heading = useId();
  return (
    <section className={styles.detail} aria-labelledby={heading}>
      <h3 id={heading}>{t('replay.quality.heading')}</h3>
      <p className={styles.muted}>{t(good ? 'replay.quality.good' : 'replay.quality.poor')}</p>
      <div className={styles.qualityReason}>
        {markdownBlocks(reason).map(({ kind, lines, start }, index) => {
          if (kind === 'p') return <p key={index}>{lines.join(' ')}</p>;
          const List = kind;
          return <List key={index} start={start}>{lines.map((line, item) => <li key={item}>{line}</li>)}</List>;
        })}
      </div>
    </section>
  );
}
