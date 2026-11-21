import { ChevronRight } from 'lucide-react';
import { formatNumber, useT } from '../i18n';
import type { PracticeStat, PracticeStats } from './practiceHistory';
import styles from './PracticeHistory.module.css';

function percent(wins: number, games: number) {
  return games > 0 ? formatNumber(wins / games, { style: 'percent', maximumFractionDigits: 0 }) : '—';
}

function DeckPerformance({ group, distinguish }: { group: PracticeStat; distinguish: boolean }) {
  const t = useT();
  const numbers = [
    [t('history.version'), group.deckVersion?.slice(0, 6)], [t('history.onPlay'), group.onPlay],
    [t('history.onDraw'), group.onDraw], [t('history.avgMulligans'), group.averageMulligans], [t('history.avgTurns'), group.averageTurns],
  ] as const;
  return <details className={styles.deck}>
    <summary>
      <span className={styles.deckName}>{group.deckName ?? t('history.noDeck')}{distinguish && <small>{group.format}{group.deckVersion && ` · ${group.deckVersion.slice(0, 6)}`}</small>}</span>
      <span className={styles.bar} aria-hidden="true"><i style={{ width: percentForCss(group) }} /></span>
      <span className={styles.fraction} title={t('history.wins')}>{formatNumber(group.wins)}/{formatNumber(group.games)}</span>
      <b>{percent(group.wins, group.games)}</b>
      <ChevronRight size={13} aria-hidden="true" />
    </summary>
    <dl className={styles.smallStats}>
      <div><dt>{t('history.format')}</dt><dd>{group.format}</dd></div>
      {numbers.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{typeof value === 'number' ? formatNumber(value, { maximumFractionDigits: 1 }) : value ?? '—'}</dd></div>)}
    </dl>
  </details>;
}

function percentForCss(group: PracticeStat) {
  return (group.games > 0 ? 100 * group.wins / group.games : 0) + '%';
}

export function HistoryOverview({ stats: { totals, groups } }: { stats: PracticeStats }) {
  const t = useT();
  const metrics = [
    [t('history.matches'), totals?.matches], [t('history.games'), totals?.games], [t('history.wins'), totals?.wins],
    [t('history.winRate'), totals && percent(totals.wins, totals.games)],
  ] as const;
  const nameCounts = new Map<string | null, number>();
  for (const group of groups) nameCounts.set(group.deckName, (nameCounts.get(group.deckName) ?? 0) + 1);
  const renderDeck = (group: PracticeStat) => <DeckPerformance key={JSON.stringify([group.format, group.deckVersion])}
    group={group} distinguish={nameCounts.get(group.deckName)! > 1} />;
  return <section aria-label={t('history.summary')} className={styles.overview}>
    <dl className={styles.metrics}>
      {metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{typeof value === 'number' ? formatNumber(value) : value ?? '—'}</dd></div>)}
    </dl>
    <div className={styles.chart}>
      <h2>{t('history.deckResults')}</h2>
      {groups.slice(0, 3).map(renderDeck)}
      {!groups.length && <p>{t('history.noDeckResults')}</p>}
      {groups.length > 3 && <details className={styles.moreDecks}><summary>{t('history.moreDecks', { count: groups.length })}</summary>{groups.slice(3).map(renderDeck)}</details>}
    </div>
  </section>;
}
