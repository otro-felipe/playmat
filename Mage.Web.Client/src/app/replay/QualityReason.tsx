import { useId } from 'react';
import { useT } from '../i18n';
import { markdownBlocks } from '../ui/markdownBlocks';
import styles from './ReplayReviewPanel.module.css';

export function QualityReason({ good, reason }: { good: boolean; reason: string }) {
  const t = useT();
  const heading = useId();
  return (
    <section className={styles.detail} aria-labelledby={heading}>
      <h3 id={heading}>{t('replay.quality.heading')}</h3>
      <p className={styles.muted}>{t(good ? 'replay.quality.good' : 'replay.quality.poor')}</p>
      <QualityReasonText reason={reason} />
    </section>
  );
}

export function QualityReasonText({ reason }: { reason: string }) {
  return (
    <div className={styles.qualityReason}>
      {markdownBlocks(reason).map(({ kind, lines, start }, index) => {
        if (kind === 'p') return <p key={index}>{lines.join(' ')}</p>;
        const List = kind;
        return <List key={index} start={start}>{lines.map((line, item) => <li key={item}>{line}</li>)}</List>;
      })}
    </div>
  );
}
