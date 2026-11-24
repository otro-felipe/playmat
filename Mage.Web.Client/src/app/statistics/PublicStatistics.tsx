import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, ArrowUpRight, ChevronRight, ExternalLink } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { registerMessages, useI18n, useT, type Translate } from '../i18n';
import messages from '../i18n/en/events';
import { request, tournamentApi, tournamentPath } from '../tournaments/tournamentApi';
import { Button } from '../ui/Button';
import { CardPreviewName } from '../ui/CardMarkdown';
import { Percentage } from '../history/Percentage';
import styles from './PublicStatistics.module.css';

registerMessages(messages);

type Group = 'archetype' | 'deck';
type Color = 'W' | 'U' | 'B' | 'R' | 'G';
export type StatisticsRow = {
  id: string;
  name: string | null;
  format: string;
  colors: Color[] | null;
  unidentified?: boolean;
  /** a deck's archetype, which names an otherwise unnamed list */
  archetype?: string | null;
  /** MTGTop8's page for a canonical archetype */
  source?: string | null;
  n: number;
  wins: number;
  draws: number;
  losses: number;
  games?: number;
  gameWins?: number;
  mulliganKnown?: number;
  mulligans?: number;
  keptGames?: number;
  keptWins?: number;
  mulliganGames?: number;
  mulliganWins?: number;
  timedGames?: number;
  durationMs?: number;
};
type Row = StatisticsRow;
type DeckList = { kind: 'deck'; main: { name: string; amount: number }[]; sideboard: { name: string; amount: number }[] };
type CommonCards = {
  kind: 'archetype';
  lists: number;
  main: { name: string; lists: number; copies: number }[];
  sideboard: { name: string; lists: number; copies: number }[];
};
type Hands = {
  /** games with a recorded kept hand, and how many of them were won */
  games: number;
  wins: number;
  mulligans?: { count: number; games: number; wins: number }[];
  cards: { name: string; games: number; wins: number }[];
};
type Statistics = {
  tournamentName: string | null;
  formats: string[];
  /** the format the figures belong to; the server picks the busiest one when none is requested */
  format?: string | null;
  matches: number;
  games?: number;
  /** participations of unclassified archetypes or unidentified lists, left out of the ranking */
  unclassified?: number;
  rows: Row[];
  selected: (Row & { matchups: Row[]; list?: DeckList | CommonCards | null; hands?: Hands }) | null;
};
type SortKey = 'name' | 'n' | 'winrate' | 'gamerate' | 'mulligan' | 'duration';
const sortKeys: SortKey[] = ['name', 'n', 'winrate', 'gamerate', 'mulligan', 'duration'];
const colors: Color[] = ['W', 'U', 'B', 'R', 'G'];

const ratio = (part: number | undefined, whole: number | undefined) => (whole ? (part ?? 0) / whole : null);
const mulliganRate = (row: Row) => ratio(row.mulliganGames, row.mulliganKnown);
const averageGameMs = (row: Row) => ratio(row.durationMs, row.timedGames);
const gameRate = (row: Row) => (row.gameWins == null ? null : ratio(row.gameWins, row.games));

