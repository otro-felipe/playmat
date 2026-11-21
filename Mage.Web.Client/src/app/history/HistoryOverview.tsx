import { ArrowUpRight } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '../ui/Button';
import { useT } from '../i18n';
import { analysisSearch, sample, rate, type Performance } from './performance';
import styles from './DeckAnalysis.module.css';

export function HistoryOverview({ data, format }: { data: Performance; format: string }) {
  const t = useT();
  const location = useLocation();
  const [expanded, setExpanded] = useState(false);
  const groups = data.groups.filter((group) => !format || group.format === format);
  const shown = expanded ? groups : groups.slice(0, 4);
  const matches = groups.reduce((total, group) => total + group.matches.total, 0);
  const games = groups.reduce((total, group) => total + group.games.total, 0);
  return <section aria-labelledby="history-archetypes" className={styles.landing}>
    <div className={styles.groupHead}>
      <h2 id="history-archetypes">{t('perf.byArchetype')}</h2>
      <p>{t('perf.finishedMatches', { count: matches })} · {t('perf.finishedGames', { count: games })}</p>
    </div>
    {groups.length === 0 && <p className={styles.hint}>{t('history.noDeckResults')}</p>}
    <div id="history-archetype-cards" className={styles.cards}>
      {shown.map((group) => <Link key={JSON.stringify([group.format, group.archetype])}
        className={styles.card} state={{ historySearch: location.search }}
        to={'/history/analysis?' + analysisSearch(group).toString()}>
        <span className={styles.eyebrow}>{group.format === 'Unknown' ? t('history.unreported') : group.format}</span>
        <strong className={styles.cardTitle}>{group.archetype || t('perf.unclassified')}</strong>
        <span className={styles.cardRate}>{rate(group.matches.wins, group.matches.total)}</span>
        <small>{t('perf.matchSample', { sample: sample(group.matches.wins, group.matches.total) })}</small>
        <ArrowUpRight size={18} aria-hidden="true" />
      </Link>)}
    </div>
    {groups.length > 4 && <Button size="sm" variant="quiet" aria-controls="history-archetype-cards" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {t(expanded ? 'perf.showLess' : 'perf.showAll', { count: groups.length })}
    </Button>}
  </section>;
}
