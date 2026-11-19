import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useId } from 'react';
import { registerMessages, useT } from '../i18n';
import messages from '../i18n/en/replay';
import { Button, IconButton } from '../ui/Button';
import { DecisionTitle, ReviewRating } from './ReplayDecision';
import { decisionPresentation } from './decisionPresentation';
import { reviewCategories, safePublicSource, type ReviewAnnotation, type ReviewCounts, type ReviewMoment, type ReviewSummary, type SideboardDelta } from './reviewData';
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
  const visibleRatings = new Map<string, number>();
  for (const category of reviewCategories) {
    const count = counts[category] ?? 0;
    const label = t(`replay.rating.${category}`);
    if (count) visibleRatings.set(label, (visibleRatings.get(label) ?? 0) + count);
  }
  return visibleRatings.size ? (
    <dl className={styles.counts}>
      {[...visibleRatings].map(([label, count]) => (
        <div key={label}><dt>{label}</dt><dd>{count}</dd></div>
      ))}
    </dl>
  ) : null;
}

export function ReplayReviewPanel({ analysis, sideboardDelta, moments, current, annotation, decision, showRetrospective, onMoment, onPrevious, onNext, loading, error, onRetry }: {
  analysis?: ReviewSummary;
  sideboardDelta?: SideboardDelta;
  moments: readonly ReviewMoment[];
  current?: number;
  annotation?: ReviewAnnotation;
  decision?: ReviewMoment;
  showRetrospective: boolean;
  onMoment: (moment: ReviewMoment) => void;
  onPrevious?: () => void;
  onNext?: () => void;
  loading: boolean;
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
      {decision && (annotation
        ? <ReviewDetail annotation={annotation} decision={decision} showRetrospective={showRetrospective} />
        : <article className={styles.detail}>
          <h3><DecisionTitle moment={decision} /></h3>
          <p className={styles.muted}>{t(loading ? 'replay.loadingAnalysis' : 'replay.pendingDecision')}</p>
        </article>)}
      {sideboardDelta && <OwnSideboard delta={sideboardDelta} />}
      <nav className={styles.moments} aria-label={t('replay.moments')}>
        <div className={styles.momentHead}>
          <h3>{t('replay.moments')}</h3>
          <IconButton label={t('replay.previousMoment')} icon={<ChevronLeft size={18} />} onClick={onPrevious} disabled={!onPrevious} />
          <IconButton label={t('replay.nextMoment')} icon={<ChevronRight size={18} />} onClick={onNext} disabled={!onNext} />
        </div>
        {moments.length > 0 ? (
          <ol>
            {moments.map((moment) => {
              const { fullTitle } = decisionPresentation(moment, t);
              return <li key={moment.cursor}>
                <button type="button" aria-current={moment.cursor === current ? 'step' : undefined} onClick={() => onMoment(moment)}>
                  {moment.category && <ReviewRating category={moment.category} />}
                  <span>{moment.turn === undefined ? fullTitle : t('replay.moment', { turn: moment.turn, play: fullTitle })}</span>
                </button>
              </li>;
            })}
          </ol>
        ) : !error && <p className={styles.muted}>{t(loading ? 'replay.loadingAnalysis' : 'replay.emptyAnalysis')}</p>}
      </nav>
    </div>
  );
}

function OwnSideboard({ delta }: { delta: SideboardDelta }) {
  const t = useT();
  const heading = useId();
  if (delta.status === 'initial_game') return null;
  return (
    <section className={styles.detail} aria-labelledby={heading}>
      <h3 id={heading}>{t('replay.sideboard.heading')}</h3>
      {delta.status === 'available' ? (
        <>
          <p className={styles.muted}>{t('replay.sideboard.games', { from: delta.fromGameNumber, to: delta.toGameNumber })}</p>
          {delta.broughtIn.length || delta.tookOut.length ? ([
            { label: 'replay.sideboard.in', cards: delta.broughtIn },
            { label: 'replay.sideboard.out', cards: delta.tookOut },
          ] as const).map(({ label, cards }) => cards.length > 0 && (
            <div key={label}>
              <h4>{t(label)}</h4>
              <ul className={styles.evidenceList}>
                {cards.map(({ name, amount }) => <li key={name}>{amount} × {name}</li>)}
              </ul>
            </div>
          )) : <p>{t('replay.sideboard.empty')}</p>}
        </>
      ) : <p className={styles.muted}>{t('replay.sideboard.unavailable')}</p>}
    </section>
  );
}

const studyIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function ReviewDetail({ annotation, decision, showRetrospective }: {
  annotation: ReviewAnnotation;
  decision: ReviewMoment;
  showRetrospective: boolean;
}) {
  const t = useT();
  const retrospective = typeof annotation.retrospective === 'string' ? annotation.retrospective
    : annotation.retrospective?.text ?? annotation.retrospective?.observation;
  const studies = annotation.theoryStudies?.filter(({ studyId, tool }) => tool === 'get_theory_study' && studyIdPattern.test(studyId)) ?? [];
  return (
    <article className={styles.detail}>
      <h3><DecisionTitle moment={decision} /></h3>
      <p><ReviewRating category={annotation.category} label /></p>
      {annotation.rationale && <p>{annotation.rationale}</p>}
      <ReviewTradeoff benefit={annotation.benefit} risk={annotation.risk} />
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
      {studies.length > 0 && (
        <section>
          <h4>{t('replay.theoryStudies')}</h4>
          <ul className={styles.evidenceList}>
            {studies.map(({ studyId }, index) => (
              <li key={studyId}>
                <a href={`/api/playtesting/theory/studies/${studyId}`} download={`theory-study-${studyId}.json`}>
                  {t('replay.downloadStudy', { number: index + 1 })}
                </a>
              </li>
            ))}
          </ul>
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