/** Wilson score interval at 95 %: how far a win rate could move with more data. */
function wilson(wins: number, n: number): [number, number] | null {
  if (!n) return null;
  const z = 1.959964;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

/** The strongest row is the one whose win rate is highest even at the low end of its interval. */
function strongest(rows: Row[]): Row | null {
  let best: Row | null = null;
  let bound = -1;
  for (const row of rows) {
    const low = wilson(row.wins, row.n)?.[0] ?? -1;
    if (low > bound || (low === bound && best && row.n > best.n)) {
      best = row;
      bound = low;
    }
  }
  return best;
}

function PaletteSymbols({ value, group, descriptionId }: { value: Row['colors']; group: Group; descriptionId: string }) {
  const t = useT();
  const ordered = colors.filter((c) => value?.includes(c));
  const symbols = !value ? [] : ordered.length ? ordered : ['C'];
  const names = !value
    ? t('stats.unknownColors')
    : ordered.length
      ? ordered.map((c) => t(`stats.color.${c}`)).join(', ')
      : t('stats.colorless');
  const label = t(group === 'deck' ? 'stats.paletteDeck' : 'stats.paletteArchetype', { colors: names });
  return (
    <span className={styles.colors} role="img" aria-label={label} aria-describedby={descriptionId} title={label}>
      {symbols.length ? (
        symbols.map((c) => <i key={c} aria-hidden="true" className={`ms ms-cost ms-${c.toLowerCase()}`} />)
      ) : (
        <span aria-hidden="true" className={styles.unknown}>
          ?
        </span>
      )}
    </span>
  );
}

function PaletteLegend({ group, descriptionId }: { group: Group; descriptionId: string }) {
  const t = useT();
  return (
    <details className={styles.paletteLegend}>
      <summary>{t(group === 'deck' ? 'stats.legendDeck' : 'stats.legendArchetype')}</summary>
      <div id={descriptionId}>
        <p>{t('stats.legendSources')}</p>
        <p>{t(group === 'deck' ? 'stats.legendDeckAgreement' : 'stats.legendArchetypeAgreement')}</p>
      </div>
    </details>
  );
}

function displayNames(rows: Row[], group: Group, t: Translate): Map<string, string> {
  const labels = new Map<string, string>();
  const decks = new Map<string, Row[]>();
  for (const row of new Map(rows.map((row) => [row.id, row])).values()) {
    if (group === 'archetype') {
      labels.set(row.id, row.name || t('stats.unclassified'));
      continue;
    }
    if (row.unidentified) {
      labels.set(row.id, t('stats.unidentified'));
      continue;
    }
    const key = JSON.stringify([row.format, row.name ?? row.archetype ?? null, !row.name]);
    const siblings = decks.get(key);
    if (siblings) siblings.push(row);
    else decks.set(key, [row]);
  }
  for (const siblings of decks.values()) {
    const first = siblings[0];
    if (first.name && siblings.length === 1) {
      labels.set(first.id, first.name);
      continue;
    }
    let length = 6;
    while (new Set(siblings.map((row) => row.id.slice(-length))).size < siblings.length) length++;
    for (const row of siblings)
      labels.set(row.id, `${row.name || row.archetype || t('stats.anonymous')} · ${row.id.slice(-length)}`);
  }
  return labels;
}

function SplitBar({ row }: { row: Row }) {
  return (
    <span aria-hidden="true" className={styles.bar}>
      <i style={{ flexGrow: row.wins }} />
      <i style={{ flexGrow: row.draws }} />
      <i style={{ flexGrow: row.losses }} />
    </span>
  );
}

/** Game length for a table cell: minutes, or hours and minutes. */
function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

function useFormats() {
  const locale = useI18n((s) => s.locale);
  return {
    counts: new Intl.NumberFormat(locale),
    rates: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }),
    whole: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }),
    decimals: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }),
    points: new Intl.NumberFormat(locale, { maximumFractionDigits: 1, signDisplay: 'exceptZero' }),
  };
}

function sortValue(row: Row, key: SortKey, names: Map<string, string>): number | string | null {
  switch (key) {
    case 'name':
      return names.get(row.id) ?? '';
    case 'n':
      return row.n;
    case 'winrate':
      return ratio(row.wins, row.n);
    case 'gamerate':
      return gameRate(row);
    case 'mulligan':
      return mulliganRate(row);
    case 'duration':
      return averageGameMs(row);
  }
}

/** Unknown values sort last in either direction; ties keep the server's order. */
function sortRows(rows: Row[], key: SortKey, descending: boolean, names: Map<string, string>): Row[] {
  return rows
    .map((row, index) => ({ row, index, value: sortValue(row, key, names) }))
    .sort((a, b) => {
      if (a.value == null || b.value == null) return a.value == null ? (b.value == null ? a.index - b.index : 1) : -1;
      const order = typeof a.value === 'string' ? a.value.localeCompare(String(b.value)) : a.value - (b.value as number);
      return (descending ? -order : order) || a.index - b.index;
    })
    .map(({ row }) => row);
}

