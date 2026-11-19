import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useId } from 'react';
import { registerMessages, useT } from '../i18n';
import messages from '../i18n/en/replay';
import { Button, IconButton } from '../ui/Button';
import { reviewCategories, safePublicSource, type ReviewAnnotation, type ReviewCounts, type ReviewEvent, type ReviewSummary } from './reviewData';
import styles from './ReplayReviewPanel.module.css';

registerMessages(messages);

export function ReviewSwitch({ checked, label, onCheckedChange, controls }: {
  checked: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
  controls?: string;
}) {
  return (
    <button type="button" className={styles.switch} role="switch" aria-checked={checked} aria-controls={controls}
      onClick={() => onCheckedChange(!checked)}>
      <span className={styles.track} aria-hidden="true"><span /></span>
      {label}
    </button>
  );
}

export function RatingCounts({ counts }: { counts: ReviewCounts }) {
  const t = useT();
  const visibleRatings = reviewCategories.filter((category) => (counts[category] ?? 0) > 0);
  return visibleRatings.length ? (
    <dl className={styles.counts}>
      {visibleRatings.map((category) => (
        <div key={category}><dt>{t(`replay.rating.${category}`)}</dt><dd>{counts[category]}</dd></div>
      ))}
    </dl>
  ) : null;
}

export type ReviewMoment = Pick<ReviewEvent, 'cursor' | 'frameCursor' | 'turn' | 'text'>;

export function ReplayReviewPanel({ analysis, moments, current, annotation, actor, showRetrospective, onMoment, onPrevious, onNext, more, error, onRetry }: {
  analysis?: ReviewSummary;
  moments: readonly ReviewMoment[];
  current?: number;
  annotation?: ReviewAnnotation;
  actor?: string;
  showRetrospective: boolean;
  onMoment: (moment: ReviewMoment) => void;
  onPrevious?: () => void;
  onNext?: () => void;
  more?: { pending: boolean; load: () => void };
  error: boolean;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <div className={styles.panel}>
      {analysis && <p className={styles.muted}>
        {t(`replay.status.${analysis.status}`)}
        {!!analysis.eligible && ` · ${t('replay.reviewed', { reviewed: analysis.reviewed, eligible: analysis.eligible })}`}
      </p>}
      {error && (
        <div className={styles.problem}>
          <p role="alert">{t('replay.reviewError')}</p>
          <Button variant="quiet" size="sm" onClick={onRetry}>{t('replay.retry')}</Button>
        </div>
      )}
      {annotation && <ReviewDetail annotation={annotation} actor={actor} showRetrospective={showRetrospective} />}
      <nav className={styles.moments} aria-label={t('replay.moments')}>
        <div className={styles.momentHead}>
          <h3>{t('replay.moments')}</h3>
          <IconButton label={t('replay.previousMoment')} icon={<ChevronLeft size={18} />} onClick={onPrevious} disabled={!onPrevious} />
          <IconButton label={t('replay.nextMoment')} icon={<ChevronRight size={18} />} onClick={onNext} disabled={!onNext} />
        </div>
        {moments.length > 0 ? (
          <ol>
            {moments.map((moment) => (
              <li key={moment.cursor}>
                <button type="button" aria-current={moment.cursor === current ? 'step' : undefined} onClick={() => onMoment(moment)}>
                  {moment.turn === undefined ? moment.text : t('replay.moment', { turn: moment.turn, play: moment.text ?? '' })}
                </button>
              </li>
            ))}
          </ol>
        ) : !error && <p className={styles.muted}>{t('replay.emptyAnalysis')}</p>}
        {more && <Button size="sm" variant="quiet" busy={more.pending} onClick={more.load}>{t('replay.loadMore')}</Button>}
      </nav>
    </div>
  );
}

function ReviewDetail({ annotation, actor, showRetrospective }: {
  annotation: ReviewAnnotation;
  actor?: string;
  showRetrospective: boolean;
}) {
  const t = useT();
  const evidenceId = useId();
  const retrospective = typeof annotation.retrospective === 'string' ? annotation.retrospective
    : annotation.retrospective?.text ?? annotation.retrospective?.observation;
  return (
    <article className={styles.detail}>
      <p className={styles.rating} data-rating={annotation.category}>{t(`replay.rating.${annotation.category}`)}</p>
      <h3>{annotation.actual.text}</h3>
      <p className={styles.muted}>{[actor, t(`replay.confidence.${annotation.confidence}`)].filter(Boolean).join(' · ')}</p>
      <section aria-labelledby={evidenceId} className={styles.evidence}>
        <h4 id={evidenceId}>{t('replay.before')}</h4>
        {annotation.rationale && <p>{annotation.rationale}</p>}
        <p className={styles.muted}>{annotation.evidence?.turn === undefined ? t('replay.beforeWithoutTurn')
          : t('replay.beforeAt', { turn: annotation.evidence.turn })}</p>
        <ReviewTradeoff benefit={annotation.benefit} risk={annotation.risk} />
      </section>
      {!!annotation.alternatives.length && (
        <section>
          <h4>{t('replay.alternatives')}</h4>
          <ul className={styles.evidenceList}>
            {annotation.alternatives.map((item) => (
              <li key={item.line}><strong>{item.line}</strong>
                <ReviewTradeoff benefit={item.benefit} risk={item.risk} condition={item.condition} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {!!annotation.opponentResponses?.length && (
        <section>
          <h4>{t('replay.responses')}</h4>
          <ul className={styles.evidenceList}>
            {annotation.opponentResponses.map((response) => <li key={response.line}>
              <span className={styles.muted}>{t(response.basis === 'public_observed' ? 'replay.observed' : 'replay.plausible')} · </span>
              {response.line}{response.impact && <p>{response.impact}</p>}
            </li>)}
          </ul>
        </section>
      )}
      {showRetrospective && retrospective && (
        <section className={styles.retrospective}>
          <h4>{t('replay.retrospective')}</h4><p>{retrospective}</p>
        </section>
      )}
      {!!annotation.sources?.length && (
        <section>
          <h4>{t('replay.sources')}</h4>
          <ul className={styles.evidenceList}>
            {annotation.sources.flatMap((source) => {
              const href = safePublicSource(source.url);
              return href ? [<li key={href}><a href={href} target="_blank" rel="noopener noreferrer">
                {source.date && source.format ? t('replay.source', { host: new URL(href).host, date: source.date, format: source.format }) : new URL(href).host}
              </a>{source.applicability && <p>{source.applicability}</p>}</li>] : [];
            })}
          </ul>
        </section>
      )}
    </article>
  );
}

function ReviewTradeoff({ benefit, risk, condition }: { benefit?: string; risk?: string; condition?: string }) {
  const t = useT();
  return benefit || risk || condition ? (
    <dl className={styles.tradeoff}>
      {benefit && <div><dt>{t('replay.benefit')}</dt><dd>{benefit}</dd></div>}
      {risk && <div><dt>{t('replay.risk')}</dt><dd>{risk}</dd></div>}
      {condition && <div><dt>{t('replay.condition')}</dt><dd>{condition}</dd></div>}
    </dl>
  ) : null;
}
