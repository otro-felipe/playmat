import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useState } from 'react';
import { useT, formatNumber } from '../i18n';
import { sample, rate, type Outcome, type Performance } from './performance';
import styles from './DeckAnalysis.module.css';

function Headline({ label, outcome, primary }: { label: string; outcome: Outcome; primary?: boolean }) {
  const t = useT();
  return <section aria-label={label} className={styles.headline} data-primary={primary}>
    <h2>{label}</h2><strong>{rate(outcome.wins, outcome.total)}</strong>
    <span>{sample(outcome.wins, outcome.total)} · {t('perf.record', { wins: outcome.wins, losses: outcome.losses, draws: outcome.draws })}</span>
  </section>;
}

function ResultsTable({ title, caption, dimension, rows, losses = false, sortable = false }: {
  title: string; caption?: string; dimension: string; losses?: boolean; sortable?: boolean; rows: { label: string; games: Outcome }[];
}) {
  const t = useT();
  type SortKey = 'sample' | 'rate';
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({ key: 'sample', ascending: false });
  const numerator = (record: Outcome) => losses ? record.losses : record.wins;
  const value = (record: Outcome) => sort.key === 'sample' ? record.total : numerator(record) / (record.total || 1);
  const ordered = sortable ? rows.slice().sort((a, b) =>
    (value(b.games) - value(a.games)) * (sort.ascending ? -1 : 1) || b.games.total - a.games.total || a.label.localeCompare(b.label)) : rows;
  function column(key: SortKey, label: string) {
    if (!sortable) return <th scope="col">{label}</th>;
    const active = sort.key === key;
    const Icon = active ? (sort.ascending ? ArrowUp : ArrowDown) : ArrowUpDown;
    return <th scope="col" aria-sort={active ? (sort.ascending ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className={styles.sort} title={key === 'sample' ? t('perf.sortSample') : undefined} onClick={() => setSort({ key, ascending: active && !sort.ascending })}>
        {label}<Icon size={12} aria-hidden="true" />
      </button>
    </th>;
  }
  return <section className={styles.results}>
    <h2>{title}</h2>
    {caption && <p className={styles.hint}>{caption}</p>}
    {rows.length === 0 ? <p className={styles.empty}>{t('perf.noData')}</p> :
      <table aria-label={title}><thead><tr>
        <th scope="col">{dimension}</th>{column('sample', t(losses ? 'perf.gamesLost' : 'perf.gamesWon'))}
        {column('rate', t(losses ? 'perf.lossRate' : 'history.winRate'))}
      </tr></thead><tbody>
        {ordered.map(({ label, games }) => {
          const count = numerator(games);
          return <tr key={label}><th scope="row">{label}</th><td>{sample(count, games.total)}</td><td>{rate(count, games.total)}</td></tr>;
        })}
      </tbody></table>}
  </section>;
}

export function AnalysisOverview({ data, bo1 }: { data: Performance; bo1: boolean }) {
  const t = useT();
  const { splits, summary } = data;
  return <>
    <div className={styles.headlines}>
      <Headline label={t('perf.matchesWon')} outcome={summary.matches} primary />
      {!bo1 && <Headline label={t('perf.gamesWon')} outcome={summary.games} />}
    </div>
    <div className={styles.panels}>
      {!bo1 && <ResultsTable title={t('perf.sideboard')} dimension={t('perf.stage')} rows={[
        { label: t('perf.preboard'), games: splits.preboard }, { label: t('perf.postboard'), games: splits.postboard },
      ]} />}
      <ResultsTable title={t('perf.turnOrder')} dimension={t('perf.start')} rows={[
        { label: t('history.onPlay'), games: splits.play }, { label: t('history.onDraw'), games: splits.draw },
      ]} />
    </div>
  </>;
}

export function MulliganResults({ data }: { data: Performance }) {
  const t = useT();
  return <div className={styles.sections}>
    <ResultsTable sortable title={t('perf.openingCards')} dimension={t('perf.card')}
      caption={t('perf.keptCoverage', { known: data.coverage.keptHands, total: data.coverage.games })}
      rows={data.openingCards.map(({ card, games }) => ({ label: card, games }))} />
    <ResultsTable title={t('perf.byMulligans')} dimension={t('perf.mulligan')}
      rows={data.mulligans.map(({ count, games }) => ({ label: formatNumber(count), games }))} />
  </div>;
}

function Fraction({ outcome }: { outcome: Outcome }) {
  return <>{rate(outcome.wins, outcome.total)} <small>({sample(outcome.wins, outcome.total)})</small></>;
}

export function MatchupResults({ data, bo1 }: { data: Performance; bo1: boolean }) {
  const t = useT();
  return <div className={styles.sections}>
    <section className={styles.results}>
      <h2>{t('perf.vsArchetypes')}</h2>
      {!data.matchups.length ? <p className={styles.empty}>{t('perf.noData')}</p> :
        <table aria-label={t('perf.vsArchetypes')}><thead><tr><th scope="col">{t('perf.opponent')}</th>
          <th scope="col">{t('perf.matchesWon')}</th>{!bo1 && <th scope="col">{t('perf.gamesWon')}</th>}
        </tr></thead><tbody>{data.matchups.map((item) => <tr key={JSON.stringify(item.archetype)}>
          <th scope="row">{item.archetype ?? t('perf.unclassified')}</th><td><Fraction outcome={item.matches} /></td>
          {!bo1 && <td><Fraction outcome={item.games} /></td>}
        </tr>)}</tbody></table>}
    </section>
    <section className={styles.results}>
      <h2>{t('perf.rivalMulligans')}</h2>
      {!data.matchups.length ? <p className={styles.empty}>{t('perf.noData')}</p> :
        <table aria-label={t('perf.rivalMulligans')}><thead><tr><th scope="col">{t('perf.opponent')}</th>
          <th scope="col">{t('perf.yours')}</th><th scope="col">{t('perf.theirs')}</th></tr></thead>
          <tbody>{data.matchups.map(({ archetype, mulligans }) => <tr key={JSON.stringify(archetype)}>
            <th scope="row">{archetype ?? t('perf.unclassified')}</th>
            <td>{mulligans.known ? sample(mulligans.taken, mulligans.known) : '—'}</td>
            <td>{mulligans.opponentKnown ? sample(mulligans.opponentTaken, mulligans.opponentKnown) : '—'}</td>
          </tr>)}</tbody></table>}
    </section>
    <ResultsTable sortable losses title={t('perf.opponentCards')} dimension={t('perf.card')}
      caption={t('perf.cardCoverage', { known: data.coverage.opponentCards, total: data.coverage.games })}
      rows={data.opponentCards.map(({ card, games }) => ({ label: card, games }))} />
  </div>;
}