function SortHeader({
  column,
  label,
  long,
  sort,
  descending,
  href,
  className,
}: {
  column: SortKey;
  label: ReactNode;
  long: string;
  sort: SortKey;
  descending: boolean;
  href: (column: SortKey, descending: boolean) => string;
  className?: string;
}) {
  const t = useT();
  const active = sort === column;
  // A fresh numeric column starts from the highest value; names start from A.
  const next = active ? !descending : column !== 'name';
  return (
    <th scope="col" className={className} aria-sort={active ? (descending ? 'descending' : 'ascending') : undefined}>
      <Link
        className={styles.sort}
        to={href(column, next)}
        replace
        preventScrollReset
        title={long}
        aria-label={t('stats.sortBy', { column: long })}
      >
        {label}
        {active && (descending ? <ArrowDown size={13} aria-hidden="true" /> : <ArrowUp size={13} aria-hidden="true" />)}
      </Link>
    </th>
  );
}

function WinRate({ row }: { row: Row }) {
  const t = useT();
  const { whole } = useFormats();
  const interval = wilson(row.wins, row.n);
  if (!interval) return <>—</>;
  const range = `${whole.format(interval[0])}–${whole.format(interval[1])}`;
  return (
    <>
      <Percentage count={row.wins} total={row.n} />
      <small className={styles.interval} title={t('stats.intervalLong')}>
        {range}
      </small>
    </>
  );
}

