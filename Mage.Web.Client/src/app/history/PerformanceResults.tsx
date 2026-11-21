import { displayArchetype } from '../decks/displayArchetype';
import { Percentage } from './Percentage';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { CardPreviewName } from '../ui/CardMarkdown';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useT, formatNumber } from '../i18n';
import { sample, type Outcome, type Performance } from './performance';
import styles from './DeckAnalysis.module.css';

function Headline({ label, outcome, primary }: { label: string; outcome: Outcome; primary?: boolean }) {
  const t = useT();
  return <section aria-label={label} className={styles.headline} data-primary={primary}>
    <h2>{label}</h2><strong><Percentage count={outcome.wins} total={outcome.total} /></strong>
    <span>{sample(outcome.wins, outcome.total)} · {t('perf.record', { wins: outcome.wins, losses: outcome.losses, draws: outcome.draws })}</span>
  </section>;
}

function SortHeader({ label, description, active, ascending, onSort }: {
  label: string; description?: string; active: boolean; ascending: boolean; onSort: () => void;
}) {
  const Icon = active ? (ascending ? ArrowUp : ArrowDown) : ArrowUpDown;
  return <th scope="col" aria-sort={active ? (ascending ? 'ascending' : 'descending') : 'none'}>
    <button type="button" className={styles.sort} title={description} onClick={onSort}>
      {label}<Icon size={12} aria-hidden="true" />
    </button>
  </th>;
}

function CardReplays({ card, ids }: { card: string; ids: string[] }) {
  const t = useT();
  return <span className={styles.replays}>
    {ids.map((id, index) => <Link key={id} to={'/replay/' + encodeURIComponent(id)}
      aria-label={t('perf.replayForCard', { card, number: index + 1 })}>
      {t('history.replay')} {index + 1}
    </Link>)}
  </span>;
}

function ResultsTable({ title, caption, dimension, rows, losses = false, sortable = false }: {
  title: string; caption?: string; dimension: string; losses?: boolean; sortable?: boolean; rows: { label: string; games: Outcome; gameIds?: string[] }[];
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
    return <SortHeader label={label} active={active} ascending={sort.ascending}
      description={key === 'sample' ? t('perf.sortSample') : undefined}
      onSort={() => setSort({ key, ascending: active && !sort.ascending })} />;
  }
  return <section className={styles.results}>
    <h2>{title}</h2>
    {caption && <p className={styles.hint}>{caption}</p>}
    {rows.length === 0 ? <p className={styles.empty}>{t('perf.noData')}</p> :
      <table aria-label={title}><thead><tr>
        <th scope="col">{dimension}</th>{column('sample', t(losses ? 'perf.gamesLost' : 'perf.gamesWon'))}
        {column('rate', t(losses ? 'perf.lossRate' : 'history.winRate'))}
      </tr></thead><tbody>
        {ordered.map(({ label, games, gameIds }) => {
          const count = numerator(games);
          return <tr key={label}><th scope="row">
            {gameIds ? <CardPreviewName card={{ name: label }} /> : label}{!!gameIds?.length && <CardReplays card={label} ids={gameIds} />}
          </th><td>{sample(count, games.total)}</td><td><Percentage count={count} total={games.total} /></td></tr>;
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

function OpeningHands({ data }: { data: Performance }) {
  const t = useT();
  const [sort, setSort] = useState<{ key: 'games' | 'without'; ascending: boolean } | null>(null);
  const title = t('perf.openingCards');
  const cards = data.openingCards.slice();
  if (sort) cards.sort((a, b) => {
    const left = a[sort.key];
    const right = b[sort.key];
    if (!left.total || !right.total) return right.total - left.total;
    const difference = left.wins / left.total - right.wins / right.total;
    return (sort.ascending ? difference : -difference) || right.total - left.total || a.card.localeCompare(b.card);
  });
  return <section className={styles.results}>
    <h2>{title}</h2><p className={styles.hint}>{t('perf.keptCoverage', { known: data.coverage.keptHands, total: data.coverage.games })}</p>
    {!cards.length ? <p className={styles.empty}>{t('perf.noData')}</p> :
      <table aria-label={title}><thead><tr><th scope="col">{t('perf.card')}</th>
        {(['games', 'without'] as const).map((key) => <SortHeader key={key} label={t(key === 'games' ? 'perf.withCard' : 'perf.withoutCard')}
          active={sort?.key === key} ascending={!!sort?.ascending}
          onSort={() => setSort({ key, ascending: sort?.key === key && !sort.ascending })} />)}
      </tr></thead><tbody>{cards.map(({ card, games, without }) => <tr key={card}>
        <th scope="row"><CardPreviewName card={{ name: card }} /></th><td><Fraction outcome={games} /></td><td><Fraction outcome={without} /></td>
      </tr>)}</tbody></table>}
  </section>;
}

export function MulliganResults({ data }: { data: Performance }) {
  const t = useT();
  return <div className={styles.sections}>
    <OpeningHands data={data} />
    <ResultsTable title={t('perf.byMulligans')} dimension={t('perf.mulligan')}
      rows={data.mulligans.map(({ count, games }) => ({ label: formatNumber(count), games }))} />
  </div>;
}

function Fraction({ outcome }: { outcome: Outcome }) {
  return <><Percentage count={outcome.wins} total={outcome.total} /> <small>({sample(outcome.wins, outcome.total)})</small></>;
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
          <th scope="row">{displayArchetype(t, item.archetype)}</th><td><Fraction outcome={item.matches} /></td>
          {!bo1 && <td><Fraction outcome={item.games} /></td>}
        </tr>)}</tbody></table>}
    </section>
    <section className={styles.results}>
      <h2>{t('perf.rivalMulligans')}</h2>
      {!data.matchups.length ? <p className={styles.empty}>{t('perf.noData')}</p> :
        <table aria-label={t('perf.rivalMulligans')}><thead><tr><th scope="col">{t('perf.opponent')}</th>
          <th scope="col">{t('perf.yours')}</th><th scope="col">{t('perf.theirs')}</th></tr></thead>
          <tbody>{data.matchups.map(({ archetype, mulligans }) => <tr key={JSON.stringify(archetype)}>
            <th scope="row">{displayArchetype(t, archetype)}</th>
            <td>{mulligans.known ? sample(mulligans.taken, mulligans.known) : '—'}</td>
            <td>{mulligans.opponentKnown ? sample(mulligans.opponentTaken, mulligans.opponentKnown) : '—'}</td>
          </tr>)}</tbody></table>}
    </section>
    <ResultsTable sortable losses title={t('perf.opponentCards')} dimension={t('perf.card')}
      caption={t('perf.cardCoverage', { known: data.coverage.opponentCards, total: data.coverage.games })}
      rows={data.opponentCards.map(({ card, games, gameIds }) => ({ label: card, games, gameIds }))} />
  </div>;
}
