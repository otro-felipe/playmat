import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, ArrowUpRight, ChevronRight, ExternalLink } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { registerMessages, useI18n, useT, type Translate } from '../i18n';
import messages from '../i18n/en/events';
import { request, tournamentApi, tournamentPath } from '../tournaments/tournamentApi';
import { Button } from '../ui/Button';
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
  /** MTGTop8's page for a canonical archetype */
  source?: string | null;
  n: number;
  wins: number;
  draws: number;
  losses: number;
  games?: number;
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
type Statistics = {
  tournamentName: string | null;
  formats: string[];
  matches: number;
  rows: Row[];
  selected: (Row & { matchups: Row[] }) | null;
};
type SortKey = 'name' | 'n' | 'winrate' | 'games' | 'mulligan' | 'duration';
const sortKeys: SortKey[] = ['name', 'n', 'winrate', 'games', 'mulligan', 'duration'];
const colors: Color[] = ['W', 'U', 'B', 'R', 'G'];

const ratio = (part: number | undefined, whole: number | undefined) => (whole ? (part ?? 0) / whole : null);
const mulliganRate = (row: Row) => ratio(row.mulliganGames, row.mulliganKnown);
const averageGameMs = (row: Row) => ratio(row.durationMs, row.timedGames);

function PaletteSymbols({
  value,
  group,
  descriptionId,
}: {
  value: Row['colors'];
  group: Group;
  descriptionId: string;
}) {
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
    <span
      className={styles.colors}
      role="img"
      aria-label={label}
      aria-describedby={descriptionId}
      title={label}
    >
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
    const key = JSON.stringify([row.format, row.name]);
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
      labels.set(row.id, `${row.name || t('stats.anonymous')} · ${row.id.slice(-length)}`);
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

function sortValue(row: Row, key: SortKey, names: Map<string, string>): number | string | null {
  switch (key) {
    case 'name':
      return names.get(row.id) ?? '';
    case 'n':
      return row.n;
    case 'winrate':
      return ratio(row.wins, row.n);
    case 'games':
      return row.games ?? 0;
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
      const order =
        typeof a.value === 'string' ? a.value.localeCompare(String(b.value)) : a.value - (b.value as number);
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
  const locale = useI18n((s) => s.locale);
  const counts = new Intl.NumberFormat(locale);
  const rates = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
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
              label={<abbr title={t('stats.participations')}>N</abbr>}
              long={t('stats.participations')}
              {...header}
            />
            <th scope="col" className={styles.record}>
              <abbr title={t('stats.recordLong')}>{t('stats.record')}</abbr>
            </th>
            <SortHeader
              column="winrate"
              className={styles.numeric}
              label={t('stats.winRate')}
              long={t('stats.winRate')}
              {...header}
            />
            <SortHeader
              column="games"
              className={styles.numeric}
              label={t('stats.games')}
              long={t('stats.gamesLong')}
              {...header}
            />
            <SortHeader
              column="mulligan"
              className={styles.numeric}
              label={t('stats.mulligan')}
              long={t('stats.mulliganLong')}
              {...header}
            />
            <SortHeader
              column="duration"
              className={styles.numeric}
              label={t('stats.duration')}
              long={t('stats.durationLong')}
              {...header}
            />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const mulligan = mulliganRate(row);
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
                    <span>{row.format}</span>
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
                <td className={styles.rate}>{row.n ? rates.format(row.wins / row.n) : '—'}</td>
                <td className={styles.numeric}>{counts.format(row.games ?? 0)}</td>
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

/** Opening hands of one archetype or deck: how often it mulligans and how those games end. */
function MulliganSummary({ row }: { row: Row }) {
  const t = useT();
  const locale = useI18n((s) => s.locale);
  const rates = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  const decimals = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const rate = mulliganRate(row);
  const average = ratio(row.mulligans, row.mulliganKnown);
  const kept = ratio(row.keptWins, row.keptGames);
  const after = ratio(row.mulliganWins, row.mulliganGames);
  const games = (count: number | undefined) => t('stats.gameCount', { count: count ?? 0 });
  return (
    <section className={styles.hands} aria-label={t('stats.mulliganTitle')}>
      <h3>{t('stats.mulliganTitle')}</h3>
      {row.mulliganKnown ? (
        <>
          <dl>
            <div>
              <dt>{t('stats.mulliganRate')}</dt>
              <dd>{rate == null ? '—' : rates.format(rate)}</dd>
            </div>
            <div>
              <dt>{t('stats.mulliganAverage')}</dt>
              <dd>{average == null ? '—' : decimals.format(average)}</dd>
            </div>
            <div>
              <dt>{t('stats.keptSeven')}</dt>
              <dd>
                {kept == null ? '—' : rates.format(kept)} <small>{games(row.keptGames)}</small>
              </dd>
            </div>
            <div>
              <dt>{t('stats.afterMulligan')}</dt>
              <dd>
                {after == null ? '—' : rates.format(after)} <small>{games(row.mulliganGames)}</small>
              </dd>
            </div>
            <div>
              <dt>{t('stats.durationLong')}</dt>
              <dd>{formatDuration(averageGameMs(row))}</dd>
            </div>
          </dl>
          <p className={styles.note}>{t('stats.handSample', { count: row.mulliganKnown })}</p>
        </>
      ) : (
        <p className={styles.note}>{t('stats.noHands')}</p>
      )}
    </section>
  );
}

/**
 * Results grouped by archetype or deck, with their matchups. The global page and a
 * tournament's statistics tab share it; `path` and `scope` keep its links on that page.
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
  const locale = useI18n((s) => s.locale);
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
  const link = (g: Group, selected?: string) => path + '?' + params(g, format, selected);
  const sortHref = (key: SortKey, down: boolean) =>
    path + '?' + params(group, format, selection || undefined, [key, down]);
  const groupName = t(group === 'deck' ? 'stats.decks' : 'stats.archetypes');
  const names = displayNames(
    detail ? [...(data?.rows ?? []), detail, ...detail.matchups] : (data?.rows ?? []),
    group,
    t,
  );
  const title = detail ? names.get(detail.id) : t(tournamentId ? 'stats.tournamentTitle' : 'stats.globalTitle');
  const sample = detail ? detail.n : data?.matches;
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
  return (
    <>
      <header className={[styles.hero, headingLevel === 2 ? styles.compact : ''].join(' ')}>
        <div>
          {(detail || unavailable) && (
            <Link className={styles.parentLink} to={link(group)}>
              <ArrowLeft size={14} aria-hidden="true" />
              {t('stats.backGroups', { group: groupName })}
            </Link>
          )}
          <Title ref={heading} tabIndex={-1}>
            {title}
          </Title>
          {detail && (
            <div className={styles.meta}>
              <PaletteSymbols value={detail.colors} group={group} descriptionId={descriptionId} />
              <span>{detail.format}</span>
              <span>·</span>
              <span>{t('stats.results', { w: detail.wins, d: detail.draws, l: detail.losses })}</span>
              {detail.source && (
                <a className={styles.source} href={detail.source} target="_blank" rel="noopener noreferrer">
                  {t('stats.source')}
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              )}
            </div>
          )}
        </div>
        {sample != null && (
          <div className={styles.sample}>
            <strong>{new Intl.NumberFormat(locale).format(sample)}</strong>
            <span>{t(detail ? 'stats.participations' : 'stats.matches')}</span>
          </div>
        )}
      </header>
      <div className={styles.controls}>
        <nav className={styles.group} aria-label={t('stats.grouping')}>
          {(['archetype', 'deck'] as const).map((g) => (
            <Link key={g} to={link(g)} aria-current={g === group ? 'page' : undefined}>
              {t(g === 'deck' ? 'stats.decks' : 'stats.archetypes')}
            </Link>
          ))}
        </nav>
        <label className={styles.format}>
          <span>{t('stats.format')}</span>
          <select value={format} onChange={(e) => setSearch(params(group, e.target.value))}>
            <option value="">{t('stats.allFormats')}</option>
            {Array.from(new Set([...(data?.formats ?? []), ...(format ? [format] : [])])).map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
      </div>
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
      ) : (
        <section className={styles.results}>
          {detail && <MulliganSummary row={detail} />}
          <Section>{detail ? t('stats.matchups') : t('stats.resultsHeading')}</Section>
          {detail && <p className={styles.perspective}>{t('stats.perspective', { name: title ?? '' })}</p>}
          {(tableRows.length > 0 || detail) && <PaletteLegend group={group} descriptionId={descriptionId} />}
          {tableRows.length ? (
            <>
              <ResultTable
                rows={tableRows}
                names={names}
                heading={label}
                group={group}
                descriptionId={descriptionId}
                selectedId={detail?.id}
                destination={(selected) => link(group, selected)}
                sort={sort}
                descending={descending}
                sortHref={sortHref}
              />
              <p className={styles.note}>{t('stats.sampleNote')}</p>
              <p className={styles.note}>{t('stats.gamesNote')}</p>
            </>
          ) : (
            <p className={styles.state}>{t(detail ? 'stats.emptyOpponents' : 'stats.empty')}</p>
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