function ResultTable({
  rows,
  names,
  heading,
  destination,
  selectedId,
  group,
  descriptionId,
  sort,
  descending,
  sortHref,
}: {
  rows: Row[];
  names: Map<string, string>;
  heading: string;
  destination: (id: string) => string;
  selectedId?: string;
  group: Group;
  descriptionId: string;
  sort: SortKey;
  descending: boolean;
  sortHref: (column: SortKey, descending: boolean) => string;
}) {
  const t = useT();
  const { counts, rates } = useFormats();
  const header = { sort, descending, href: sortHref };
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table} aria-label={heading}>
        <thead>
          <tr>
            <SortHeader column="name" label={heading} long={heading} {...header} />
            <SortHeader
              column="n"
              className={styles.numeric}
              label={<abbr title={t('stats.matchesLong')}>{t('stats.matchesShort')}</abbr>}
              long={t('stats.matchesLong')}
              {...header}
            />
            <th scope="col" className={styles.record}>
              <abbr title={t('stats.recordLong')}>{t('stats.record')}</abbr>
            </th>
            <SortHeader column="winrate" className={styles.numeric} label={t('stats.winRate')} long={t('stats.winRateLong')} {...header} />
            <SortHeader column="gamerate" className={styles.numeric} label={t('stats.gameRate')} long={t('stats.gameRateLong')} {...header} />
            <SortHeader column="mulligan" className={styles.numeric} label={t('stats.mulligan')} long={t('stats.mulliganLong')} {...header} />
            <SortHeader column="duration" className={styles.numeric} label={t('stats.duration')} long={t('stats.durationLong')} {...header} />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const mulligan = mulliganRate(row);
            const games = gameRate(row);
            return (
              <tr key={row.id}>
                <th scope="row">
                  {row.id === selectedId ? (
                    <span className={styles.mirror}>{t('stats.mirror')}</span>
                  ) : (
                    <Link id={'stats-row-' + row.id} className={styles.rowLink} to={destination(row.id)}>
                      <span>{names.get(row.id)}</span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </Link>
                  )}
                  <div className={styles.meta}>
                    <PaletteSymbols value={row.colors} group={group} descriptionId={descriptionId} />
                  </div>
                </th>
                <td className={styles.numeric}>{counts.format(row.n)}</td>
                <td className={styles.record}>
                  <span
                    className={styles.recordText}
                    role="img"
                    aria-label={t('stats.results', { w: row.wins, d: row.draws, l: row.losses })}
                  >
                    <b>{counts.format(row.wins)}</b>
                    <span> / </span>
                    <b>{counts.format(row.draws)}</b>
                    <span> / </span>
                    <b>{counts.format(row.losses)}</b>
                  </span>
                  <SplitBar row={row} />
                </td>
                <td className={styles.rate}>
                  <WinRate row={row} />
                </td>
                <td className={styles.numeric} title={row.games ? t('stats.gameCount', { count: row.games }) : undefined}>
                  {games == null ? '—' : <Percentage count={row.gameWins ?? 0} total={row.games ?? 0} />}
                </td>
                <td
                  className={styles.numeric}
                  title={row.mulliganKnown ? t('stats.handSample', { count: row.mulliganKnown }) : undefined}
                >
                  {mulligan == null ? '—' : rates.format(mulligan)}
                </td>
                <td className={styles.numeric}>{formatDuration(averageGameMs(row))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Answers on top of the ranking: which row is strongest, which is most played, and how much data there is. */
function Highlights({
  data,
  names,
  group,
  destination,
  descriptionId,
}: {
  data: Statistics;
  names: Map<string, string>;
  group: Group;
  destination: (id: string) => string;
  descriptionId: string;
}) {
  const t = useT();
  const { counts, whole } = useFormats();
  const rows = data.rows ?? [];
  const best = strongest(rows);
  const popular = rows.reduce<Row | null>((top, row) => (!top || row.n > top.n ? row : top), null);
  if (!best || !popular) return null;
  const interval = wilson(best.wins, best.n)!;
  const seats = 2 * data.matches;
  return (
    <section className={styles.highlights} aria-label={t('stats.highlights')}>
      <article className={styles.highlight}>
        <h3>{t(group === 'deck' ? 'stats.strongestDeck' : 'stats.strongestArchetype')}</h3>
        <div className={styles.highlightName}>
          <Link to={destination(best.id)}>{names.get(best.id)}</Link>
          <PaletteSymbols value={best.colors} group={group} descriptionId={descriptionId} />
        </div>
        <p className={styles.highlightValue}>
          <strong>
            <Percentage count={best.wins} total={best.n} />
          </strong>{' '}
          {t('stats.matchWins')}
        </p>
        <p className={styles.highlightNote}>
          {t('stats.strongestBasis', {
            low: whole.format(interval[0]),
            high: whole.format(interval[1]),
            n: counts.format(best.n),
          })}
        </p>
      </article>
      <article className={styles.highlight}>
        <h3>{t(group === 'deck' ? 'stats.popularDeck' : 'stats.popularArchetype')}</h3>
        <div className={styles.highlightName}>
          <Link to={destination(popular.id)}>{names.get(popular.id)}</Link>
          <PaletteSymbols value={popular.colors} group={group} descriptionId={descriptionId} />
        </div>
        <p className={styles.highlightValue}>
          <strong>{seats ? whole.format(popular.n / seats) : '—'}</strong> {t('stats.metaShare')}
        </p>
        <p className={styles.highlightNote}>{t('stats.popularBasis', { n: counts.format(popular.n) })}</p>
      </article>
      <article className={styles.highlight}>
        <h3>{t('stats.dataTitle')}</h3>
        <p className={styles.highlightValue}>
          <strong>{counts.format(data.matches)}</strong> {t('stats.matchesUnit', { count: data.matches })}
        </p>
        <p className={styles.highlightNote}>
          {t('stats.dataBasis', {
            games: counts.format(data.games ?? 0),
            rows: counts.format(rows.length),
            group: t(group === 'deck' ? 'stats.decks' : 'stats.archetypes').toLowerCase(),
          })}
        </p>
        {!!data.unclassified && <p className={styles.highlightNote}>{t('stats.hiddenRows', { count: data.unclassified })}</p>}
      </article>
    </section>
  );
}

/** Headline figures of one archetype or deck. */
function Summary({ row }: { row: Row }) {
  const t = useT();
  const { counts, whole } = useFormats();
  const interval = wilson(row.wins, row.n);
  const gameCount = (count: number | undefined) => t('stats.gameCount', { count: count ?? 0 });
  return (
    <dl className={styles.kpis} aria-label={t('stats.summary')}>
      <div>
        <dt>{t('stats.winRateLong')}</dt>
        <dd>
          <Percentage count={row.wins} total={row.n} />
          {interval && (
            <small>{t('stats.interval', { range: `${whole.format(interval[0])}–${whole.format(interval[1])}` })}</small>
          )}
        </dd>
      </div>
      <div>
        <dt>{t('stats.matchesLong')}</dt>
        <dd>
          {counts.format(row.n)}
          <small>{t('stats.results', { w: row.wins, d: row.draws, l: row.losses })}</small>
        </dd>
      </div>
      <div>
        <dt>{t('stats.gameRateLong')}</dt>
        <dd>
          {gameRate(row) == null ? '—' : <Percentage count={row.gameWins ?? 0} total={row.games ?? 0} />}
          <small>{gameCount(row.games)}</small>
        </dd>
      </div>
      <div>
        <dt>{t('stats.durationLong')}</dt>
        <dd>{formatDuration(averageGameMs(row))}</dd>
      </div>
    </dl>
  );
}

function Fraction({ count, total }: { count: number; total: number }) {
  const { counts } = useFormats();
  return (
    <>
      <Percentage count={count} total={total} />{' '}
      <small>
        ({counts.format(count)}/{counts.format(total)})
      </small>
    </>
  );
}

/**
 * Mulligans and kept opening hands, in the same shape as a player's own deck analysis:
 * results by number of mulligans, and each card's win rate with and without it in the kept hand.
 */
function MulliganSection({ row, hands, Section }: { row: Row; hands: Hands | undefined; Section: 'h2' | 'h3' }) {
  const t = useT();
  const { counts, rates, decimals, points } = useFormats();
  const rate = mulliganRate(row);
  const average = ratio(row.mulligans, row.mulliganKnown);
  const baseline = hands?.games ? hands.wins / hands.games : null;
  // Very small samples swing wildly. Prefer cards seen in at least three hands when there are any.
  const minimum = hands?.cards.some((card) => card.games >= 3) ? 3 : 1;
  const cards = (hands?.cards ?? [])
    .filter((card) => card.games >= minimum)
    .sort((a, b) => b.wins / b.games - a.wins / a.games || b.games - a.games || a.name.localeCompare(b.name));
  const buckets = hands?.mulligans ?? [];
  const cardsTitle = t('stats.cardsTitle');
  const mulligansTitle = t('stats.byMulligans');
  return (
    <section id="stats-cards" className={styles.section} aria-labelledby="stats-cards-heading">
      <Section id="stats-cards-heading">{t('stats.mulliganTitle')}</Section>
      {row.mulliganKnown ? (
        <p className={styles.perspective}>
          {t('stats.mulliganLine', {
            rate: rate == null ? '—' : rates.format(rate),
            average: average == null ? '—' : decimals.format(average),
            count: counts.format(row.mulliganKnown),
          })}
        </p>
      ) : (
        <p className={styles.state}>{t('stats.noHands')}</p>
      )}
      <div className={styles.panels}>
        <section className={styles.panel} aria-label={mulligansTitle}>
          <h4>{mulligansTitle}</h4>
          {buckets.length ? (
            <table className={[styles.table, styles.cardTable].join(' ')} aria-label={mulligansTitle}>
              <thead>
                <tr>
                  <th scope="col">{t('stats.mulligan')}</th>
                  <th scope="col" className={styles.numeric}>
                    {t('stats.gamesWon')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {buckets.map((bucket) => (
                  <tr key={bucket.count}>
                    <th scope="row">
                      {bucket.count === 0
                        ? t('stats.keptSevenShort')
                        : t('stats.mulliganCount', { count: bucket.count, plus: bucket.count >= 3 ? '+' : '' })}
                    </th>
                    <td className={styles.numeric}>
                      <Fraction count={bucket.wins} total={bucket.games} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className={styles.note}>{t('stats.noHands')}</p>
          )}
        </section>
        <section className={styles.panel} aria-label={cardsTitle}>
          <h4>{cardsTitle}</h4>
          {!hands?.games || baseline == null ? (
            <p className={styles.note}>{t('stats.noCardHands')}</p>
          ) : (
            <>
              <p className={styles.note}>
                {t('stats.cardsBaseline', { rate: rates.format(baseline), count: counts.format(hands.games) })}
              </p>
              <div className={styles.tableScroll}>
                <table className={[styles.table, styles.cardTable].join(' ')} aria-label={cardsTitle}>
                  <thead>
                    <tr>
                      <th scope="col">{t('stats.card')}</th>
                      <th scope="col" className={styles.numeric}>
                        {t('stats.withCard')}
                      </th>
                      <th scope="col" className={styles.numeric}>
                        {t('stats.withoutCard')}
                      </th>
                      <th scope="col" className={styles.numeric}>
                        <abbr title={t('stats.deltaLong')}>{t('stats.delta')}</abbr>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {cards.map((card) => {
                      const otherGames = hands.games - card.games;
                      const otherWins = hands.wins - card.wins;
                      const delta = (card.wins / card.games - baseline) * 100;
                      return (
                        <tr key={card.name}>
                          <th scope="row">
                            <CardPreviewName card={{ name: card.name }} />
                          </th>
                          <td className={styles.numeric}>
                            <Fraction count={card.wins} total={card.games} />
                          </td>
                          <td className={styles.numeric}>
                            <Fraction count={otherWins} total={otherGames} />
                          </td>
                          <td className={[styles.numeric, delta > 0 ? styles.up : delta < 0 ? styles.down : ''].join(' ')}>
                            {points.format(delta)} pp
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className={styles.note}>{t('stats.cardsNote', { minimum })}</p>
            </>
          )}
        </section>
      </div>
    </section>
  );
}

/** The exact list of a deck, or the cards most lists of an archetype share. */
function ListSection({
  list,
  group,
  Section,
}: {
  list: DeckList | CommonCards | null | undefined;
  group: Group;
  Section: 'h2' | 'h3';
}) {
  const t = useT();
  const { counts, whole, decimals } = useFormats();
  const zones = (main: unknown[], sideboard: unknown[]) =>
    (
      [
        ['main', main],
        ['sideboard', sideboard],
      ] as const
    ).filter(([, cards]) => cards.length);
  const zoneName = (zone: 'main' | 'sideboard') => t(zone === 'main' ? 'stats.mainDeck' : 'stats.sideboard');
  return (
    <section id="stats-list" className={styles.section} aria-labelledby="stats-list-heading">
      <Section id="stats-list-heading">{t(group === 'deck' ? 'stats.listTitle' : 'stats.commonTitle')}</Section>
      {!list ? (
        <p className={styles.state}>{t('stats.noList')}</p>
      ) : list.kind === 'deck' ? (
        <div className={styles.deckList}>
          {zones(list.main, list.sideboard).map(([zone]) => {
            const cards = zone === 'main' ? list.main : list.sideboard;
            return (
              <div key={zone} role="group" aria-label={zoneName(zone)}>
                <h4>
                  {zoneName(zone)} <span>{counts.format(cards.reduce((sum, card) => sum + card.amount, 0))}</span>
                </h4>
                <ul>
                  {cards.map((card) => (
                    <li key={card.name}>
                      <b>{card.amount}</b> <CardPreviewName card={{ name: card.name }} />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <p className={styles.perspective}>{t('stats.commonIntro', { count: list.lists })}</p>
          <div className={styles.deckList}>
            {zones(list.main, list.sideboard).map(([zone]) => {
              const cards = zone === 'main' ? list.main : list.sideboard;
              return (
                <div key={zone}>
                  <h4>{zoneName(zone)}</h4>
                  <table className={[styles.table, styles.cardTable].join(' ')} aria-label={zoneName(zone)}>
                    <thead>
                      <tr>
                        <th scope="col">{t('stats.card')}</th>
                        <th scope="col" className={styles.numeric}>
                          {t('stats.inLists')}
                        </th>
                        <th scope="col" className={styles.numeric}>
                          {t('stats.copies')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {cards.map((card) => (
                        <tr key={card.name}>
                          <th scope="row">
                            <CardPreviewName card={{ name: card.name }} />
                          </th>
                          <td className={styles.numeric}>
                            {whole.format(card.lists / list.lists)} <small>{`${card.lists}/${list.lists}`}</small>
                          </td>
                          <td className={styles.numeric}>{decimals.format(card.copies)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Results grouped by archetype or deck, with their matchups, opening-hand cards and lists.
 * The global page and a tournament's statistics tab share it; `path` and `scope` keep its links on that page.
 */
export function StatisticsPanel({
  tournamentId,
  path,
  scope,
  headingLevel = 1,
}: {
  tournamentId?: string;
  path: string;
  /** query parameters that keep the panel's page, e.g. the tournament tab */
  scope?: Record<string, string>;
  headingLevel?: 1 | 2;
}) {
  const descriptionId = useId();
  const location = useLocation();
  const heading = useRef<HTMLHeadingElement>(null);
  const lastView = useRef<{ key: string; scope: string; selection: string; origin: string } | null>(null);
  const t = useT();
  const { counts } = useFormats();
  const [search, setSearch] = useSearchParams();
  const group: Group = search.get('group') === 'deck' ? 'deck' : 'archetype';
  const format = search.get('format') || '';
  const selection = search.get('selected') || '';
  const requested = search.get('sort') as SortKey;
  const sort: SortKey = sortKeys.includes(requested) ? requested : 'n';
  const descending = search.get('dir') !== 'asc';
  const endpoint = tournamentId
    ? tournamentApi + '/' + encodeURIComponent(tournamentId) + '/statistics'
    : '/api/playtesting/statistics';
  function params(nextGroup: Group, nextFormat: string, selected?: string, order: [SortKey, boolean] = [sort, descending]) {
    const query = new URLSearchParams({ ...scope, group: nextGroup });
    if (nextFormat) query.set('format', nextFormat);
    if (selected) query.set('selected', selected);
    if (order[0] !== 'n' || !order[1]) {
      query.set('sort', order[0]);
      query.set('dir', order[1] ? 'desc' : 'asc');
    }
    return query;
  }
  const api = new URLSearchParams({ group });
  if (format) api.set('format', format);
  if (selection) api.set('selected', selection);
  const query = api.toString();
  const stats = useQuery({
    queryKey: [endpoint, query],
    queryFn: ({ signal }) => request<Statistics>(endpoint + '?' + query, undefined, signal),
  });
  const data = stats.data;
  const detail = data?.selected;
  const shownFormat = format || data?.format || '';
  const link = (g: Group, selected?: string) => path + '?' + params(g, format, selected);
  const sortHref = (key: SortKey, down: boolean) => path + '?' + params(group, format, selection || undefined, [key, down]);
  const groupName = t(group === 'deck' ? 'stats.decks' : 'stats.archetypes');
  const names = displayNames(detail ? [...(data?.rows ?? []), detail, ...detail.matchups] : (data?.rows ?? []), group, t);
  const title = detail ? names.get(detail.id) : t(tournamentId ? 'stats.tournamentTitle' : 'stats.globalTitle');
  const tableRows = sortRows(detail ? detail.matchups : (data?.rows ?? []), sort, descending, names);
  const label = detail ? t('stats.opponent') : t(group === 'deck' ? 'stats.deck' : 'stats.archetype');
  const unavailable = !!selection && !!data && !detail;
  const viewScope = endpoint + '?' + new URLSearchParams({ group, ...(format ? { format } : {}) });
  useEffect(() => {
    // The target may arrive asynchronously. Focus once per navigation, never on a background refetch.
    const previous = lastView.current;
    if (!data || previous?.key === location.key) return;
    const returning = previous?.scope === viewScope && !!previous.selection;
    const origin = returning ? previous.origin : selection;
    if (selection) heading.current?.focus();
    else if (returning) document.getElementById('stats-row-' + origin)?.focus();
    lastView.current = { key: location.key, scope: viewScope, selection, origin };
  }, [data, location.key, viewScope, selection]);
  const Title = headingLevel === 1 ? 'h1' : 'h2';
  const Section = headingLevel === 1 ? 'h2' : 'h3';
  const formats = Array.from(new Set([...(data?.formats ?? []), ...(shownFormat ? [shownFormat] : [])]));
  return (
    <>
      <div className={styles.topBar}>
        <nav className={styles.tabs} aria-label={t('stats.grouping')}>
          {(['archetype', 'deck'] as const).map((g) => (
            <Link key={g} to={link(g)} aria-current={g === group ? 'page' : undefined}>
              {t(g === 'deck' ? 'stats.decks' : 'stats.archetypes')}
            </Link>
          ))}
        </nav>
        <label className={styles.format}>
          <span>{t('stats.format')}</span>
          <select value={shownFormat} onChange={(e) => setSearch(params(group, e.target.value))}>
            {(tournamentId || !formats.length) && <option value="">{t('stats.allFormats')}</option>}
            {formats.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
      </div>
      <header className={[styles.hero, headingLevel === 2 ? styles.compact : ''].join(' ')}>
        {(detail || unavailable) && (
          <Link className={styles.parentLink} to={link(group)}>
            <ArrowLeft size={14} aria-hidden="true" />
            {t('stats.backGroups', { group: groupName })}
          </Link>
        )}
        <Title ref={heading} tabIndex={-1}>
          {title}
        </Title>
        {detail ? (
          <div className={styles.meta}>
            <PaletteSymbols value={detail.colors} group={group} descriptionId={descriptionId} />
            <span>{detail.format}</span>
            {detail.source && (
              <a className={styles.source} href={detail.source} target="_blank" rel="noopener noreferrer">
                {t('stats.source')}
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            )}
          </div>
        ) : (
          data &&
          !unavailable && (
            <p className={styles.subtitle}>
              {t('stats.subtitle', {
                format: shownFormat || t('stats.allFormats'),
                matches: counts.format(data.matches),
                games: counts.format(data.games ?? 0),
              })}
            </p>
          )
        )}
      </header>
      {stats.isPending ? (
        <p role="status" className={styles.state}>
          {t('cup.loading')}
        </p>
      ) : stats.isError ? (
        <div role="alert" className={styles.state}>
          <p>{t('stats.loadError')}</p>
          <Button onClick={() => void stats.refetch()}>{t('cup.retry')}</Button>
        </div>
      ) : unavailable ? (
        <p className={styles.state}>{t('stats.unavailable')}</p>
      ) : detail ? (
        <>
          <Summary row={detail} />
          <nav className={styles.sectionNav} aria-label={t('stats.sections')}>
            <a href="#stats-matchups">{t('stats.matchups')}</a>
            <a href="#stats-cards">{t('stats.mulliganTitle')}</a>
            <a href="#stats-list">{t(group === 'deck' ? 'stats.listTitle' : 'stats.commonTitle')}</a>
          </nav>
          <section id="stats-matchups" className={styles.section} aria-labelledby="stats-matchups-heading">
            <Section id="stats-matchups-heading">{t('stats.matchups')}</Section>
            <p className={styles.perspective}>{t('stats.perspective', { name: title ?? '' })}</p>
            {tableRows.length ? (
              <>
                <ResultTable
                  rows={tableRows}
                  names={names}
                  heading={label}
                  group={group}
                  descriptionId={descriptionId}
                  selectedId={detail.id}
                  destination={(selected) => link(group, selected)}
                  sort={sort}
                  descending={descending}
                  sortHref={sortHref}
                />
                <PaletteLegend group={group} descriptionId={descriptionId} />
              </>
            ) : (
              <p className={styles.state}>{t('stats.emptyOpponents')}</p>
            )}
          </section>
          <MulliganSection row={detail} hands={detail.hands} Section={Section} />
          <ListSection list={detail.list} group={group} Section={Section} />
        </>
      ) : (
        <section className={styles.results}>
          {data && (
            <Highlights
              data={data}
              names={names}
              group={group}
              destination={(selected) => link(group, selected)}
              descriptionId={descriptionId}
            />
          )}
          <Section>{t('stats.ranking')}</Section>
          {tableRows.length ? (
            <>
              <ResultTable
                rows={tableRows}
                names={names}
                heading={label}
                group={group}
                descriptionId={descriptionId}
                destination={(selected) => link(group, selected)}
                sort={sort}
                descending={descending}
                sortHref={sortHref}
              />
              <PaletteLegend group={group} descriptionId={descriptionId} />
              <p className={styles.note}>{t('stats.sampleNote')}</p>
            </>
          ) : (
            <p className={styles.state}>{t('stats.empty')}</p>
          )}
        </section>
      )}
    </>
  );
}

export function PublicStatistics() {
  const { id } = useParams();
  const t = useT();
  const [search] = useSearchParams();
  // A tournament's statistics are a tab of its own page; keep old links and their filters working.
  if (id) {
    const query = new URLSearchParams(search);
    query.set('tab', 'stats');
    return <Navigate replace to={tournamentPath(id) + '?' + query} />;
  }
  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <nav className={styles.nav} aria-label={t('stats.navigation')}>
          <Link to="/">
            <ArrowLeft size={17} aria-hidden="true" />
            {t('cup.home')}
          </Link>
          <Link to="/tournaments">
            {t('cup.all')}
            <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
        </nav>
        <StatisticsPanel path="/statistics" />
      </div>
    </main>
  );
}
