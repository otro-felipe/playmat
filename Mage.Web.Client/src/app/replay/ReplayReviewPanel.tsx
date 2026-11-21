import { usePlayerNames } from '../ui/usePlayerIdentity';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { registerMessages, useT } from '../i18n';
import messages from '../i18n/en/replay';
import { CardMarkdown, CardPreviewName, type PreviewCard } from '../ui/CardMarkdown';
import { Button, IconButton } from '../ui/Button';
import { DecisionContext, DecisionTitle, ReviewRating } from './ReplayDecision';
import { decisionPresentation } from './decisionPresentation';
import { reviewCategories, safePublicSource, type ReviewAnnotation, type ReviewCounts, type ReviewDecisionContext, type ReviewMoment, type ReviewSummary, type SideboardDelta } from './reviewData';
import styles from './ReplayReviewPanel.module.css';

registerMessages(messages);

export { Switch as ReviewSwitch } from '../ui/Switch';

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

export function ReplayReviewPanel({ analysis, sideboardDelta, moments, current, annotation, decision, decisionContexts, missingDecisionHand, showRetrospective, onMoment, onPrevious, onNext, loading, error, onRetry }: {
  analysis?: ReviewSummary;
  sideboardDelta?: SideboardDelta;
  moments: readonly ReviewMoment[];
  current?: number;
  annotation?: ReviewAnnotation;
  decision?: ReviewMoment;
  decisionContexts: ReviewDecisionContext[];
  missingDecisionHand: boolean;
  showRetrospective: boolean;
  onMoment: (moment: ReviewMoment) => void;
  onPrevious?: () => void;
  onNext?: () => void;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const t = useT();
  const formatName = usePlayerNames();
  const handDecision = decision?.actual?.kind === 'mulligan' || decision?.actual?.kind === 'keep';
  const cards = [
    ...moments.flatMap((moment) => decisionPresentation(moment, t, formatName).cards),
    ...decisionContexts.flatMap((step) => [
      ...(step.cards ?? []), ...(step.sourceCard ? [step.sourceCard] : []),
      ...(step.optionDetails ?? []).flatMap((option) => !option.playerId && option.card ? [option.card] : []),
    ].filter((card) => card.kind !== 'player')),
  ];
  const context = <>
    {decisionContexts.map((step, index) => <DecisionContext key={step.id ?? index} context={step} handDecision={handDecision} />)}
    {missingDecisionHand && <p className={styles.muted}>{t('replay.context.missingHand')}</p>}
  </>;
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
        ? <ReviewDetail cards={cards} annotation={annotation} decision={decision} context={context} showRetrospective={showRetrospective} />
        : <article className={styles.detail}>
          <h3><DecisionTitle moment={decision} /></h3>
          <p className={styles.muted}>{t(loading ? 'replay.loadingAnalysis' : 'replay.pendingDecision')}</p>
          {context}
        </article>)}
      {sideboardDelta && <OwnSideboard delta={sideboardDelta} />}
      <nav className={styles.moments} aria-label={t('replay.moments')}>
        <div className={styles.momentHead}>
          <h3>{t('replay.moments')}</h3>
          <IconButton data-replay-step-focus label={t('replay.previousMoment')} icon={<ChevronLeft size={18} />} onClick={onPrevious} disabled={!onPrevious} />
          <IconButton data-replay-step-focus label={t('replay.nextMoment')} icon={<ChevronRight size={18} />} onClick={onNext} disabled={!onNext} />
        </div>
        {moments.length > 0 ? (
          <ol>
            {moments.map((moment) => {
              const { fullTitle } = decisionPresentation(moment, t, formatName);
              return <li key={moment.cursor}>
                <button type="button" data-replay-step-focus aria-current={moment.cursor === current ? 'step' : undefined} onClick={() => onMoment(moment)}>
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
                {cards.map(({ name, amount }) => <li key={name}>{amount} × <CardPreviewName card={{ name }} /></li>)}
              </ul>
            </div>
          )) : <p>{t('replay.sideboard.empty')}</p>}
        </>
      ) : <p className={styles.muted}>{t('replay.sideboard.unavailable')}</p>}
    </section>
  );
}

const studyIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function ReviewDetail({ annotation, decision, context, showRetrospective, cards }: {
  annotation: ReviewAnnotation;
  decision: ReviewMoment;
  context: ReactNode;
  cards: PreviewCard[];
  showRetrospective: boolean;
}) {
  const t = useT();
  const prose = (text: string) => <CardMarkdown text={text} cards={cards} />;
  const retrospective = typeof annotation.retrospective === 'string' ? annotation.retrospective
    : annotation.retrospective?.text ?? annotation.retrospective?.observation;
  const studies = annotation.theoryStudies?.filter(({ studyId, tool }) => tool === 'get_theory_study' && studyIdPattern.test(studyId)) ?? [];
  return (
    <article className={styles.detail}>
      <h3><DecisionTitle moment={decision} /></h3>
      <p className={styles.ratingLine}>
        <ReviewRating category={annotation.category} label />
        <span className={styles.muted}>{t(`replay.confidence.${annotation.confidence}`)}</span>
      </p>
      {annotation.rationale && <p>{prose(annotation.rationale)}</p>}
      <ReviewTradeoff cards={cards} benefit={annotation.benefit} risk={annotation.risk} />
      {!!annotation.alternatives.length && (
        <section>
          <h4>{t('replay.alternatives')}</h4>
          <ul className={styles.evidenceList}>
            {annotation.alternatives.map((item) => (
              <li key={item.line}><strong>{prose(item.line)}</strong>
                <ReviewTradeoff cards={cards} benefit={item.benefit} risk={item.risk} condition={item.condition} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {annotation.evidence?.basis === 'inferred_omission' && <p className={styles.muted}>{t('replay.context.inferred')}</p>}
      {annotation.evidence?.observation && <p className={styles.muted}>{prose(annotation.evidence.observation)}</p>}
      {context}
      {!!annotation.opponentResponses?.length && (
        <section>
          <h4>{t('replay.responses')}</h4>
          <ul className={styles.evidenceList}>
            {annotation.opponentResponses.map((response) => <li key={response.line}>
              <span className={styles.muted}>{t(response.basis === 'public_observed' ? 'replay.observed' : 'replay.plausible')} · </span>
              {prose(response.line)}{response.impact && <p>{prose(response.impact)}</p>}
            </li>)}
          </ul>
        </section>
      )}
      {showRetrospective && retrospective && (
        <section className={styles.retrospective}>
          <h4>{t('replay.retrospective')}</h4><p>{prose(retrospective)}</p>
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
              </a>{source.applicability && <p>{prose(source.applicability)}</p>}</li>] : [];
            })}
          </ul>
        </section>
      )}
    </article>
  );
}

function ReviewTradeoff({ benefit, risk, condition, cards }: { cards: PreviewCard[]; benefit?: string; risk?: string; condition?: string }) {
  const t = useT();
  return benefit || risk || condition ? (
    <dl className={styles.tradeoff}>
      {benefit && <div><dt>{t('replay.benefit')}</dt><dd><CardMarkdown text={benefit} cards={cards} /></dd></div>}
      {risk && <div><dt>{t('replay.risk')}</dt><dd><CardMarkdown text={risk} cards={cards} /></dd></div>}
      {condition && <div><dt>{t('replay.condition')}</dt><dd><CardMarkdown text={condition} cards={cards} /></dd></div>}
    </dl>
  ) : null;
}
